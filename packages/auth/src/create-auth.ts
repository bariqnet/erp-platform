// createAuth — the one place we call `better-auth`'s betterAuth().
//
// Why this exists: apps/api (today) and apps/console (soon) both
// need to resolve Better Auth sessions, but neither should import
// `better-auth` directly. This package is the adapter. When a
// future task swaps Better Auth for a successor (or we need to add
// auth-specific instrumentation), only this file changes.
//
// Shape:
//
//   const auth = createAuth({ db: sharedKysely, secret, baseURL });
//   // auth.handler    — Node-HTTP handler for /api/auth/*.
//   // auth.api        — Server-side functions (.getSession, etc).
//   // auth.$Infer     — Typed session/user shapes.
//
// ADR-0004 anchors the decisions (shared Kysely, modelName
// overrides, per-request session resolution).

import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { type Database } from "@erp/db";
import { betterAuth } from "better-auth";
import { type Kysely } from "kysely";

import { DEV_SECRET, type AuthConfig } from "./config.js";

/**
 * Shape of the return value of `createAuth`. Re-exported as a named
 * alias so tests + the Fastify plugin don't have to propagate
 * better-auth's generics — the Auth type's signature explodes
 * through every call site if we re-export it. Inferred via
 * `ReturnType<typeof createAuth>` to keep the concrete options'
 * narrow types (otherwise TS widens `secret: string` back to
 * `secret: string | undefined`).
 */
// eslint-disable-next-line @typescript-eslint/no-use-before-define
export type AuthInstance = ReturnType<typeof createAuth>;

export interface CreateAuthInput {
  /**
   * The shared Kysely instance (apps/api's `db`). Same connection
   * pool as the rest of the app — ADR-0004 explains the rationale
   * for shared-not-separate.
   */
  readonly db: Kysely<Database>;
  /**
   * HMAC secret for session signing. In production, required and
   * must be ≥32 chars. In dev/test, a well-known dev secret is used
   * if the env var is missing (with a boot-time warning).
   */
  readonly secret?: string;
  /**
   * Canonical URL the app is reachable at. Better Auth uses this
   * for cookie domain + CSRF checks.
   */
  readonly baseURL?: string;
  /**
   * Mark the environment as production. Controls cookie Secure flag
   * and the refusal-on-missing-secret behavior. Defaults to
   * NODE_ENV === "production".
   */
  readonly isProduction?: boolean;
  /**
   * Origins Better Auth accepts sign-in / sign-up calls from. The
   * console (port 3002 or 3003) proxies POSTs through a Server
   * Action; the Node fetch sends no Origin header, but the CSRF
   * check still enforces the Host against this allow-list.
   */
  readonly trustedOrigins?: readonly string[];
  /**
   * Optional logger callback — the Fastify plugin passes its
   * pino.child so auth logs carry the request_id.
   */
  readonly onBootWarning?: (message: string) => void;
}

/**
 * Build a Better Auth server instance pointed at the shared Kysely.
 *
 * Throws when `isProduction` is true and `secret` is missing.
 */
export function createAuth(input: CreateAuthInput) {
  const isProduction = input.isProduction ?? process.env.NODE_ENV === "production";

  const secret = input.secret ?? process.env.BETTER_AUTH_SECRET ?? (isProduction ? "" : DEV_SECRET);
  if (secret === "") {
    throw new Error(
      "createAuth: BETTER_AUTH_SECRET is required in production. " +
        "Set it via the GRAFANA-Cloud-style Secrets Manager entry (see infra/terraform/secrets.tf).",
    );
  }
  if (secret === DEV_SECRET && input.onBootWarning !== undefined) {
    input.onBootWarning(
      "createAuth: using built-in dev secret for Better Auth. " +
        "Set BETTER_AUTH_SECRET to silence this (dev: any value; prod: a 32+ char random string).",
    );
  }

  const baseURL = input.baseURL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:4000";

  const config: AuthConfig = {
    secret,
    baseURL,
    cookiePrefix: "erp",
    isProduction,
  };

  // Default trusted origins: baseURL + common local console ports.
  // Prod overrides via BETTER_AUTH_TRUSTED_ORIGINS (comma-separated)
  // or the input.trustedOrigins option.
  const defaultOrigins = [baseURL, "http://localhost:3002", "http://localhost:3003"];
  const envOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const trustedOrigins = [
    ...new Set([...defaultOrigins, ...envOrigins, ...(input.trustedOrigins ?? [])]),
  ];

  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins,

    // Shared Kysely via the adapter. The adapter function takes
    // options and returns a DBAdapter; betterAuth accepts that shape
    // directly (DBAdapterInstance).
    database: kyselyAdapter(input.db, { type: "postgres" }),

    // Schema-qualified table names merged with Phase-1 behavior
    // settings on the session model. ADR-0004 — why this over
    // `search_path`.
    user: { modelName: "auth.user" },
    session: {
      modelName: "auth.session",
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // Rotate rolling cookie every 24 h.
      cookieCache: {
        enabled: false, // Postgres is the session source of truth in Phase 1.
        maxAge: 0,
      },
    },
    account: { modelName: "auth.account" },
    verification: { modelName: "auth.verification" },

    emailAndPassword: {
      enabled: true,
      // Phase 1 doesn't require email verification — the pilot
      // tenant is internal. Phase 4 hardening flips this on.
      requireEmailVerification: false,
      // Upstream default minimum is 8; bump to 10 so the platform
      // forces a modest improvement over the library default without
      // making the first login needlessly painful.
      minPasswordLength: 10,
    },

    advanced: {
      cookiePrefix: config.cookiePrefix,
      useSecureCookies: config.isProduction,
      defaultCookieAttributes: {
        sameSite: "lax",
        httpOnly: true,
        secure: config.isProduction,
        path: "/",
      },
    },

    // No social providers in Phase 1; email+password only.
    socialProviders: {},
  });
}
