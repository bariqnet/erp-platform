// Envelope — the shared metadata wrapper from RFC §2.1. Every metadata
// object carries these fields regardless of its type; the `body` (or its
// absence for tombstones) is what varies.
//
// This file exposes three things:
//
//   EnvelopeSchema              — discriminated union over `operation`.
//                                 Covers both upsert and tombstone in one
//                                 type; downstream code narrows as needed.
//
//   UpsertEnvelopeSchema        — just the upsert variant, body: unknown.
//   TombstoneEnvelopeSchema     — just the tombstone variant.
//
//   envelopeWithBody<T>(schema) — a builder that returns an upsert-envelope
//                                 schema with a typed body, so code can say
//                                 `envelopeWithBody(EntityBodySchema)` and
//                                 get `Envelope<EntityBody>` for free.

import { z } from "zod";

import { LayerSchema } from "./layer.js";
import { ObjectIdSchema } from "./object-id.js";
import { ObjectTypeSchema } from "./object-type.js";

// ── Base — common to both operations ──────────────────────────────────

const EnvelopeBaseShape = {
  object_id: ObjectIdSchema,
  object_type: ObjectTypeSchema,
  layer: LayerSchema,
  /** null for L0/L1 (vendor-global) rows; non-null for L2+. Not enforced by
   *  the schema — the DB constraint + application logic carry that. */
  tenant_id: z.string().nullable(),
  /** Non-null only for L1 rows (industry template ID). */
  template_id: z.string().nullable(),
  version: z.number().int().min(1),
  valid_from: z.string().datetime(),
  valid_until: z.string().datetime().nullable(),
  created_by: z.string().min(1),
  created_via: z.string().min(1),
  change_set_id: z.string().min(1),
} as const;

const EnvelopeBaseSchema = z.object(EnvelopeBaseShape);

// ── Upsert envelope ───────────────────────────────────────────────────

export const UpsertEnvelopeSchema = EnvelopeBaseSchema.extend({
  operation: z.literal("upsert"),
  body: z.unknown(),
}).strict();

export type UpsertEnvelope<Body = unknown> = Omit<z.infer<typeof UpsertEnvelopeSchema>, "body"> & {
  body: Body;
};

// ── Tombstone envelope ────────────────────────────────────────────────

export const TombstoneEnvelopeSchema = EnvelopeBaseSchema.extend({
  operation: z.literal("tombstone"),
  /** Why this object was tombstoned. Required-in-practice; schema-optional so
   *  legacy tombstones imported without a reason don't fail to parse. */
  reason: z.string().optional(),
  /** Tombstones carry no body. `null` allowed explicitly, so the DB's nullable
   *  body column round-trips cleanly. */
  body: z.null().optional(),
}).strict();

export type TombstoneEnvelope = z.infer<typeof TombstoneEnvelopeSchema>;

// ── Discriminated union ───────────────────────────────────────────────

export const EnvelopeSchema = z.discriminatedUnion("operation", [
  UpsertEnvelopeSchema,
  TombstoneEnvelopeSchema,
]);

export type Envelope = z.infer<typeof EnvelopeSchema>;

// ── Typed-body helper ─────────────────────────────────────────────────

/**
 * Build an upsert-envelope schema whose `body` is typed by `bodySchema`.
 *
 *   const EntityEnvelopeSchema = envelopeWithBody(EntityBodySchema);
 *   const parsed = EntityEnvelopeSchema.parse(incomingObject);
 *   parsed.body.name; // fully-typed as EntityBody["name"]
 */
export function envelopeWithBody<T extends z.ZodTypeAny>(
  bodySchema: T,
): z.ZodObject<
  typeof EnvelopeBaseShape & {
    operation: z.ZodLiteral<"upsert">;
    body: T;
  }
> {
  return EnvelopeBaseSchema.extend({
    operation: z.literal("upsert"),
    body: bodySchema,
  }) as z.ZodObject<
    typeof EnvelopeBaseShape & {
      operation: z.ZodLiteral<"upsert">;
      body: T;
    }
  >;
}
