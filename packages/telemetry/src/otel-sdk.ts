// OpenTelemetry SDK bootstrap — the one place every service installs
// the OTLP/HTTP exporter in production.
//
// Phase-1 shape (CLAUDE.md §2, RFC §14):
//
//   apps/api, apps/kernel, apps/worker each call
//   `registerOtelSdkFromEnv(serviceName)` in src/index.ts *before* they
//   construct their Fastify/worker handle. The env-gated wrapper reads
//   GRAFANA_CLOUD_OTLP_ENDPOINT + GRAFANA_CLOUD_OTLP_HEADERS; when
//   neither is set (dev + tests) the call is a no-op and the NoOp
//   tracer that @opentelemetry/api returns by default is kept.
//
// Design notes:
//
//   - We intentionally do NOT ship auto-instrumentations. CLAUDE.md §2
//     keeps Phase-1 spans manual so the trace graph matches the code
//     we actually audit. When a future task adds specific
//     instrumentations (fastify, kysely, ioredis) they plug in via the
//     optional `instrumentations` field.
//   - Metrics use OTLP/HTTP with a PeriodicExportingMetricReader.
//     Grafana Cloud's OTLP gateway accepts both signals on the same
//     endpoint (`/v1/traces`, `/v1/metrics`). We auto-append the
//     signal paths so callers pass one base URL.
//   - The handle's `shutdown()` flushes outstanding spans + metrics
//     before the process exits. Entry points wire it into their
//     SIGINT/SIGTERM handler.

import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import type { IMetricReader } from "@opentelemetry/sdk-metrics";

/**
 * Options for `registerOtelSdk`. The `endpoint` is the Grafana Cloud
 * OTLP base URL (e.g. `https://otlp-gateway-prod-eu-west-0.grafana.net/otlp`);
 * this module appends `/v1/traces` and `/v1/metrics` for each signal.
 */
export interface RegisterOtelSdkInput {
  /** service.name resource attribute — e.g. "erp-api", "erp-kernel". */
  readonly serviceName: string;
  /** service.version resource attribute. Defaults to process.env.npm_package_version or "0.0.0". */
  readonly serviceVersion?: string;
  /** Extra resource attributes merged into the baseline. */
  readonly resourceAttributes?: Record<string, string>;
  /** OTLP/HTTP base endpoint. Signal paths (/v1/traces, /v1/metrics) appended automatically. */
  readonly endpoint: string;
  /** OTLP auth headers — typically { authorization: "Basic <base64(instanceID:token)>" }. */
  readonly headers?: Record<string, string>;
  /**
   * Metric export interval (ms). Defaults to 60 seconds. Grafana Cloud's
   * documented minimum is 15 s; going lower wastes egress without gaining
   * resolution.
   */
  readonly metricExportIntervalMs?: number;
  /**
   * Override the span exporter. Tests pass an in-memory exporter so
   * they can assert on emitted spans without a live OTLP endpoint.
   */
  readonly spanExporterOverride?: SpanExporter;
  /**
   * Override the metric reader. Tests pass a no-op reader to avoid
   * starting the periodic export timer.
   */
  readonly metricReaderOverride?: IMetricReader;
}

/**
 * Handle returned by `registerOtelSdk`. `shutdown()` flushes
 * outstanding spans + metrics and stops the SDK — entry points wire
 * it into SIGINT/SIGTERM so signals emitted during startup or an
 * error path make it to the collector before exit.
 */
export interface OtelSdkHandle {
  /** True when `registerOtelSdk` installed an SDK (i.e. env was configured). */
  readonly active: boolean;
  /** Flush and stop. Safe to call on a no-op handle. */
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: OtelSdkHandle = {
  active: false,
  shutdown: async () => {
    /* no-op */
  },
};

/**
 * Install the OpenTelemetry NodeSDK with OTLP/HTTP trace + metric
 * exporters. Caller owns the `shutdown()` call on process exit.
 */
export function registerOtelSdk(input: RegisterOtelSdkInput): OtelSdkHandle {
  const version = input.serviceVersion ?? process.env.npm_package_version ?? "0.0.0";

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: input.serviceName,
    [ATTR_SERVICE_VERSION]: version,
    ...input.resourceAttributes,
  });

  const tracesUrl = joinOtlpSignalPath(input.endpoint, "v1/traces");
  const metricsUrl = joinOtlpSignalPath(input.endpoint, "v1/metrics");

  const traceExporter: SpanExporter =
    input.spanExporterOverride ??
    new OTLPTraceExporter({
      url: tracesUrl,
      ...(input.headers ? { headers: input.headers } : {}),
    });

  const metricReader: IMetricReader =
    input.metricReaderOverride ??
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: metricsUrl,
        ...(input.headers ? { headers: input.headers } : {}),
      }),
      exportIntervalMillis: input.metricExportIntervalMs ?? 60_000,
    });

  // Phase 1 ships zero auto-instrumentations — every span is manual
  // via createTracer() (CLAUDE.md §2). When a future task needs
  // fastify/kysely/ioredis instrumentations, they plug into NodeSDK
  // here.
  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
  });

  sdk.start();

  return {
    active: true,
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}

/**
 * Env-gated variant: install the SDK when `GRAFANA_CLOUD_OTLP_ENDPOINT`
 * is set, no-op otherwise. This is what the apps call from their
 * `src/index.ts` entry point so dev + tests don't need any OTel
 * configuration.
 *
 * Supported env vars:
 *
 *   GRAFANA_CLOUD_OTLP_ENDPOINT   OTLP base URL (without /v1/traces).
 *   GRAFANA_CLOUD_OTLP_HEADERS    key1=value1,key2=value2 (URL-encoded
 *                                 values) — matches the OTel spec
 *                                 convention for OTEL_EXPORTER_OTLP_HEADERS.
 */
export function registerOtelSdkFromEnv(serviceName: string): OtelSdkHandle {
  const endpoint = process.env.GRAFANA_CLOUD_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint === "") {
    return NOOP_HANDLE;
  }

  const headersRaw = process.env.GRAFANA_CLOUD_OTLP_HEADERS;
  const headers =
    headersRaw !== undefined && headersRaw !== "" ? parseOtlpHeadersEnv(headersRaw) : undefined;

  return registerOtelSdk({
    serviceName,
    endpoint,
    ...(headers ? { headers } : {}),
  });
}

/**
 * Parse the OTEL spec-style headers env value:
 *
 *   authorization=Basic%20abc,x-scope=tenant-a
 *
 * URL-decodes each value so callers can embed `=` or `,` in auth
 * tokens without escaping at the shell. Blank entries are dropped.
 */
export function parseOtlpHeadersEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "") continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      // Malformed URL-encoding: keep the raw value rather than drop it.
      out[key] = value;
    }
  }
  return out;
}

/**
 * Append an OTLP signal sub-path to a base endpoint, de-duplicating
 * any trailing slash. `/otlp` + `v1/traces` → `/otlp/v1/traces`.
 */
function joinOtlpSignalPath(base: string, signalPath: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const leaf = signalPath.startsWith("/") ? signalPath.slice(1) : signalPath;
  // If the caller already included the signal path, honor it as-is.
  if (trimmed.endsWith(`/${leaf}`)) return trimmed;
  return `${trimmed}/${leaf}`;
}
