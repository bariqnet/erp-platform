// createTestSession — direct DB insert + signed cookie builder.
//
// Used by every integration test that needs a signed-in caller.
// Shortcut around Better Auth's HTTP signup/signin — tests pay only
// their own work, not the library's login overhead.
//
// Safety: refuses to run when NODE_ENV === "production". The cookie
// it returns is a fully-valid session cookie signed with the auth
// secret; production code must never see this helper.
//
// Usage:
//
//   const session = await createTestSession(db, auth, {
//     tenantId: "t_alpha",
//     userId: "u_alice",
//     email: "alice@erp.local",
//     roles: ["metadata.write"],
//   });
//
//   await app.inject({
//     method: "GET",
//     url: "/admin/v1/metadata/objects",
//     headers: { cookie: session.cookieHeader, "x-tenant-id": session.tenantId },
//   });

import { randomUUID, createHmac } from "node:crypto";

import { type Database, UserTenantRepository } from "@erp/db";
import { sql, type Kysely } from "kysely";

import { type AuthInstance } from "./create-auth.js";

export const BETTER_AUTH_COOKIE_NAME = "erp.session_token";

export interface CreateTestSessionInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly email?: string;
  readonly name?: string;
  readonly roles: readonly string[];
  /**
   * How long the session cookie is valid. Defaults to 1 hour —
   * tests don't need more, and shorter expiry surfaces race
   * conditions sooner if the auth plugin starts caching.
   */
  readonly ttlSeconds?: number;
}

export interface TestSession {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly roles: readonly string[];
  readonly sessionId: string;
  readonly sessionToken: string;
  /** Ready-to-inject `cookie` header value. */
  readonly cookieHeader: string;
  /** Equivalent single-entry object. Both interchangeable. */
  readonly headers: { cookie: string };
}

/**
 * Insert the fixture rows + return a Better-Auth-compatible cookie.
 *
 * Writes 3 rows:
 *   - `auth.user` (idempotent on email — ON CONFLICT DO NOTHING)
 *   - `auth.session` (fresh row per call)
 *   - `metadata.user_tenant` (user ⇄ tenant with roles)
 */
export async function createTestSession(
  db: Kysely<Database>,
  auth: AuthInstance,
  input: CreateTestSessionInput,
): Promise<TestSession> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "createTestSession refuses to run in production. " +
        "This helper bypasses Better Auth's validation and is tests-only.",
    );
  }

  const userId = input.userId ?? `u_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const email = input.email ?? `${userId}@erp.local`;
  const name = input.name ?? userId;
  const sessionId = `ses_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const sessionToken = `tok_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  const ttl = input.ttlSeconds ?? 3600;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  // Insert user (idempotent). We don't wait for the user-tenant repo
  // to run a vendor transaction — both writes are vendor-level inserts
  // against non-tenant tables (auth.*) and a tenant-scoped table
  // (metadata.user_tenant) that RLS allows under the vendor role.
  await db
    .insertInto("auth.user")
    .values({
      id: userId,
      name,
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((c) => c.column("email").doNothing())
    .execute();

  // Fetch the user id in case we hit the conflict path.
  const userRow = await db
    .selectFrom("auth.user")
    .select(["id"])
    .where("email", "=", email)
    .executeTakeFirst();
  const actualUserId = userRow?.id ?? userId;

  await db
    .insertInto("auth.session")
    .values({
      id: sessionId,
      userId: actualUserId,
      token: sessionToken,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  // User-tenant membership. The repository uses runAsVendor so we
  // don't need to pre-set app.current_tenant.
  const userTenantRepo = new UserTenantRepository(db);
  await userTenantRepo.add({
    user_id: actualUserId,
    tenant_id: input.tenantId,
    roles: input.roles,
  });

  // Sign the cookie with the same HMAC recipe better-auth uses on
  // the wire: `${token}.${hmacSha256(token, secret)}`. Read the
  // secret from the auth instance's resolved context rather than
  // re-deriving it — cookie name + secret stay in sync even if the
  // Better Auth config changes later.
  const ctx = await auth.$context;
  const secret = ctx.secret;
  const cookieName = ctx.authCookies.sessionToken.name;

  const signed = signCookieValue(sessionToken, secret);
  // Better Auth's own cookie setter does NOT URL-encode the value
  // (see dist/plugins/test-utils/cookie-builder.mjs). Match that on
  // the wire so the cookie jar's lookup is byte-identical.
  const cookieHeader = `${cookieName}=${signed}`;

  return {
    userId: actualUserId,
    tenantId: input.tenantId,
    email,
    roles: input.roles,
    sessionId,
    sessionToken,
    cookieHeader,
    headers: { cookie: cookieHeader },
  };
}

/**
 * Replicates better-auth's `signCookieValue` from
 * dist/plugins/test-utils/cookie-builder.mjs. We inline it here so
 * @erp/auth doesn't depend on better-auth's non-public `plugins/
 * test-utils` subpath, which could rename across minor versions.
 *
 * Better Auth's `makeSignature` in dist/crypto/index.mjs does:
 *   btoa(String.fromCharCode(...new Uint8Array(hmac-sha256)))
 * That's standard base64 — NOT base64url. The encoding must match
 * exactly or the cookie-jar byte comparison fails.
 */
function signCookieValue(value: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return `${value}.${signature}`;
}

// Re-exported so the Fastify plugin can delete a test session after
// a test. Not strictly required — per-test transactions would also
// clean up — but some integration tests use `beforeEach` schema
// teardown which wipes the rows without needing this helper.
export async function deleteTestSession(db: Kysely<Database>, sessionId: string): Promise<void> {
  await db.deleteFrom("auth.session").where("id", "=", sessionId).execute();
}

// Silence an unused-import lint — sql is kept for future helpers
// that may need raw SQL (e.g. the user_tenant roles JSON update).
void sql;
