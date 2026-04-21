# @erp/core — Pure Domain

## Purpose

The metadata-object model, its ports, and its primitives (`Result<T, E>`,
`DomainEvent` envelope, etc.), defined once, reused everywhere. This
package is the *only* place downstream code should look for the shape
of an `Entity`, a `Field`, a `Relationship`, or any other metadata
object type.

## Boundaries

**Must import:** `zod` only. CLAUDE.md §7 non-negotiable #1 pins this.

**Must never import:** anything else. No Fastify, no Kysely, no Redis,
no `fetch`, no `fs`, no Node-specific APIs beyond what Zod itself uses.
No other `@erp/*` package — this one sits at the root of the dependency
graph.

**Exports:** Zod schemas, inferred types (`type X = z.infer<typeof
XSchema>`), ports (TypeScript interfaces with no implementation),
primitive utility types. Nothing that does I/O.

## Patterns

- **Schema first, type inferred.** `export const XSchema = z.object(...)`
  then `export type X = z.infer<typeof XSchema>`. Never declare a type
  and a schema separately.
- **Ports are interfaces.** `export interface EventBus { ... }`. No
  default implementations live here.
- **`Result<T, E>` for expected failures.** `throw` only for truly
  exceptional cases (programming errors, infrastructure outages).
- See `docs/patterns/writing-a-domain-type.md` (populated in TASK-04).

## Invariants

1. Zero runtime dependencies on infrastructure. Only `zod` appears in
   `dependencies`. A PR that adds anything else is a bug.
2. Every schema has a round-trip test: parse → serialize → parse
   returns structurally-equal output. Enforced in TASK-04.
3. No file in this package imports `node:*` modules. Use types only
   from `zod` or local files.
4. No class uses a framework decorator. This code must run in any JS
   runtime, including V8 isolates (the script sandbox uses them).

## Known gotchas

- `verbatimModuleSyntax` means types from other files must be imported
  via `import type { X } from "./x.js"`, and `.js` (not `.ts`)
  extensions are required on relative imports. See
  `packages/config/CLAUDE.md` for the full list of strict-mode quirks.
- This package populates meaningfully in **TASK-04** (domain types) and
  **TASK-05** (Result + EventBus port). The TASK-01 scaffold exports
  nothing yet.
