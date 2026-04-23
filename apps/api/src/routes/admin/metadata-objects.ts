// Admin · /admin/v1/metadata/objects[/{id}[/history]]
// Three of the nine RFC §9.1 endpoints.

import { type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { Result } from "@erp/core";

import { parseParams, parseQuery } from "../../plugins/zod-validation.js";
import {
  HistoryResponseSchema,
  ListObjectsQuerySchema,
  ListObjectsResponseSchema,
  MetaObjectRowSchema,
  ObjectIdParamsSchema,
  ResolvedObjectResponseSchema,
} from "../../schemas/admin.js";
import { ProblemSchema, buildProblem } from "../../schemas/error.js";

import type { MetadataObjectService } from "../../services/metadata-object-service.js";
import type { FastifyInstance } from "fastify";

export interface MetadataObjectRoutesWiring {
  readonly registry: OpenAPIRegistry;
  readonly service: MetadataObjectService;
}

export async function registerMetadataObjectRoutes(
  app: FastifyInstance,
  wiring: MetadataObjectRoutesWiring,
): Promise<void> {
  // ── OpenAPI registrations ────────────────────────────────────────

  wiring.registry.registerPath({
    method: "get",
    path: "/admin/v1/metadata/objects",
    tags: ["Admin · Metadata"],
    description: "List currently-active metadata objects, filterable by type and layer.",
    request: { query: ListObjectsQuerySchema },
    responses: {
      200: {
        description: "A page of metadata objects.",
        content: { "application/json": { schema: ListObjectsResponseSchema } },
      },
    },
  });

  wiring.registry.registerPath({
    method: "get",
    path: "/admin/v1/metadata/objects/{id}",
    tags: ["Admin · Metadata"],
    description:
      "Fetch the resolved (layer-merged) effective metadata for an object. Returns 404 if no layer contributes a body.",
    request: { params: ObjectIdParamsSchema },
    responses: {
      200: {
        description: "Resolved metadata.",
        content: { "application/json": { schema: ResolvedObjectResponseSchema } },
      },
      404: {
        description: "No active definition for this object id.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  wiring.registry.registerPath({
    method: "get",
    path: "/admin/v1/metadata/objects/{id}/history",
    tags: ["Admin · Metadata"],
    description: "Full version history for an object across every layer the tenant inherits.",
    request: { params: ObjectIdParamsSchema },
    responses: {
      200: {
        description: "Version history, most-recent first.",
        content: { "application/json": { schema: HistoryResponseSchema } },
      },
    },
  });

  // ── Handlers ─────────────────────────────────────────────────────

  app.get("/admin/v1/metadata/objects", { schema: {} }, async (request, reply) => {
    const query = parseQuery(request, ListObjectsQuerySchema);
    const out = await wiring.service.list({
      tenantId: request.appContext.tenantId,
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.layer !== undefined ? { layer: query.layer } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return reply.code(200).send(
      ListObjectsResponseSchema.parse({
        items: out.items.map((i) => MetaObjectRowSchema.parse(i)),
        limit: out.limit,
        offset: out.offset,
      }),
    );
  });

  app.get("/admin/v1/metadata/objects/:id", { schema: {} }, async (request, reply) => {
    const params = parseParams(request, ObjectIdParamsSchema);
    const r = await wiring.service.get(request.appContext.tenantId, params.id);
    return Result.match(r, {
      ok: (resolved) =>
        reply.code(200).send(
          ResolvedObjectResponseSchema.parse({
            object_id: resolved.object_id,
            body: resolved.body,
            provenance: resolved.provenance,
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

  app.get("/admin/v1/metadata/objects/:id/history", { schema: {} }, async (request, reply) => {
    const params = parseParams(request, ObjectIdParamsSchema);
    const items = await wiring.service.history(request.appContext.tenantId, params.id);
    return reply.code(200).send(
      HistoryResponseSchema.parse({
        items: items.map((i) => MetaObjectRowSchema.parse(i)),
      }),
    );
  });
}
