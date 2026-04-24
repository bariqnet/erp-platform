// auth plugin — Better Auth session resolver + /api/auth/* mount.
//
// ADR-0004: this plugin is the one place apps/api touches the auth
// library. @erp/auth wraps better-auth; the plugin:
//
//   1. Mounts the Better Auth Node handler at /api/auth/* (login,
//      signup, signout, session refresh, etc.).
//   2. On every other request, resolves the session cookie →
//      user + tenant-context. Populates request.appContext with
//      userId + userRoles.
//
// TASK-10.1b.2 — the dev-header fallback that let integration tests
// use x-user-id / x-user-roles headers during the migration window
// was removed when the last test file migrated to
// `createTestSession()`. If a caller now arrives without a valid
// Better Auth session and `required` is true, it's 401.
//
// The plugin depends on `erp-telemetry` (for request.appContext.logger)
// and runs BEFORE `erp-tenant-context` so tenant-context can validate
// the x-tenant-id against the session's memberships.

import { createAuth, resolveSession, resolveTenantContext, type AuthInstance } from "@erp/auth";
import { type Database } from "@erp/db";
import fp from "fastify-plugin";
import { type Kysely } from "kysely";

import { buildProblem } from "../schemas/error.js";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

const DEFAULT_PUBLIC: readonly string[] = ["/healthz", "/readyz", "/docs/openapi.json"];

export interface AuthPluginOptions {
  /** Shared Kysely — repo mutations + Better Auth both talk to this. */
  readonly db: Kysely<Database>;
  /** Pre-built auth instance. Tests can inject; production calls createAuth(db) here. */
  readonly auth?: AuthInstance;
  /** Routes that bypass auth entirely. */
  readonly publicRoutes?: readonly string[];
  /** When true, refuse requests without a session. Defaults to NODE_ENV==='production'. */
  readonly required?: boolean;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const required = opts.required ?? process.env.NODE_ENV === "production";
  const isProduction = process.env.NODE_ENV === "production";
  const publicRoutes = new Set(opts.publicRoutes ?? DEFAULT_PUBLIC);

  const auth =
    opts.auth ??
    createAuth({
      db: opts.db,
      isProduction,
      onBootWarning: (message) => {
        app.log.warn({ msg: message });
      },
    });

  // ── /api/auth/* — Better Auth's Node handler ────────────────────
  // Better Auth's `auth.handler` is a `(Request) => Promise<Response>`
  // built on Web Fetch primitives. Fastify's raw request/response
  // handoff is the cleanest bridge.
  app.route({
    method: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    url: "/api/auth/*",
    // Opt out of Fastify's automatic JSON body parsing — BA reads
    // the raw body itself.
    config: {},
    handler: async (request, reply) => {
      const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v) && v.length > 0) headers.set(k, v[0] ?? "");
      }

      let body: string | undefined;
      if (request.method !== "GET" && request.method !== "HEAD") {
        body =
          typeof request.body === "string"
            ? request.body
            : request.body === undefined || request.body === null
              ? undefined
              : JSON.stringify(request.body);
      }

      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });

      const response = await auth.handler(webRequest);

      reply.code(response.status);
      response.headers.forEach((value, key) => {
        // content-length is recomputed by Fastify; pass-through breaks
        // the wire with a miscount when body is re-encoded.
        if (key.toLowerCase() === "content-length") return;
        reply.header(key, value);
      });
      const text = await response.text();
      return reply.send(text);
    },
  });

  // ── Session resolver preHandler ─────────────────────────────────
  // Writes userId + userRoles onto appContext. Runs AFTER routing
  // so 404s go through notFoundHandler rather than auth errors.
  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === undefined) return;
    const pathOnly = request.url.split("?")[0] ?? request.url;
    if (publicRoutes.has(pathOnly)) return;
    // Auth routes themselves are exempt — they set the cookie.
    if (pathOnly.startsWith("/api/auth/")) return;

    // 1. Try real Better Auth session.
    const webHeaders = buildWebHeaders(request);
    const session = await resolveSession(auth, { headers: webHeaders });

    if (session !== null) {
      // Tenant context plugin hasn't run yet — we read x-tenant-id
      // here so we can resolve the membership. Tenant-context then
      // still validates the header format separately.
      const tenantHeader = stringHeader(request, "x-tenant-id");
      if (tenantHeader === "") {
        // Leave appContext.userId set so the tenant-context plugin
        // can still 400 on missing tenant with full fidelity.
        request.appContext = {
          ...request.appContext,
          userId: session.userId,
          userRoles: [],
        };
        return;
      }

      const membership = await resolveTenantContext(opts.db, session.userId, tenantHeader);
      if (membership === null) {
        return reject(reply, 403, "forbidden_for_tenant", "Not a member of this tenant.");
      }

      request.appContext = {
        ...request.appContext,
        userId: session.userId,
        userRoles: membership.userRoles,
      };
      return;
    }

    // 2. No session — 401 when required (the dev-header fallback
    // was removed in TASK-10.1b.2).
    if (required) {
      return reject(reply, 401, "unauthenticated", "Authentication required.");
    }
  });
};

function stringHeader(request: FastifyRequest, name: string): string {
  const v = request.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return "";
}

function buildWebHeaders(request: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(request.headers)) {
    if (typeof v === "string") h.set(k, v);
    else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") h.set(k, v[0]);
  }
  return h;
}

function reject(reply: FastifyReply, status: number, kind: string, detail: string): FastifyReply {
  const problem = buildProblem({ status, kind, detail });
  return reply.code(status).header("content-type", "application/problem+json").send(problem);
}

export default fp(authPlugin, { name: "erp-auth", dependencies: ["erp-telemetry"] });
