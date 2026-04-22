// Relationship — a typed connection between Entities (RFC §2.3).
//
//   { "name": "primary_contact",
//     "type": "many_to_one",
//     "target": "ent.contact",
//     "cascade": "nullify" }
//
//   { "name": "invoices",
//     "type": "one_to_many",
//     "target": "ent.invoice",
//     "via": "customer_id" }
//
// Relationships are embedded inside an Entity body; the separate `rel.*`
// object type exists for cases where a relationship is shared across
// entities (Phase 2+, not used yet).

import { z } from "zod";

import { FieldNameSchema } from "./field.js";
import { LocalizedStringSchema } from "./localization.js";
import { ObjectIdSchema } from "./object-id.js";

export const RelationshipTypeSchema = z.enum([
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
]);

export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const CascadeSchema = z.enum(["cascade", "restrict", "nullify", "set_default"]);

export type Cascade = z.infer<typeof CascadeSchema>;

export const RelationshipSchema = z
  .object({
    name: FieldNameSchema,
    type: RelationshipTypeSchema,
    target: ObjectIdSchema,
    /** FK column on the *other* side for one_to_many. Required for one_to_many. */
    via: FieldNameSchema.optional(),
    cascade: CascadeSchema.optional(),
    label: LocalizedStringSchema.optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    deprecated: z.boolean().optional(),
  })
  .strict()
  .superRefine((rel, ctx) => {
    if (rel.type === "one_to_many" && !rel.via) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["via"],
        message:
          "one_to_many relationships must declare `via` (the FK column on the target entity)",
      });
    }
  });

export type Relationship = z.infer<typeof RelationshipSchema>;
