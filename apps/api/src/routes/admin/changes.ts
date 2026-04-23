// Admin · /admin/v1/metadata/changes[/{id}/(simulate|propose|approve|deploy|rollback)]
// Six of the nine RFC §9.1 endpoints. Each transition is gated on the
// caller's role per CLAUDE.md §13: write/approve/deploy.

import { type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { type TransitionActor } from "@erp/change-set";
import { Result } from "@erp/core";

import { requireRole } from "../../plugins/require-role.js";
import { parseBody, parseParams } from "../../plugins/zod-validation.js";
import {
  ChangeSetIdParamsSchema,
  CreateChangeSetBodySchema,
  CreateChangeSetResponseSchema,
  SimulateResponseSchema,
  TransitionResponseSchema,
} from "../../schemas/admin.js";
import { ProblemSchema, buildProblem } from "../../schemas/error.js";

import type { ChangeSetService, ServiceError } from "../../services/change-set-service.js";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface ChangeSetRoutesWiring {
  readonly registry: OpenAPIRegistry;
  readonly service: ChangeSetService;
}

export async function registerChangeSetRoutes(
  app: FastifyInstance,
  wiring: ChangeSetRoutesWiring,
): Promise<void> {
  // ── OpenAPI registrations ────────────────────────────────────────

  wiring.registry.registerPath({
    method: "post",
    path: "/admin/v1/metadata/changes",
    tags: ["Admin · Change Sets"],
    description:
      "Create a draft Change Set, optionally with an initial batch of operations. Requires `metadata.write`.",
    request: {
      body: { content: { "application/json": { schema: CreateChangeSetBodySchema } } },
    },
    responses: {
      201: {
        description: "Change Set created.",
        content: { "application/json": { schema: CreateChangeSetResponseSchema } },
      },
      409: {
        description: "A Change Set with this id already exists.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  for (const [action, role, statusCode] of [
    ["simulate", "metadata.write", 200],
    ["propose", "metadata.write", 200],
    ["approve", "metadata.approve", 200],
    ["deploy", "metadata.deploy", 200],
    ["rollback", "metadata.deploy", 200],
  ] as const) {
    wiring.registry.registerPath({
      method: "post",
      path: `/admin/v1/metadata/changes/{id}/${action}`,
      tags: ["Admin · Change Sets"],
      description: `${action.charAt(0).toUpperCase()}${action.slice(1)} the Change Set. Requires \`${role}\`.`,
      request: { params: ChangeSetIdParamsSchema },
      responses: {
        [statusCode]: {
          description: action === "simulate" ? "Simulation result." : "Transition outcome.",
          content: {
            "application/json": {
              schema: action === "simulate" ? SimulateResponseSchema : TransitionResponseSchema,
            },
          },
        },
        404: {
          description: "Change Set not found.",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        409: {
          description: "Change Set is in an invalid state for this action.",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        403: {
          description: "Caller lacks the required role.",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    });
  }

  // ── Handlers ─────────────────────────────────────────────────────

  app.post(
    "/admin/v1/metadata/changes",
    {
      schema: {},
      preHandler: [requireRole("metadata.write")],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = parseBody(request, CreateChangeSetBodySchema);
      const r = await wiring.service.create({
        tenantId: request.appContext.tenantId,
        change_set_id: body.change_set_id,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.operations !== undefined ? { operations: body.operations } : {}),
        created_by: request.appContext.userId,
      });
      return Result.match(r, {
        ok: (row) =>
          reply.code(201).send(
            CreateChangeSetResponseSchema.parse({
              change_set_id: row.change_set_id,
              status: row.status,
              created_at: row.created_at.toISOString(),
              operation_count: row.staged_operations.length,
            }),
          ),
        err: (e) => sendErrorReply(reply, e),
      });
    },
  );

  // POST /admin/v1/metadata/changes/{id}/simulate
  app.post(
    "/admin/v1/metadata/changes/:id/simulate",
    {
      schema: {},
      preHandler: [requireRole("metadata.write")],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const params = parseParams(request, ChangeSetIdParamsSchema);
      const r = await wiring.service.simulate(request.appContext.tenantId, params.id);
      return Result.match(r, {
        ok: (out) => reply.code(200).send(SimulateResponseSchema.parse(out)),
        err: (e) => sendErrorReply(reply, e),
      });
    },
  );

  // The four state-machine transitions share a handler shape. Built
  // via a small factory to avoid copy-paste while keeping each route
  // independently registerable + rate-limitable.
  for (const action of ["propose", "approve", "deploy", "rollback"] as const) {
    const role =
      action === "approve"
        ? "metadata.approve"
        : action === "deploy" || action === "rollback"
          ? "metadata.deploy"
          : "metadata.write";

    app.post(
      `/admin/v1/metadata/changes/:id/${action}`,
      {
        schema: {},
        preHandler: [requireRole(role)],
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        const params = parseParams(request, ChangeSetIdParamsSchema);
        const actor: TransitionActor = {
          actor_id: request.appContext.userId,
          roles: request.appContext.userRoles,
        };
        const r = await wiring.service.transition(
          {
            tenantId: request.appContext.tenantId,
            change_set_id: params.id,
            actor,
          },
          action,
        );
        return Result.match(r, {
          ok: (outcome) =>
            reply.code(200).send(
              TransitionResponseSchema.parse({
                change_set_id: params.id,
                from_state: outcome.from_state,
                to_state: outcome.to_state,
                operations_applied: outcome.operations_applied,
                event_id: outcome.event?.event_id ?? null,
              }),
            ),
          err: (e) => sendErrorReply(reply, e),
        });
      },
    );
  }
}

function sendErrorReply(reply: FastifyReply, e: ServiceError): FastifyReply {
  if (e.kind === "not_found") {
    return reply
      .code(404)
      .header("content-type", "application/problem+json")
      .send(
        buildProblem({
          status: 404,
          kind: "not_found",
          detail: `Change Set ${e.change_set_id} does not exist.`,
        }),
      );
  }
  if (e.kind === "already_exists") {
    return reply
      .code(409)
      .header("content-type", "application/problem+json")
      .send(
        buildProblem({
          status: 409,
          kind: "already_exists",
          detail: `Change Set ${e.change_set_id} already exists.`,
        }),
      );
  }
  if (e.kind === "invalid_state_for_operation") {
    return reply
      .code(409)
      .header("content-type", "application/problem+json")
      .send(
        buildProblem({
          status: 409,
          kind: "invalid_state",
          detail: `Change Set is in state '${e.current}'; this action requires '${e.required}'.`,
        }),
      );
  }
  if (e.kind === "transition_error") {
    if (e.cause.kind === "forbidden") {
      return reply
        .code(403)
        .header("content-type", "application/problem+json")
        .send(
          buildProblem({
            status: 403,
            kind: "forbidden",
            detail: `Action '${e.cause.action}' requires role '${e.cause.required_role}'.`,
          }),
        );
    }
    if (e.cause.kind === "invalid_transition") {
      return reply
        .code(409)
        .header("content-type", "application/problem+json")
        .send(
          buildProblem({
            status: 409,
            kind: "invalid_transition",
            detail: `Cannot ${e.cause.action} a Change Set in state '${e.cause.from}'.`,
          }),
        );
    }
    return reply
      .code(409)
      .header("content-type", "application/problem+json")
      .send(
        buildProblem({
          status: 409,
          kind: e.cause.kind,
        }),
      );
  }
  // exhaustiveness — TS will fail here if a new ServiceError variant
  // appears without an arm above.
  const _exhaustive: never = e;
  void _exhaustive;
  return reply
    .code(500)
    .header("content-type", "application/problem+json")
    .send(buildProblem({ status: 500, kind: "internal_error" }));
}
