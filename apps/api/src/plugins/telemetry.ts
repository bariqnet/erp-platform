// telemetry plugin — request_id generation, child logger per request,
// trace_id extraction from W3C traceparent header.
//
// Writes `request.appContext.{requestId, traceId, logger}`. The
// tenant-context + auth plugins later fill in tenantId / userId.
//
// Header behavior:
//   x-request-id   if the caller sent one, we honor it; else generate a
//                  UUID v4. Echoed back on the response.
//   traceparent    parsed for the trace_id segment. If absent, traceId
//                  is "" (logs filter on truthy).

import { randomUUID } from "node:crypto";

import { type Logger } from "@erp/telemetry";
import fp from "fastify-plugin";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

export interface TelemetryPluginOptions {
  /** The root logger constructed by server.ts. */
  readonly logger: Logger;
}

const telemetryPlugin: FastifyPluginAsync<TelemetryPluginOptions> = async (app, opts) => {
  const root = opts.logger;

  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const requestId = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    const traceId = parseTraceId(request.headers.traceparent);

    const logger = root.child({
      request_id: requestId,
      ...(traceId !== "" ? { trace_id: traceId } : {}),
      method: request.method,
      url: request.url,
    });

    // appContext starts here; tenant-context + auth plugins extend it.
    request.appContext = {
      requestId,
      traceId,
      logger,
      tenantId: "",
      userId: "",
      userRoles: [],
    };

    reply.header("x-request-id", requestId);
  });

  app.addHook("onResponse", async (request, reply) => {
    request.appContext.logger.info(
      { status: reply.statusCode, latency_ms: reply.elapsedTime },
      "request completed",
    );
  });

  app.addHook("onError", async (request, _reply, err) => {
    request.appContext.logger.error({ err }, "request errored");
  });
};

function parseTraceId(headerValue: unknown): string {
  if (typeof headerValue !== "string") return "";
  const match = TRACEPARENT_RE.exec(headerValue);
  return match?.[1] ?? "";
}

export default fp(telemetryPlugin, { name: "erp-telemetry" });

export type TelemetryPlugin = ReturnType<typeof telemetryPlugin>;
export type ServerWithTelemetry = FastifyInstance;
