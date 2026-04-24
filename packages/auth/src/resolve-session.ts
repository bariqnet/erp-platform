// resolveSession / resolveTenantContext — the per-request hot path.
//
// Every authenticated Fastify request calls these two. Together
// they answer: "who is this caller, what tenant are they in this
// request scoped to, and what roles do they have there?"
//
//   1. `resolveSession(auth, headers)` — hand Better Auth the raw
//      headers, get back a Session + User (or null).
//   2. `resolveTenantContext(db, userId, tenantId)` — join
//      `metadata.user_tenant` to produce roles. Returns null if the
//      user has no membership in the requested tenant.
//
// The Fastify plugin composes these into one request-context
// decoration. Splitting them lets tests exercise either side in
// isolation.

import { UserTenantRepository } from "@erp/db";
import { type Database } from "@erp/db";
import { type Kysely } from "kysely";

import { type AuthInstance } from "./create-auth.js";

export interface ResolveSessionInput {
  /** Raw request headers — Fastify's `request.headers` works directly. */
  readonly headers: Headers;
}

export interface ResolvedSession {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

/**
 * Resolve a Better Auth session from request headers. Returns null
 * when no valid session cookie is present. Never throws on "no
 * session" — reserve throws for infrastructure failures.
 */
export async function resolveSession(
  auth: AuthInstance,
  input: ResolveSessionInput,
): Promise<ResolvedSession | null> {
  const result = await auth.api.getSession({
    headers: input.headers,
  });
  if (result === null || result === undefined) return null;
  const { session, user } = result;
  if (session === undefined || user === undefined) return null;

  return {
    userId: user.id,
    email: user.email,
    sessionId: session.id,
    expiresAt:
      typeof session.expiresAt === "string" ? session.expiresAt : session.expiresAt.toISOString(),
  };
}

export interface TenantMembership {
  readonly tenantId: string;
  readonly userRoles: readonly string[];
}

/**
 * Resolve the (user → tenant → roles) membership for a request.
 * Returns null when the user is not a member of the requested tenant
 * — the Fastify plugin turns that into a 403, never 404, so tenant
 * existence doesn't leak.
 */
export async function resolveTenantContext(
  db: Kysely<Database>,
  userId: string,
  tenantId: string,
): Promise<TenantMembership | null> {
  // UserTenantRepository.listForUser runs under runAsVendor (see
  // packages/db/src/user-tenant-repository.ts). We then filter
  // client-side because the list is small (single-digit tenants
  // per user in Phase 1) — moving the filter into SQL is a later
  // micro-optimization.
  const repo = new UserTenantRepository(db);
  const all = await repo.listForUser(userId);
  const hit = all.find((row) => row.tenant_id === tenantId);
  if (hit === undefined) return null;
  return {
    tenantId: hit.tenant_id,
    userRoles: hit.roles,
  };
}
