// Zod schemas for the Admin API (RFC §9.1). Each schema is registered
// in the OpenAPI registry and parsed in the route handler.

import { OperationsSchema } from "@erp/change-set";
import { ChangeSetStatusSchema, LayerSchema, ObjectIdSchema, ObjectTypeSchema } from "@erp/core";
import { z } from "zod";

// ── Metadata objects ────────────────────────────────────────────────

export const MetaObjectRowSchema = z
  .object({
    object_pk: z.string(),
    object_id: z.string(),
    object_type: z.string(),
    layer: LayerSchema,
    tenant_id: z.string().nullable(),
    template_id: z.string().nullable(),
    version: z.number().int().min(1),
    operation: z.enum(["upsert", "tombstone"]),
    body: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string().datetime(),
    created_by: z.string(),
    created_via: z.string(),
    change_set_id: z.string(),
    valid_from: z.string().datetime(),
    valid_until: z.string().datetime().nullable(),
    superseded_by_change_set_id: z.string().nullable(),
  })
  .strict();

export type MetaObjectRowDto = z.infer<typeof MetaObjectRowSchema>;

export const ListObjectsQuerySchema = z
  .object({
    type: ObjectTypeSchema.optional(),
    layer: LayerSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export const ListObjectsResponseSchema = z
  .object({
    items: z.array(MetaObjectRowSchema),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .strict();

export const ObjectIdParamsSchema = z.object({ id: ObjectIdSchema }).strict();

export const ResolvedObjectResponseSchema = z
  .object({
    object_id: ObjectIdSchema,
    body: z.record(z.string(), z.unknown()),
    provenance: z.array(
      z.object({
        layer: LayerSchema,
        version: z.number().int().min(1),
        object_id: z.string(),
      }),
    ),
  })
  .strict();

export const HistoryResponseSchema = z
  .object({
    items: z.array(MetaObjectRowSchema),
  })
  .strict();

// ── Change Sets ─────────────────────────────────────────────────────

export const CreateChangeSetBodySchema = z
  .object({
    change_set_id: z.string().min(3).max(64),
    description: z.string().max(2000).optional(),
    operations: OperationsSchema.optional(),
  })
  .strict();

export const CreateChangeSetResponseSchema = z
  .object({
    change_set_id: z.string(),
    status: ChangeSetStatusSchema,
    created_at: z.string().datetime(),
    operation_count: z.number().int().nonnegative(),
  })
  .strict();

export const ChangeSetIdParamsSchema = z.object({ id: z.string() }).strict();

export const TransitionResponseSchema = z
  .object({
    change_set_id: z.string(),
    from_state: ChangeSetStatusSchema,
    to_state: ChangeSetStatusSchema,
    operations_applied: z.number().int().nonnegative(),
    event_id: z.string().nullable(),
  })
  .strict();

export const SimulateResponseSchema = z
  .object({
    change_set_id: z.string(),
    operation_count: z.number().int().nonnegative(),
    affected_objects: z.array(
      z.object({
        object_id: ObjectIdSchema,
        layer: LayerSchema,
        op: z.enum(["upsert", "tombstone"]),
      }),
    ),
    notes: z.array(z.string()),
  })
  .strict();

// ── TASK-21 · read-only Config Studio views ────────────────────────

export const ListChangeSetsQuerySchema = z
  .object({
    status: ChangeSetStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const ChangeSetSummarySchema = z
  .object({
    change_set_id: z.string(),
    status: ChangeSetStatusSchema,
    description: z.string().nullable(),
    created_by: z.string().nullable(),
    created_at: z.string().datetime(),
    approved_by: z.string().nullable(),
    approved_at: z.string().datetime().nullable(),
    deployed_at: z.string().datetime().nullable(),
    operation_count: z.number().int().nonnegative(),
  })
  .strict();

export const ListChangeSetsResponseSchema = z
  .object({
    items: z.array(ChangeSetSummarySchema),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .strict();

export const ChangeSetDetailResponseSchema = ChangeSetSummarySchema.extend({
  operations: z.array(z.record(z.string(), z.unknown())),
}).strict();

// ── TASK-17 · template activation ──────────────────────────────────

export const ActivateTemplateBodySchema = z
  .object({
    template_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^tpl\.[a-z][a-z0-9_]*$/, {
        message: "template_id must match `tpl.<segment>`",
      }),
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$/, {
        message: "version must look like semver (1.2.3 or 1.2.3-rc1)",
      }),
  })
  .strict();

export const ActivateTemplateResponseSchema = z
  .object({
    tenant_id: z.string(),
    template_id: z.string(),
    version: z.string(),
    activated_at: z.string().datetime(),
  })
  .strict();
