// OpenTelemetry tracer factory. Services always create tracers through
// this function — `@opentelemetry/api` returns a NoOp tracer unless an
// SDK is registered. In dev + tests we run against that NoOp; in
// production each app's src/index.ts calls `registerOtelSdkFromEnv()`
// (see ./otel-sdk.ts) which installs the OTLP/HTTP exporter pointed at
// Grafana Cloud (CLAUDE.md §2, RFC §14). Once the SDK is live, every
// span emitted through createTracer() ships automatically — there are
// no other changes call sites need to make.
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
