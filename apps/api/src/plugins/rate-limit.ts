// Rate limit — wraps @fastify/rate-limit with sane defaults per the
// Admin API's RFC §9.1 surface. Per-route overrides land on each
// route's own config (rate-limit max + timeWindow).
//
// Phase 1 uses the in-memory Redis-less store; the store swaps for
// Redis in TASK-11 when the platform first needs cross-instance
// rate accounting. The bus contract stays the same.

import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";

import type { FastifyPluginAsync } from "fastify";

export interface RateLimitPluginOptions {
  /** Default per-IP limit when a route doesn't override. */
  readonly globalMax?: number;
  /** Window the global limit applies over (ms or "1 minute"-style). */
  readonly globalTimeWindow?: number | string;
}

const rateLimitPlugin: FastifyPluginAsync<RateLimitPluginOptions> = async (app, opts) => {
  await app.register(rateLimit, {
    max: opts.globalMax ?? 300,
    timeWindow: opts.globalTimeWindow ?? "1 minute",
    // Use the request's tenant_id when present, else the IP. Keeps
    // limits per-tenant rather than per-source-IP for authenticated
    // routes (which is what production NAT / load balancer setups
    // require).
    keyGenerator: (request) => {
      const tenantId = request.appContext?.tenantId;
      return tenantId !== undefined && tenantId !== "" ? `tenant:${tenantId}` : `ip:${request.ip}`;
    },
  });
};

export default fp(rateLimitPlugin, {
  name: "erp-rate-limit",
  dependencies: ["erp-tenant-context"],
});
