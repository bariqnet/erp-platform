// /healthz and /readyz routes.
//
// Liveness vs. readiness per the standard Kubernetes contract:
//   /healthz  process is alive (no external dependencies checked).
//   /readyz   process can serve requests right now — checks the DB.

import { sql } from "kysely";

import { ProblemSchema } from "../schemas/error.js";
import { HealthSchema, ReadinessSchema } from "../schemas/health.js";

import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { Database } from "@erp/db";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

export interface HealthRouteWiring {
  readonly serviceName: string;
  readonly db: Kysely<Database>;
  readonly registry: OpenAPIRegistry;
  readonly startedAt: Date;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  wiring: HealthRouteWiring,
): Promise<void> {
  wiring.registry.registerPath({
    method: "get",
    path: "/healthz",
    description: "Liveness probe — returns 200 as long as the process is alive.",
    tags: ["Health"],
    responses: {
      200: {
        description: "Process is up.",
        content: { "application/json": { schema: HealthSchema } },
      },
    },
  });

  wiring.registry.registerPath({
    method: "get",
    path: "/readyz",
    description:
      "Readiness probe — returns 200 if every dependency (database) is reachable, 503 otherwise.",
    tags: ["Health"],
    responses: {
      200: {
        description: "Ready to serve traffic.",
        content: { "application/json": { schema: ReadinessSchema } },
      },
      503: {
        description: "One or more dependencies are unavailable.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  app.get("/healthz", { schema: {} }, async (_req, reply) => {
    const body = HealthSchema.parse({
      status: "ok",
      service: wiring.serviceName,
      uptime_seconds: Math.floor((Date.now() - wiring.startedAt.getTime()) / 1000),
    });
    return reply.code(200).send(body);
  });

  app.get("/readyz", { schema: {} }, async (req, reply) => {
    const dbCheck = await checkDatabase(wiring.db);
    const checks = { database: dbCheck };
    const ready = Object.values(checks).every((c) => c.status === "pass");
    const body = ReadinessSchema.parse({
      status: ready ? "ready" : "not_ready",
      checks,
    });
    if (!ready) {
      req.appContext.logger.warn({ checks }, "readyz reporting not_ready");
    }
    return reply.code(ready ? 200 : 503).send(body);
  });
}

async function checkDatabase(
  db: Kysely<Database>,
): Promise<{ status: "pass" | "fail"; latency_ms: number; detail?: string }> {
  const start = Date.now();
  try {
    await sql`SELECT 1`.execute(db);
    return { status: "pass", latency_ms: Date.now() - start };
  } catch (err: unknown) {
    return {
      status: "fail",
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : "unknown",
    };
  }
}
