// pino logger factory. Single source of truth for the structured-log
// shape every service emits — log lines from apps/api, apps/kernel,
// apps/worker, and scripts that opt in all carry the same baseline
// fields (CLAUDE.md §9: every log line includes tenant_id; RFC §14.2:
// W3C Trace Context propagates through traces and logs).
//
// `console.log` is forbidden outside `scripts/` (CLAUDE.md §15 +
// scripts/verify.ts invariant #4); every production code path that
// wants to log goes through this logger.

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
      paths: REDACT_PATHS,
      censor: "[redacted]",
    },
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
