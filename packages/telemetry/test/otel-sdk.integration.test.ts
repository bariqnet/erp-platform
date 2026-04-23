// Integration test for the OTel SDK wiring.
//
// Spins up a Fastify-backed mock OTLP collector, registers the full
// NodeSDK with `registerOtelSdk()`, emits one span via `createTracer()`,
// and asserts the collector received a POST to /v1/traces carrying the
// expected service.name resource attribute.
//
// This is the "real" end-to-end check — it verifies:
//
//   1. NodeSDK starts without auto-detecting extra resources that
//      would mask our serviceName.
//   2. The OTLPTraceExporter's URL joining + headers reach the wire.
//   3. Spans emitted through the existing `createTracer()` call site
//      travel through the SDK (no separate tracer provider needed).
//   4. `shutdown()` flushes pending spans so the test's assertion
//      doesn't race the periodic batcher.
//
// The unit tests in src/otel-sdk.test.ts cover the pure helpers +
// NoOp handle behavior without paying the SDK's start cost.

import { gunzipSync } from "node:zlib";

import { fastify, type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerOtelSdk, type OtelSdkHandle } from "../src/otel-sdk.js";
import { createTracer } from "../src/tracer.js";

import type { IncomingMessage } from "node:http";

interface CapturedRequest {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  /** Request body — JSON.parsed if the content-encoding let us. */
  readonly body: unknown;
  /** Raw bytes (for debugging). */
  readonly raw: Buffer;
}

describe("OTLP round-trip against a mock collector", () => {
  let collector: FastifyInstance;
  let collectorBaseUrl: string;
  const captured: CapturedRequest[] = [];
  let otel: OtelSdkHandle;

  beforeAll(async () => {
    collector = fastify({ logger: false });

    // The OTLP/HTTP JSON exporter sets content-type to application/json
    // and gzips the body by default. Capture raw bytes + decoded JSON.
    collector.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => {
        done(null, body);
      },
    );

    const handler = async (
      req: {
        url: string;
        headers: IncomingMessage["headers"];
        body: unknown;
      },
      reply: { status: (code: number) => { send: (v: unknown) => void } },
    ) => {
      const raw = req.body as Buffer;
      const bytes = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
      let decoded: unknown = undefined;
      try {
        decoded = JSON.parse(bytes.toString("utf8"));
      } catch {
        decoded = undefined;
      }
      captured.push({
        path: req.url,
        headers: req.headers,
        body: decoded,
        raw: bytes,
      });
      reply.status(200).send({});
    };

    collector.post("/v1/traces", handler);
    collector.post("/v1/metrics", handler);

    const address = await collector.listen({ host: "127.0.0.1", port: 0 });
    collectorBaseUrl = address;

    otel = registerOtelSdk({
      serviceName: "erp-telemetry-integration",
      endpoint: collectorBaseUrl,
      headers: { authorization: "Basic test-token" },
      // Run a metric export right away; without this the periodic
      // reader's first tick is 60 s away.
      metricExportIntervalMs: 500,
    });
  }, 30_000);

  afterAll(async () => {
    await otel?.shutdown();
    await collector?.close();
  });

  it("ships spans emitted via createTracer() to the OTLP endpoint", async () => {
    const tracer = createTracer("@erp/telemetry-integration");

    tracer.startActiveSpan("integration-test-span", (span) => {
      span.setAttribute("tenant_id", "t_test");
      span.setAttribute("rfc_section", "14");
      span.end();
    });

    // Shut down the SDK — the batcher flushes on shutdown, which is
    // the deterministic way to force-export pending spans.
    await otel.shutdown();

    const traceRequests = captured.filter((r) => r.path === "/v1/traces");
    expect(traceRequests.length).toBeGreaterThan(0);

    const req = traceRequests[0];
    expect(req).toBeDefined();
    if (!req) return;

    // The JSON exporter declares application/json.
    expect(req.headers["content-type"]).toBe("application/json");
    // Our auth header made it to the wire.
    expect(req.headers.authorization).toBe("Basic test-token");

    // The JSON payload follows the OTLP spec:
    //   { resourceSpans: [ { resource: { attributes: [...] }, scopeSpans: [...] } ] }
    // Walk it to prove service.name + the span's attributes round-tripped.
    const payload = req.body as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{
          scope: { name: string };
          spans: Array<{
            name: string;
            attributes: Array<{ key: string; value: { stringValue?: string } }>;
          }>;
        }>;
      }>;
    };

    expect(payload.resourceSpans).toBeDefined();
    expect(payload.resourceSpans.length).toBeGreaterThan(0);

    const resource = payload.resourceSpans[0]?.resource;
    const serviceNameAttr = resource?.attributes.find((a) => a.key === "service.name");
    expect(serviceNameAttr?.value.stringValue).toBe("erp-telemetry-integration");

    const scopeSpans = payload.resourceSpans[0]?.scopeSpans ?? [];
    const allSpans = scopeSpans.flatMap((s) => s.spans);
    const ourSpan = allSpans.find((s) => s.name === "integration-test-span");
    expect(ourSpan).toBeDefined();

    const tenantAttr = ourSpan?.attributes.find((a) => a.key === "tenant_id");
    expect(tenantAttr?.value.stringValue).toBe("t_test");

    // Sanity: the scope name matches what createTracer() was called with.
    const scope = scopeSpans.find((s) => s.spans.some((sp) => sp.name === "integration-test-span"));
    expect(scope?.scope.name).toBe("@erp/telemetry-integration");
  });
});
