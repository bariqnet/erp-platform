# Pattern — Writing a Domain Type

> **Status:** Stub. Populated by **TASK-04** (Entity, Field,
> Relationship, Permission, Localization, Envelope).

## Problem

CLAUDE.md §2 (Backend) and §5: every domain type is a Zod schema with
its TypeScript type _inferred_ from the schema — never declared
separately. One definition produces three artifacts: runtime
validation, the TS type, and the OpenAPI contribution.

## Skeleton

```ts
// packages/core/src/foo.ts
import { z } from "zod";

export const FooSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
  })
  .strict();

export type Foo = z.infer<typeof FooSchema>;
```

```ts
// packages/core/test/foo.test.ts
import { describe, expect, it } from "vitest";

import { FooSchema } from "../src/foo.js";

describe("FooSchema", () => {
  it("round-trips", () => {
    const example = { id: "f_1", name: "demo" };
    const parsed = FooSchema.parse(example);
    expect(FooSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});
```

The full set — including `.strict()` to reject unknown keys, the
`Envelope` shared base, the discriminated unions used for object
types — is exemplified when TASK-04 lands.

## Anti-patterns

- Declaring an `interface Foo {...}` next to a `FooSchema`. The type
  must be `z.infer<typeof FooSchema>`. Anything else means they can
  drift.
- Using `z.object({...})` without `.strict()` for external input.
  Unknown keys silently pass through.
- Using `.passthrough()` to be "permissive." That's a bug factory.
