// Permission — the body of a `prm.*` metadata object. The Permission Gate
// (RFC §13.1) evaluates role-based entity, field, and record-level grants
// on every operation. This file ships the data shape; the evaluator lives
// in @erp/api (`src/plugins/auth` + permission middleware).

import { z } from "zod";

import { FieldNameSchema } from "./field.js";
import { LocalizedStringSchema } from "./localization.js";
import { ObjectIdSchema } from "./object-id.js";

// ── Grantable actions ─────────────────────────────────────────────────
// The set of verbs a role can be granted on an entity. `approve`,
// `reject`, `submit` are workflow-transition verbs; `export` is a
// coarse-grained bulk-read guard.

export const GrantActionSchema = z.enum([
  "read",
  "create",
  "update",
  "delete",
  "approve",
  "reject",
  "submit",
  "export",
]);

export type GrantAction = z.infer<typeof GrantActionSchema>;

// ── Entity-level grants ───────────────────────────────────────────────
// `entity_grants[ent.purchase_order] = ["read", "approve"]` reads as
// "this role can read POs and approve them" (field-level grants may
// further restrict which columns).

export const EntityGrantsSchema = z.record(ObjectIdSchema, z.array(GrantActionSchema));

export type EntityGrants = z.infer<typeof EntityGrantsSchema>;

// ── Field-level grants ────────────────────────────────────────────────
// Per-entity, per-field action list. Missing entries fall through to the
// entity grant; explicit empty array = deny.

export const FieldGrantsSchema = z.record(
  ObjectIdSchema,
  z.record(FieldNameSchema, z.array(GrantActionSchema)),
);

export type FieldGrants = z.infer<typeof FieldGrantsSchema>;

// ── Permission body ───────────────────────────────────────────────────

export const PermissionBodySchema = z
  .object({
    role_id: ObjectIdSchema,
    label: LocalizedStringSchema.optional(),
    description: z.string().optional(),
    entity_grants: EntityGrantsSchema.optional(),
    field_grants: FieldGrantsSchema.optional(),
    /** Expression compiled into a SQL WHERE clause; record-level filter. */
    record_predicate: z.string().optional(),
    /** If the entity declares an `owner_field`, grant implicit access to the
     *  row's owner. */
    implicit_owner: z.boolean().optional(),
    /** Inherit from another permission object. */
    inherits_from: z.array(ObjectIdSchema).optional(),
  })
  .strict();

export type PermissionBody = z.infer<typeof PermissionBodySchema>;
