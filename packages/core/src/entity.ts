// Entity — the biggest RFC §2.3 type. This is what ships in the `body`
// of a meta_object row when `object_type = 'Entity'`.
//
// An EntityBody describes a Customer, Invoice, Product, etc. — its name,
// label, storage strategy, fields, relationships, lifecycle, indexes,
// permissions baseline, and audit flag.

import { z } from "zod";

import { FieldNameSchema, FieldSchema } from "./field.js";
import { LocalizedStringSchema } from "./localization.js";
import { ObjectIdSchema } from "./object-id.js";
import { RelationshipSchema } from "./relationship.js";

// ── Naming ──────────────────────────────────────────────────────────────

/** Entity name — PascalCase. Matches the JSON Schema in RFC Appendix A. */
export const EntityNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Za-z0-9_]*$/, {
    message: "entity name must be PascalCase: [A-Z][A-Za-z0-9_]*",
  });

// ── Storage strategy (RFC §4.2) ────────────────────────────────────────

export const StorageStrategySchema = z.enum(["native", "hybrid", "jsonb", "side_table"]);

export type StorageStrategy = z.infer<typeof StorageStrategySchema>;

export const StorageSchema = z
  .object({
    /** Backing table name. Optional — the kernel picks one if absent. */
    table: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    strategy: StorageStrategySchema,
  })
  .strict();

export type Storage = z.infer<typeof StorageSchema>;

// ── Lifecycle (embedded state-list + optional workflow reference) ──────

export const LifecycleSchema = z
  .object({
    states: z.array(z.string().min(1)).min(1),
    initial: z.string().min(1),
    workflow_id: ObjectIdSchema.optional(),
  })
  .strict()
  .superRefine((lc, ctx) => {
    if (!lc.states.includes(lc.initial)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initial"],
        message: `initial state "${lc.initial}" must appear in states`,
      });
    }
  });

export type Lifecycle = z.infer<typeof LifecycleSchema>;

// ── Index definition ───────────────────────────────────────────────────

export const IndexSchema = z
  .object({
    fields: z.array(FieldNameSchema).min(1),
    unique: z.boolean().optional(),
    /** Partial-index predicate, raw SQL. */
    where: z.string().optional(),
  })
  .strict();

export type Index = z.infer<typeof IndexSchema>;

// ── Entity body ────────────────────────────────────────────────────────

export const EntityBodySchema = z
  .object({
    name: EntityNameSchema,
    plural: z.string().min(1).optional(),
    label: LocalizedStringSchema,
    icon: z.string().optional(),
    description: z.string().optional(),
    storage: StorageSchema,
    fields: z.array(FieldSchema).min(1),
    relationships: z.array(RelationshipSchema).optional(),
    lifecycle: LifecycleSchema.optional(),
    indexes: z.array(IndexSchema).optional(),
    permissions_base: ObjectIdSchema.optional(),
    audit: z.boolean().optional(),
  })
  .strict()
  .superRefine((entity, ctx) => {
    // Field names must be unique within an entity.
    const names = entity.fields.map((f) => f.name);
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields"],
          message: `duplicate field name "${n}"`,
        });
        break;
      }
      seen.add(n);
    }

    // A money field's currency_field must refer to an existing sibling.
    for (const f of entity.fields) {
      if (f.type === "money" && !names.includes(f.currency_field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields"],
          message:
            `money field "${f.name}" references currency_field "${f.currency_field}" ` +
            `which is not declared on this entity`,
        });
      }
    }
  });

export type EntityBody = z.infer<typeof EntityBodySchema>;
