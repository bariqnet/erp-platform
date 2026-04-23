// Change Set operations — the per-op payload a draft accumulates in
// `meta_change_set.staged_operations` until deploy.
//
// Two variants:
//
//   upsert     — insert a new meta_object row on deploy; flip the prior
//                active row's valid_until + superseded_by_change_set_id.
//   tombstone  — insert a tombstone meta_object row on deploy; flip the
//                prior active row's valid_until (there is nothing lower
//                to revert to — resolution just halts).
//
// Schemas are Zod-discriminated on `op`. Types are inferred via
// `z.infer` per the house pattern.

import { LayerSchema, MergeStrategySchema, ObjectIdSchema, ObjectTypeSchema } from "@erp/core";
import { z } from "zod";

// ── Upsert ────────────────────────────────────────────────────────────

export const UpsertOperationSchema = z
  .object({
    op: z.literal("upsert"),
    object_id: ObjectIdSchema,
    object_type: ObjectTypeSchema,
    layer: LayerSchema,
    body: z.record(z.string(), z.unknown()),
    merge_strategy: MergeStrategySchema.optional(),
    /** Required when merge_strategy === "merge_list_by_key". */
    key_field: z.string().optional(),
  })
  .strict();

export type UpsertOperation = z.infer<typeof UpsertOperationSchema>;

// ── Tombstone ─────────────────────────────────────────────────────────

export const TombstoneOperationSchema = z
  .object({
    op: z.literal("tombstone"),
    object_id: ObjectIdSchema,
    layer: LayerSchema,
    /** Free-text reason surfaced in audit log and admin UI. */
    reason: z.string().optional(),
  })
  .strict();

export type TombstoneOperation = z.infer<typeof TombstoneOperationSchema>;

// ── Discriminated union ───────────────────────────────────────────────

export const OperationSchema = z.discriminatedUnion("op", [
  UpsertOperationSchema,
  TombstoneOperationSchema,
]);

// Zod 4's inferred type for `z.discriminatedUnion(...)` widens to
// `unknown` at `.d.ts` boundaries — the emitted declaration drops the
// variants from the generic shape and tsc can't recover them at the
// consumer side. Declaring the Operation type explicitly here
// preserves the narrow `{ op: "upsert"; ... } | { op: "tombstone"; ...}`
// shape for every downstream consumer (@erp/db, apps/api). The
// runtime schema (OperationSchema) still validates the same
// discriminated shape — this is a type-layer workaround only.
export type Operation = UpsertOperation | TombstoneOperation;

export const OperationsSchema = z.array(OperationSchema);

export type Operations = readonly Operation[];
