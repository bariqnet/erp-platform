// Admin · /admin/v1/templates — L1 Industry Template activation.
//
// TASK-17 · a tenant can activate a template by id + version. After
// activation, the resolver walks `["L0", "L1", "L2"]` (vs the default
// `["L0", "L2"]`) and picks up the template's rows where they exist.
// The Package installer (TASK-18) will call this endpoint post-
// install; for Phase-2 bring-up operators can call it directly.

import { type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { requireRole } from "../../plugins/require-role.js";
import { parseBody } from "../../plugins/zod-validation.js";
import { ActivateTemplateBodySchema, ActivateTemplateResponseSchema } from "../../schemas/admin.js";
import { ProblemSchema, buildProblem } from "../../schemas/error.js";

import type { MetadataObjectRepository } from "@erp/db";
import type { FastifyInstance } from "fastify";

export interface TemplatesRoutesWiring {
  readonly registry: OpenAPIRegistry;
  readonly repo: MetadataObjectRepository;
}

export async function registerTemplatesRoutes(
  app: FastifyInstance,
  wiring: TemplatesRoutesWiring,
): Promise<void> {
  wiring.registry.registerPath({
    method: "post",
    path: "/admin/v1/templates/activate",
    tags: ["Admin · Templates"],
    description:
      "Activate an L1 Industry Template for the caller's tenant. On success, the tenant's resolver picks up L1 rows carrying the chosen `template_id`. Requires `metadata.deploy` (same authority as a metadata deploy, since this flips the resolved view).",
    request: {
      body: { content: { "application/json": { schema: ActivateTemplateBodySchema } } },
    },
    responses: {
      200: {
        description: "Template activated (or re-pinned to a new version).",
        content: { "application/json": { schema: ActivateTemplateResponseSchema } },
      },
      400: {
        description: "Validation error.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  app.post(
    "/admin/v1/templates/activate",
    { schema: {}, preHandler: [requireRole("metadata.deploy")] },
    async (request, reply) => {
      const body = parseBody(request, ActivateTemplateBodySchema);
      const tenantId = request.appContext.tenantId;
      const actor = request.appContext.userId || "unknown";

      try {
        const result = await wiring.repo.activateTemplate({
          tenantId,
          templateId: body.template_id,
          version: body.version,
          activatedBy: actor,
        });
        return reply.code(200).send(
          ActivateTemplateResponseSchema.parse({
            tenant_id: tenantId,
            template_id: result.templateId,
            version: result.version,
            activated_at: new Date().toISOString(),
          }),
        );
      } catch (err) {
        return reply
          .code(500)
          .header("content-type", "application/problem+json")
          .send(
            buildProblem({
              status: 500,
              kind: "activation_failed",
              detail: err instanceof Error ? err.message : "unknown error",
            }),
          );
      }
    },
  );
}
