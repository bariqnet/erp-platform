# Pattern — Writing a Domain Type

CLAUDE.md §2 (Backend) and §5: every domain type is a Zod schema with
its TypeScript type **inferred** from the schema — never declared
separately. One schema definition produces three artifacts:

- runtime validation (at every system boundary),
- the TypeScript type (via `z.infer`),
- the OpenAPI contribution (via `@asteasolutions/zod-to-openapi` at
  the HTTP edge).

Domain types live in [`packages/core`](../../packages/core). That
package's only production dependency is `zod` — CLAUDE.md §7
non-negotiable #1. Anything else is a bug.

## Canonical example — `LocalizedStringSchema`

The smallest real TASK-04 schema is also the most useful to keep
handy: the `{ en, ar, … }` shape used as the `label` field on every
other domain type.

```ts
// packages/core/src/localization.ts
import { z } from "zod";

export const LocalizedStringSchema = z.object({ en: z.string().min(1) }).catchall(z.string());

export type LocalizedString = z.infer<typeof LocalizedStringSchema>;
```

```ts
// packages/core/src/localization.test.ts
import { describe, expect, it } from "vitest";

import { LocalizedStringSchema } from "./localization.js";

describe("LocalizedStringSchema", () => {
  it("requires the en fallback", () => {
    expect(() => LocalizedStringSchema.parse({ ar: "عميل" })).toThrow();
  });

  it("round-trips through JSON", () => {
    const value = { en: "Customer", ar: "عميل", "ar-IQ": "زبون" };
    const parsed = LocalizedStringSchema.parse(
      JSON.parse(JSON.stringify(LocalizedStringSchema.parse(value))),
    );
    expect(parsed).toEqual(value);
  });
});
```

Three conventions this tiny example demonstrates:

1. **Types are inferred.** `z.infer<typeof XSchema>` — never a parallel
   `interface LocalizedString`. They can't drift.
2. **Strictness is explicit.** Here `.catchall(z.string())` allows
   extra locale keys. Where unknown keys are a bug, use `.strict()`
   instead.
3. **Round-trip tests.** `parse → JSON.stringify → JSON.parse → parse`
   returns a structurally-equal value. The test always goes through
   `parse` on both ends so Zod defaults and transforms apply
   symmetrically.

## Bigger example — `EntityBodySchema`

The largest TASK-04 schema, in [`packages/core/src/entity.ts`](../../packages/core/src/entity.ts).
Worth reading in full because it shows cross-field validation:

```ts
export const EntityBodySchema = z
  .object({
    name: EntityNameSchema, // PascalCase primitive
    plural: z.string().min(1).optional(),
    label: LocalizedStringSchema, // { en, ar, … }
    storage: StorageSchema, // { strategy, table? }
    fields: z.array(FieldSchema).min(1), // discriminated union, 15 types
    relationships: z.array(RelationshipSchema).optional(),
    lifecycle: LifecycleSchema.optional(), // states / initial / workflow_id
    indexes: z.array(IndexSchema).optional(),
    permissions_base: ObjectIdSchema.optional(),
    audit: z.boolean().optional(),
    // … plural, icon, description …
  })
  .strict()
  .superRefine((entity, ctx) => {
    // Field names must be unique within an entity.
    // A money field's `currency_field` must refer to an existing sibling.
    // Both are cross-field rules — `.refine` on the outer object.
  });

export type EntityBody = z.infer<typeof EntityBodySchema>;
```

Three patterns this example demonstrates that simple schemas don't:

1. **`.strict()` at the boundary.** Reject unknown top-level keys.
   Silent passthrough of `surprise: true` on a Customer entity is how
   tenants accidentally rely on typos.
2. **`.superRefine` for cross-field rules.** Anywhere a field's
   validity depends on another field (duplicate names, money →
   currency*field reference), superRefine gathers every issue in one
   parse — downstream code sees \_all* problems, not one at a time.
3. **Composition.** `EntityBodySchema` pulls in `FieldSchema`,
   `RelationshipSchema`, `LocalizedStringSchema`, `ObjectIdSchema` —
   each of those is a small, independently-tested primitive.
   Composition over inheritance.

## Discriminated unions

Where a type has variants with different shape — `Field`, `Envelope` —
use `z.discriminatedUnion("<key>", [...])`:

```ts
// packages/core/src/envelope.ts
export const EnvelopeSchema = z.discriminatedUnion("operation", [
  UpsertEnvelopeSchema, // operation: "upsert", body: unknown
  TombstoneEnvelopeSchema, // operation: "tombstone", reason?: string
]);
```

TypeScript narrows on the discriminator at the use site:

```ts
if (envelope.operation === "upsert") {
  doSomething(envelope.body); // body is in scope
} else {
  logTombstone(envelope.reason); // reason is in scope
}
```

Never union unrelated types with `z.union([...])` when they share a
discriminator — the error messages are worse and narrowing isn't as
clean.

## Generic helpers

When a schema has a body whose shape depends on context,
`envelopeWithBody` in [`envelope.ts`](../../packages/core/src/envelope.ts)
shows the pattern: accept a body schema, return an object schema that
slots the body in. Callers get `Envelope<EntityBody>` shape-typed for
free.

## Anti-patterns

- **Declaring `interface Foo {...}` next to `FooSchema`.** The type
  must be `z.infer<typeof FooSchema>`. Anything else drifts.
- **Not using `.strict()` for external input.** Unknown keys silently
  pass through. Bug factory.
- **Using `.passthrough()` "to be permissive."** Same problem as
  above, worse.
- **Using `z.date()` for ISO-string fields you plan to serialize to
  JSON.** Round-trips fail without `.coerce`; the simpler answer is
  `z.string().datetime()` and let downstream converters handle Date
  objects at the boundary that needs them.
- **Cross-field rules as separate `.refine` chains.** Use
  `.superRefine` — it lets a single parse report every issue at once,
  which is what API consumers actually want.

## Verified by

- `@erp/core` has only `zod` in `dependencies`. `scripts/verify.ts`
  doesn't enforce this explicitly yet — candidate for invariant #6
  once there's a second package with the "zero infra deps" contract.
- `pnpm --filter @erp/core test` — 158 tests across 10 files,
  covering every schema in this package including the round-trip and
  superRefine rules.
