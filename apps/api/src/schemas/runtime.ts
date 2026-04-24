// Zod schemas for the Runtime API routes.
//
// Request/response envelopes are uniform; the per-entity row body is
// validated by the derived Zod schema inside RuntimeEntityService
// (the shape is known only at resolve time, not at route-declaration
// time), so the schema at this layer accepts an open JSON body and
// forwards it. The service returns a `validation_error` Result.err
// when the body fails the materialized validator.

import { ObjectIdSchema } from "@erp/core";
import { z } from "zod";

// ── Params ───────────────────────────────────────────────────────────

export const EntityParamsSchema = z
  .object({
    entity: ObjectIdSchema,
  })
  .strict();

export type EntityParams = z.infer<typeof EntityParamsSchema>;

export const EntityRowParamsSchema = z
  .object({
    entity: ObjectIdSchema,
    id: z.string().uuid(),
  })
  .strict();

export type EntityRowParams = z.infer<typeof EntityRowParamsSchema>;

// ── Query ────────────────────────────────────────────────────────────

export const ListEntityRowsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export type ListEntityRowsQuery = z.infer<typeof ListEntityRowsQuerySchema>;

// ── Bodies ───────────────────────────────────────────────────────────

// Accept any JSON object. The service's materialized validator does
// the real validation.
export const EntityRowBodySchema = z.record(z.string(), z.unknown());

// ── Responses ────────────────────────────────────────────────────────

export const EntityRowResponseSchema = z
  .object({
    row_id: z.string().uuid(),
    entity_id: ObjectIdSchema,
    body: z.record(z.string(), z.unknown()),
    status: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    created_by: z.string().nullable(),
    updated_by: z.string().nullable(),
  })
  .strict();

export type EntityRowResponse = z.infer<typeof EntityRowResponseSchema>;

export const EntityRowListResponseSchema = z
  .object({
    items: z.array(EntityRowResponseSchema),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .strict();

export type EntityRowListResponse = z.infer<typeof EntityRowListResponseSchema>;

export const DeleteResponseSchema = z.object({ deleted: z.literal(true) }).strict();

// ── TASK-15 · actions endpoint ───────────────────────────────────────
// POST /v1/:entity/:id/actions/:action — transitions a row via a
// declared lifecycle action. The action segment is a bare identifier
// (letters, digits, underscore); the service resolves it against the
// entity's LifecycleSchema.transitions array.

export const EntityActionParamsSchema = z
  .object({
    entity: ObjectIdSchema,
    id: z.string().uuid(),
    action: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, {
        message: "action must match `[a-z][a-z0-9_]*`",
      }),
  })
  .strict();

export type EntityActionParams = z.infer<typeof EntityActionParamsSchema>;
