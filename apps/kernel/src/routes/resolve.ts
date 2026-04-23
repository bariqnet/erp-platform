// POST /internal/resolve — the kernel's one hot-path endpoint.
//
// Input:  { tenant_id, object_id }
// Output: { object_id, body, provenance, cache_status, duration_ms }
//
// This route is internal: called by apps/api's Runtime API layer
// (TASK-12) and by any future internal consumer. No Better Auth, no
// tenant-context header — the tenant is carried in the body by design,
// so a single request can resolve across tenants if the caller has
// vendor-level privileges (e.g. cross-tenant backfills).
//
// The heavy lifting — cache probe, resolver fall-through, structured
// logging, span emission — lives in ResolveService; this handler is
// thin.

import { type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { Result } from "@erp/core";

import { parseBody } from "../plugins/zod-validation.js";
import { type ResolveService } from "../resolve-service.js";
import { ProblemSchema, buildProblem } from "../schemas/error.js";
import { ResolveRequestSchema, ResolveResponseSchema } from "../schemas/resolve.js";

import type { FastifyInstance } from "fastify";

export interface ResolveRouteWiring {
  readonly registry: OpenAPIRegistry;
  readonly service: ResolveService;
}

export async function registerResolveRoutes(
  app: FastifyInstance,
  wiring: ResolveRouteWiring,
): Promise<void> {
  wiring.registry.registerPath({
    method: "post",
    path: "/internal/resolve",
    tags: ["Kernel"],
    description:
      "Resolve the effective metadata for a (tenant, object) pair. Walks the tenant's active layers, applies the merge strategies, and returns the materialized body plus cache provenance.",
    request: {
      body: { content: { "application/json": { schema: ResolveRequestSchema } } },
    },
    responses: {
      200: {
        description: "Resolved metadata.",
        content: { "application/json": { schema: ResolveResponseSchema } },
      },
      404: {
        description: "No active definition for this object id.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  app.post("/internal/resolve", { schema: {} }, async (request, reply) => {
    const body = parseBody(request, ResolveRequestSchema);
    const r = await wiring.service.resolveOne({
      tenant_id: body.tenant_id,
      object_id: body.object_id,
    });
    return Result.match(r, {
      ok: (out) =>
        reply.code(200).send(
          ResolveResponseSchema.parse({
            object_id: out.object_id,
            body: out.body,
            provenance: out.provenance,
            cache_status: out.cache_status,
            duration_ms: out.duration_ms,
          }),
        ),
      err: (e) =>
        reply
          .code(404)
          .header("content-type", "application/problem+json")
          .send(
            buildProblem({
              status: 404,
              kind: e.kind,
              detail: `No active definition for ${e.object_id}.`,
            }),
          ),
    });
  });
}
