// Request-scoped context carried through every kernel route handler.
//
// The kernel exposes internal endpoints only — there is no
// tenant-from-header plumbing here (the tenant is in the body of every
// /internal/resolve call, by design). `requestId` + `traceId` + a
// structured logger are all the context that every route needs.
//
// CLAUDE.md §9 still applies: every log line that runs under a tenant
// is pre-bound with `tenant_id` — but that binding happens in the
// resolve handler itself, not in a request-wide plugin.

import { type Logger } from "@erp/telemetry";

export interface RequestContext {
  readonly requestId: string;
  /** W3C Trace Context trace_id (32 hex). Empty string if no trace header. */
  readonly traceId: string;
  /** Per-request logger pre-bound with request_id + trace_id. */
  readonly logger: Logger;
}

/**
 * Augment Fastify's request type with `appContext`. Imported by
 * server.ts so handlers see `request.appContext` typed.
 */
declare module "fastify" {
  interface FastifyRequest {
    appContext: RequestContext;
  }
}
