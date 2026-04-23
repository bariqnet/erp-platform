// Runtime · /v1/:entity[/:id] — auto-derived REST endpoints.
//
// RFC §9.2: "Every entity gets automatic REST endpoints derived from
// its metadata." In Phase 1 the five CRUD verbs land:
//
//   GET    /v1/:entity                 list rows
//   POST   /v1/:entity                 create a row
//   GET    /v1/:entity/:id             fetch a row
//   PATCH  /v1/:entity/:id             patch a row (merge, not replace)
//   DELETE /v1/:entity/:id             soft-delete a row
//
// Named action endpoints (workflow transitions) land with the
// workflow engine in Phase 2.
//
// The `:entity` segment is the metadata object_id — e.g.
// `ent.customer`, `ent.product`, `ent.invoice`. That keeps the URL
// shape stable: no pluralization/grammar rules baked into the router;
// the metadata drives the shape.
//
// Every handler is thin: parse params/query/body → call
// RuntimeEntityService → Result.match → HTTP response. The service
// owns the Permission Gate + resolve + materialize + validate flow.

import { type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { Result } from "@erp/core";

import { parseBody, parseParams, parseQuery } from "../../plugins/zod-validation.js";
import { ProblemSchema, buildProblem } from "../../schemas/error.js";
import {
  DeleteResponseSchema,
  EntityParamsSchema,
  EntityRowBodySchema,
  EntityRowListResponseSchema,
  EntityRowParamsSchema,
  EntityRowResponseSchema,
  ListEntityRowsQuerySchema,
} from "../../schemas/runtime.js";

import type { RuntimeEntityService, RuntimeError } from "../../services/runtime-entity-service.js";
import type { EntityRow } from "@erp/db";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface RuntimeEntityRoutesWiring {
  readonly registry: OpenAPIRegistry;
  readonly service: RuntimeEntityService;
}

export async function registerRuntimeEntityRoutes(
  app: FastifyInstance,
  wiring: RuntimeEntityRoutesWiring,
): Promise<void> {
  // ── OpenAPI ──────────────────────────────────────────────────────
  wiring.registry.registerPath({
    method: "get",
    path: "/v1/{entity}",
    tags: ["Runtime"],
    description:
      "List rows of a deployed entity. Validation and shape are derived from the entity's metadata.",
    request: {
      params: EntityParamsSchema,
      query: ListEntityRowsQuerySchema,
    },
    responses: {
      200: {
        description: "A page of entity rows.",
        content: { "application/json": { schema: EntityRowListResponseSchema } },
      },
      403: {
        description: "Forbidden.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Entity not deployed.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  wiring.registry.registerPath({
    method: "post",
    path: "/v1/{entity}",
    tags: ["Runtime"],
    description:
      "Create a row on a deployed entity. The body is validated against the entity's resolved metadata.",
    request: {
      params: EntityParamsSchema,
      body: { content: { "application/json": { schema: EntityRowBodySchema } } },
    },
    responses: {
      201: {
        description: "Row created.",
        content: { "application/json": { schema: EntityRowResponseSchema } },
      },
      400: {
        description: "Validation error.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Entity not deployed.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  wiring.registry.registerPath({
    method: "get",
    path: "/v1/{entity}/{id}",
    tags: ["Runtime"],
    description: "Fetch a single entity row by its row_id (UUID).",
    request: { params: EntityRowParamsSchema },
    responses: {
      200: {
        description: "The row.",
        content: { "application/json": { schema: EntityRowResponseSchema } },
      },
      403: {
        description: "Forbidden.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Row or entity not found.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  wiring.registry.registerPath({
    method: "patch",
    path: "/v1/{entity}/{id}",
    tags: ["Runtime"],
    description:
      "Merge the provided body into the existing row. Only fields present in the request are touched.",
    request: {
      params: EntityRowParamsSchema,
      body: { content: { "application/json": { schema: EntityRowBodySchema } } },
    },
    responses: {
      200: {
        description: "Row updated.",
        content: { "application/json": { schema: EntityRowResponseSchema } },
      },
      400: {
        description: "Validation error.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Row or entity not found.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  wiring.registry.registerPath({
    method: "delete",
    path: "/v1/{entity}/{id}",
    tags: ["Runtime"],
    description: "Soft-delete a row. Sets deleted_at; subsequent reads return 404.",
    request: { params: EntityRowParamsSchema },
    responses: {
      200: {
        description: "Row deleted.",
        content: { "application/json": { schema: DeleteResponseSchema } },
      },
      403: {
        description: "Forbidden.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Row or entity not found.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  // ── Handlers ─────────────────────────────────────────────────────

  app.get("/v1/:entity", { schema: {} }, async (request, reply) => {
    const params = parseParams(request, EntityParamsSchema);
    const query = parseQuery(request, ListEntityRowsQuerySchema);
    const r = await wiring.service.list({
      tenantId: request.appContext.tenantId,
      userId: request.appContext.userId,
      userRoles: request.appContext.userRoles,
      entityId: params.entity,
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return Result.match(r, {
      ok: (out) =>
        reply.code(200).send(
          EntityRowListResponseSchema.parse({
            items: out.items.map(toResponse),
            limit: out.limit,
            offset: out.offset,
          }),
        ),
      err: (e) => problem(reply, e),
    });
  });

  app.post("/v1/:entity", { schema: {} }, async (request, reply) => {
    const params = parseParams(request, EntityParamsSchema);
    const body = parseBody(request, EntityRowBodySchema);
    const r = await wiring.service.create({
      tenantId: request.appContext.tenantId,
      userId: request.appContext.userId,
      userRoles: request.appContext.userRoles,
      requestId: request.appContext.requestId,
      traceId: request.appContext.traceId,
      entityId: params.entity,
      body,
    });
    return Result.match(r, {
      ok: (row) => reply.code(201).send(EntityRowResponseSchema.parse(toResponse(row))),
      err: (e) => problem(reply, e),
    });
  });

  app.get("/v1/:entity/:id", { schema: {} }, async (request, reply) => {
    const params = parseParams(request, EntityRowParamsSchema);
    const r = await wiring.service.get({
      tenantId: request.appContext.tenantId,
      userId: request.appContext.userId,
      userRoles: request.appContext.userRoles,
      entityId: params.entity,
      rowId: params.id,
    });
    return Result.match(r, {
      ok: (row) => reply.code(200).send(EntityRowResponseSchema.parse(toResponse(row))),
      err: (e) => problem(reply, e),
    });
  });

  app.patch("/v1/:entity/:id", { schema: {} }, async (request, reply) => {
    const params = parseParams(request, EntityRowParamsSchema);
    const body = parseBody(request, EntityRowBodySchema);
    const r = await wiring.service.patch({
      tenantId: request.appContext.tenantId,
      userId: request.appContext.userId,
      userRoles: request.appContext.userRoles,
      requestId: request.appContext.requestId,
      traceId: request.appContext.traceId,
      entityId: params.entity,
      rowId: params.id,
      body,
    });
    return Result.match(r, {
      ok: (row) => reply.code(200).send(EntityRowResponseSchema.parse(toResponse(row))),
      err: (e) => problem(reply, e),
    });
  });

  app.delete("/v1/:entity/:id", { schema: {} }, async (request, reply) => {
    const params = parseParams(request, EntityRowParamsSchema);
    const r = await wiring.service.delete({
      tenantId: request.appContext.tenantId,
      userId: request.appContext.userId,
      userRoles: request.appContext.userRoles,
      requestId: request.appContext.requestId,
      traceId: request.appContext.traceId,
      entityId: params.entity,
      rowId: params.id,
    });
    return Result.match(r, {
      ok: (out) => reply.code(200).send(DeleteResponseSchema.parse(out)),
      err: (e) => problem(reply, e),
    });
  });
}

// ── Error mapping ────────────────────────────────────────────────────

function problem(reply: FastifyReply, err: RuntimeError): FastifyReply {
  switch (err.kind) {
    case "forbidden":
      return reply
        .code(403)
        .header("content-type", "application/problem+json")
        .send(
          buildProblem({
            status: 403,
            kind: "forbidden",
            detail: forbiddenDetail(err.reason),
          }),
        );
    case "entity_not_deployed":
      return reply
        .code(404)
        .header("content-type", "application/problem+json")
        .send(
          buildProblem({
            status: 404,
            kind: "entity_not_deployed",
            detail: `No active Entity metadata for '${err.entity_id}'.`,
          }),
        );
    case "unsupported_storage_strategy":
      return reply
        .code(501)
        .header("content-type", "application/problem+json")
        .send(
          buildProblem({
            status: 501,
            kind: "unsupported_storage_strategy",
            title: "Not Implemented",
            detail: `Storage strategy '${err.strategy}' is not supported in Phase 1. Redeploy '${err.entity_id}' with storage.strategy=jsonb or hybrid.`,
          }),
        );
    case "validation_error":
      return reply
        .code(400)
        .header("content-type", "application/problem+json")
        .send(
          buildProblem({
            status: 400,
            kind: "validation_error",
            title: "Validation Error",
            detail: "The request body did not match the entity's resolved metadata.",
            errors: [...err.issues],
          }),
        );
    case "row_not_found":
      return reply
        .code(404)
        .header("content-type", "application/problem+json")
        .send(
          buildProblem({
            status: 404,
            kind: "row_not_found",
            detail: `No row with id '${err.row_id}' on '${err.entity_id}'.`,
          }),
        );
  }
}

function forbiddenDetail(
  reason: "no_permissions_configured" | "no_matching_role" | "action_not_granted",
): string {
  switch (reason) {
    case "no_permissions_configured":
      return "No Permission objects are deployed for this tenant; every Runtime API call is denied by default (RFC §13.1).";
    case "no_matching_role":
      return "None of the caller's roles match a deployed Permission object.";
    case "action_not_granted":
      return "The caller's role is recognized, but no deployed Permission grants this action on this entity.";
  }
}

function toResponse(row: EntityRow): {
  row_id: string;
  entity_id: string;
  body: Record<string, unknown>;
  status: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
} {
  return {
    row_id: row.row_id,
    entity_id: row.entity_id,
    body: row.body,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}
