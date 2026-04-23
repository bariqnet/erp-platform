// materialize() — the RFC §5.2 materialization pipeline.
//
// Given a resolved metadata object (an `ent.*` whose body is an
// EntityBody), produce a MaterializedEntity ready for the Runtime API
// to use: typed-field map, create + patch validators, and a serializer
// stub (currently a pass-through; typed serialization lands with view
// rendering in a later task).
//
// Pure function — zero I/O. Safe to call on every resolve (apps/api
// then caches the result in an LRU keyed on
// `(tenant, entity_id, version)` per RFC §5.3).
//
// This module only understands Entity bodies. Other metadata-object
// types (Workflow, Permission, Localization, …) are materialized by
// their own task-specific materializers that ship alongside them.

import { EntityBodySchema, type EntityBody, type Field } from "@erp/core";
import { type ResolvedObject } from "@erp/metadata";
import { z, type ZodObject, type ZodRawShape } from "zod";

import { zodFromField } from "./field-zod.js";

// ── Types ────────────────────────────────────────────────────────────

export interface MaterializedEntity {
  readonly entity: EntityBody;
  /** The fields by name — fast lookup at request time. */
  readonly fieldsByName: ReadonlyMap<string, Field>;
  /** Zod validator for POST bodies: required fields enforced, strict keys. */
  readonly createValidator: ZodObject<ZodRawShape>;
  /** Zod validator for PATCH bodies: every field optional, strict keys. */
  readonly patchValidator: ZodObject<ZodRawShape>;
}

export interface MaterializeError {
  readonly kind: "not_an_entity" | "invalid_entity_body";
  readonly detail: string;
}

// ── Pipeline ─────────────────────────────────────────────────────────

/**
 * Materialize a resolved object into runtime artifacts. Throws when the
 * resolved body is not a valid EntityBody — resolve() returns the body
 * opaquely as `Record<string, unknown>`, and the Admin API validates
 * each layer's operation body at write time; by the time we're here
 * the shape is trusted. A validation failure here is a programming
 * error (metadata got corrupted after deploy), not a user error.
 */
export function materialize(resolved: ResolvedObject): MaterializedEntity {
  const parsed = EntityBodySchema.safeParse(resolved.body);
  if (!parsed.success) {
    throw new Error(
      `materialize: resolved body for ${resolved.object_id} is not a valid EntityBody — ${parsed.error.message}`,
    );
  }
  return materializeEntity(parsed.data);
}

/**
 * Materialize a pre-validated EntityBody directly. Useful for tests
 * that construct entities without going through the resolver.
 */
export function materializeEntity(entity: EntityBody): MaterializedEntity {
  const fieldsByName = new Map<string, Field>();
  const createShape: ZodRawShape = {};
  const patchShape: ZodRawShape = {};

  for (const field of entity.fields) {
    fieldsByName.set(field.name, field);
    const baseSchema = zodFromField(field);
    createShape[field.name] = baseSchema;
    // Patch mode: every field is optional regardless of `required`.
    patchShape[field.name] = baseSchema.optional();
  }

  return {
    entity,
    fieldsByName,
    createValidator: z.object(createShape).strict(),
    patchValidator: z.object(patchShape).strict(),
  };
}
