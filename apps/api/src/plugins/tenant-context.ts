// tenant-context plugin — extracts the tenant from `x-tenant-id` and
// stores it on request.appContext.tenantId. Repository methods then
// read from there and call withTenantContext to set the DB session
// role + GUC (CLAUDE.md §9 + RFC §10.1).
//
// Phase 1: trusts the header for tenant-scoped routes after auth has
// run. TASK-10 wires Better Auth in, at which point this plugin
// validates the header against the user's authorized tenants.

import fp from "fastify-plugin";

import { buildProblem } from "../schemas/error.js";

import type { FastifyPluginAsync } from "fastify";

export interface TenantContextPluginOptions {
  /** Routes that don't require a tenant header. */
  readonly publicRoutes?: readonly string[];
}

const DEFAULT_PUBLIC: readonly string[] = ["/healthz", "/readyz", "/docs/openapi.json"];

const TENANT_ID_RE = /^t_[a-z0-9_]{2,62}$/;

const tenantContextPlugin: FastifyPluginAsync<TenantContextPluginOptions> = async (app, opts) => {
  const publicRoutes = new Set(opts.publicRoutes ?? DEFAULT_PUBLIC);

  // preHandler runs AFTER routing so unknown URLs 404 via the
  // notFoundHandler instead of being rejected for missing headers.
  // Fastify's notFoundHandler still triggers preHandler hooks though,
  // so we also skip when routerPath is unset (no route matched).
  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === undefined) return;
    const path = request.url.split("?")[0] ?? request.url;
    if (publicRoutes.has(path)) return;

    const headerValue = request.headers["x-tenant-id"];
    const tenantId = typeof headerValue === "string" ? headerValue : "";

    if (tenantId === "") {
      const problem = buildProblem({
        status: 400,
        kind: "missing_tenant",
        detail: "x-tenant-id header is required for this route.",
      });
      return reply.code(400).header("content-type", "application/problem+json").send(problem);
    }

    if (!TENANT_ID_RE.test(tenantId)) {
      const problem = buildProblem({
        status: 400,
        kind: "invalid_tenant",
        detail: "x-tenant-id must match `t_[a-z0-9_]{2,62}`.",
      });
      return reply.code(400).header("content-type", "application/problem+json").send(problem);
    }

    request.appContext = {
      ...request.appContext,
      tenantId,
      logger: request.appContext.logger.child({ tenant_id: tenantId }),
    };
  });
};

export default fp(tenantContextPlugin, {
  name: "erp-tenant-context",
  dependencies: ["erp-telemetry", "erp-auth"],
});
