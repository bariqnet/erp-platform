// Request-scoped context carried through every route handler.
//
// Populated by the tenant-context + auth plugins; available at
// `request.appContext`. Every database query, every log line, every
// event emission reads from this. CLAUDE.md §9: every API request
// is tenant-scoped and every log line includes tenant_id.
// RFC §14.2: trace_id propagates via W3C Trace Context.

import { type Logger } from "@erp/telemetry";

export interface RequestContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly userRoles: readonly string[];
  readonly requestId: string;
  /** W3C Trace Context trace_id (32 hex). Empty string if no trace header. */
  readonly traceId: string;
  /** Per-request logger pre-bound with tenant_id, request_id, trace_id. */
  readonly logger: Logger;
}

/**
 * Augment Fastify's request type with `appContext`. Imported by
 * server.ts so the handlers see `request.appContext` typed.
 */
declare module "fastify" {
  interface FastifyRequest {
    appContext: RequestContext;
  }
}
