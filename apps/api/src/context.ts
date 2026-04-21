// Request-scoped context carried through every route handler. Every
// log line, every database query, every event emission reads from this.
// CLAUDE.md §9 — every API request is tenant-scoped and every log line
// includes tenant_id, request_id, trace_id.
//
// TASK-09 wires this up via a Fastify plugin.

export interface RequestContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly traceId: string;
}
