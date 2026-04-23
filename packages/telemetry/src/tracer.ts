// OpenTelemetry tracer factory. Phase 1 ships the API surface only —
// `@opentelemetry/api` returns a NoOp tracer unless an SDK is
// registered. Span call sites exist from day one; when the SDK + OTLP
// exporter land (future TASK, Grafana Cloud endpoint per CLAUDE.md §2),
// every trace lights up automatically.
//
// Usage:
//
//   const tracer = createTracer("@erp/kernel");
//   await tracer.startActiveSpan("resolve", async (span) => {
//     span.setAttribute("tenant_id", tenantId);
//     span.setAttribute("object_id", objectId);
//     try {
//       return await doTheWork();
//     } finally {
//       span.end();
//     }
//   });
//
// CLAUDE.md §9 and RFC §14.2: tenant_id and trace_id propagate on every
// span and log line. The `@erp/api` telemetry plugin already extracts
// the W3C traceparent header; this tracer reuses the same active-span
// context when it runs inside a request.

import { type Span, type SpanOptions, type Tracer, trace } from "@opentelemetry/api";

/**
 * Return a tracer for the given instrumentation scope. Typically the
 * package name — `@erp/api`, `@erp/kernel`, etc. The SDK attributes
 * spans to this scope when it eventually exports.
 */
export function createTracer(scopeName: string, scopeVersion?: string): Tracer {
  return scopeVersion === undefined
    ? trace.getTracer(scopeName)
    : trace.getTracer(scopeName, scopeVersion);
}

export { trace, type Span, type SpanOptions, type Tracer };
