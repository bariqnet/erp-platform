// pino logger factory. Single source of truth for the structured-log
// shape every service emits — log lines from apps/api, apps/kernel,
// apps/worker, and scripts that opt in all carry the same baseline
// fields (CLAUDE.md §9: every log line includes tenant_id; RFC §14.2:
// W3C Trace Context propagates through traces and logs).
//
// `console.log` is forbidden outside `scripts/` (CLAUDE.md §15 +
// scripts/verify.ts invariant #4); every production code path that
// wants to log goes through this logger.
//
// Trace correlation (TASK-14.3): every log line carries `trace_id` and
// `span_id` from the active OTel context when one is present. Requests
// coming in via the telemetry plugin also have `trace_id` pre-set on
// the child logger bindings — that stays correct; the mixin only adds
// fields not already set.

import { context, trace as otelTrace } from "@opentelemetry/api";
import { pino, type Logger, type LoggerOptions } from "pino";

export interface CreateLoggerInput {
  /** App name — appears as `service` on every line. */
  readonly service: string;
  /** Default log level; per-line override via env LOG_LEVEL. */
  readonly level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  /** Pretty-print in dev (NODE_ENV !== "production"). Defaults to true in dev. */
  readonly pretty?: boolean;
  /** Extra base fields merged into every log line. */
  readonly base?: Record<string, unknown>;
}

/**
 * Build the root pino logger for a service. Apps construct one in
 * server.ts (or equivalent entry point) and inject it everywhere
 * else.
 *
 * Add request-scoped fields by `.child({ request_id, tenant_id, ... })`
 * — pino's child() merges into a new logger without mutating the
 * parent.
 */
export function createLogger(input: CreateLoggerInput): Logger {
  const env = process.env.NODE_ENV ?? "development";
  const level =
    input.level ??
    (process.env.LOG_LEVEL as CreateLoggerInput["level"] | undefined) ??
    (env === "production" ? "info" : "debug");
  const pretty = input.pretty ?? env !== "production";

  const options: LoggerOptions = {
    level,
    base: {
      service: input.service,
      env,
      ...input.base,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[redacted]",
    },
    mixin: otelContextMixin,
  };

  if (pretty) {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname,service,env",
        singleLine: false,
      },
    };
  }

  return pino(options);
}

/**
 * Pino mixin: inject `trace_id` / `span_id` from the active OTel span
 * into every log line. No-op when no span is active (startup code,
 * worker idle ticks) — the NoOp tracer that @opentelemetry/api
 * returns by default yields an invalid SpanContext which we filter.
 *
 * Exported for tests.
 */
export function otelContextMixin(): Record<string, string> {
  const span = otelTrace.getSpan(context.active());
  if (span === undefined) return {};
  const ctx = span.spanContext();
  // OTel marks an unset / sampled-out context with the magic zero
  // ids ("0".repeat(32)). Filter those so we don't litter logs with
  // meaningless zero traces.
  if (
    ctx.traceId === "" ||
    ctx.traceId === "00000000000000000000000000000000" ||
    ctx.spanId === "" ||
    ctx.spanId === "0000000000000000"
  ) {
    return {};
  }
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/**
 * Common-case fields that should never be written to a log line. Add
 * to this list when a new sensitive field appears on a request shape.
 */
export const REDACT_PATHS: readonly string[] = [
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.api_key",
  "*.authorization",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
];

export type { Logger };
