// auth plugin — placeholder for Phase 1.
//
// CLAUDE.md §2 pins Better Auth; full integration lives in TASK-10
// when the Admin API actually needs role checks. For TASK-09 we accept
// dev-mode headers (`x-user-id`, `x-user-roles`) so contract tests
// can exercise tenant-scoped routes without booting an auth server.
//
// The placeholder rejects requests with no user header in production
// (NODE_ENV === "production"). In dev/test it lets unauthenticated
// requests through so that /healthz works without auth and so that
// tests can opt in to a user identity per request.

import fp from "fastify-plugin";

import { buildProblem } from "../schemas/error.js";

import type { FastifyPluginAsync, FastifyRequest } from "fastify";

export interface AuthPluginOptions {
  /** Routes that bypass auth entirely (health/openapi). */
  readonly publicRoutes?: readonly string[];
  /** When true, refuse requests without a user header. Defaults to NODE_ENV==='production'. */
  readonly required?: boolean;
}

const DEFAULT_PUBLIC: readonly string[] = ["/healthz", "/readyz", "/docs/openapi.json"];

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const required = opts.required ?? process.env.NODE_ENV === "production";
  const publicRoutes = new Set(opts.publicRoutes ?? DEFAULT_PUBLIC);

  // preHandler runs AFTER routing so unknown URLs 404 via the
  // notFoundHandler instead of being rejected for missing auth.
  // Fastify's notFoundHandler still triggers preHandler hooks, so we
  // also skip when routerPath is unset (no route matched).
  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === undefined) return;
    if (publicRoutes.has(request.url) || isPublicRoute(request.url)) {
      return;
    }

    const userId = headerString(request, "x-user-id");
    const rolesHeader = headerString(request, "x-user-roles");
    const userRoles = rolesHeader === "" ? [] : rolesHeader.split(",").map((r) => r.trim());

    if (required && userId === "") {
      const problem = buildProblem({
        status: 401,
        kind: "unauthenticated",
        detail: "Authentication required.",
      });
      return reply.code(401).header("content-type", "application/problem+json").send(problem);
    }

    request.appContext = {
      ...request.appContext,
      userId,
      userRoles,
    };
  });
};

function headerString(request: FastifyRequest, name: string): string {
  const v = request.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return "";
}

function isPublicRoute(url: string): boolean {
  // Match versioned health endpoints (e.g. /healthz?probe=...) too.
  const path = url.split("?")[0] ?? url;
  return DEFAULT_PUBLIC.includes(path);
}

export default fp(authPlugin, { name: "erp-auth", dependencies: ["erp-telemetry"] });
