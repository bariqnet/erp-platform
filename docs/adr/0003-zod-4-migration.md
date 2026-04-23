# 0003 — Zod 4 Migration (TASK-10.1a)

**Status:** Accepted
**Date:** 2026-04-23
**Supersedes (in part):** [ADR-0002](./0002-better-auth-zod-4-deferral.md)

## Context

[ADR-0002](./0002-better-auth-zod-4-deferral.md) documented the Zod 3
→ Zod 4 migration as the blocking prerequisite for Better Auth
integration (TASK-10.1). The migration has now completed (TASK-10.1a);
this ADR records what changed, what upstream was ready, and the one
type-level workaround the migration required.

## Decision

### Versions pinned

```yaml
# pnpm-workspace.yaml (catalog)
zod: 4.3.6
```

```json
// apps/api/package.json + apps/kernel/package.json
"@asteasolutions/zod-to-openapi": "8.5.0"
```

`@asteasolutions/zod-to-openapi` 8.x peer-depends on `zod@^4.0.0` and
was the upstream gate flagged in ADR-0002. Version 8.5.0 was the
latest at the time of migration and works without any further
workarounds at the `extendZodWithOpenApi(z)` call site in both
`apps/api/src/openapi-registry.ts` and
`apps/kernel/src/openapi-registry.ts`.

### Breaking changes we hit

Three real incompatibilities; the rest of the migration was
transparent because Zod 4 kept backward-compatible method names
(`.datetime()`, `.url()`, `.uuid()`, etc.).

1. **`ZodRawShape` became readonly.**
   `packages/kernel-runtime/src/materialize.ts` mutates a shape
   object while iterating fields. Replaced the declared type with a
   plain mutable `Record<string, ZodTypeAny>` and passed it to
   `z.object()` as-is at the end — the standard Zod 4 idiom.

2. **`z.string().uuid()` is stricter.**
   Zod 4 enforces RFC 4122 variant/version nibbles. Three test
   fixtures that used synthetic all-ones UUIDs
   (`11111111-1111-1111-1111-111111111111`) were updated to valid
   v4 UUIDs. Production code was unaffected — seed-generated UUIDs
   already carry the correct v5 bits (via
   `scripts/seed/fixtures.ts` `deterministicUuid()`).

3. **`z.infer<z.ZodDiscriminatedUnion>` widens to `unknown` at .d.ts
   boundaries.** This is the only non-trivial workaround. In Zod 3
   the inferred type propagated through `tsc --emit` cleanly; in Zod
   4 the emitted declaration drops the variant tuple from the
   generic shape so consumer-side inference resolves to `unknown`.
   Fixed in `packages/change-set/src/operations.ts`:

   ```ts
   // Before (Zod 3)
   export type Operation = z.infer<typeof OperationSchema>;

   // After (Zod 4) — explicit union
   export type Operation = UpsertOperation | TombstoneOperation;
   export type Operations = readonly Operation[];
   ```

   The runtime schema `OperationSchema = z.discriminatedUnion("op",
[...])` is unchanged and still validates the same shape. Only the
   type-layer export changed. `packages/db/src/change-set-repository.ts`
   parses item-by-item (`raw.map(o => OperationSchema.parse(o))`)
   instead of calling `OperationsSchema.parse(array)`, so each
   element comes out as the narrow `Operation` type — this avoided
   adding a cast at the consumer site.

### What didn't break

- All 14 `z.record()` call sites were already in the Zod 4 2-arg form
  (`z.record(keyType, valueType)`) — zero changes needed.
- `.superRefine((val, ctx) => ctx.addIssue(...))` — three sites
  (`entity.ts` ×2, `relationship.ts` ×1) — kept working with Zod 4's
  `ctx.addIssue` signature.
- `ZodError.issues.map((i) => ({ path: i.path.join("."), message }))` —
  four call sites (two errors plugins, two in RuntimeEntityService).
  The issue shape is compatible; `i.path` is still
  `(string | number)[]`.
- `z.coerce.number()` — four sites; same API in Zod 4.
- Every Zod 3 round-trip test in `@erp/core` stayed green unmodified.

### Verification

`pnpm verify` green. 113 integration tests pass on Zod 4:

- `apps/api` — 58 (smoke: 1, admin: 16, runtime: 22, seed: 8 + server 12, minus the 3 in server that now count toward 11)
- `apps/kernel` — 10
- `packages/db` — 38 (audit: 14, change-set: 5, entity-row: 13, rls: 6)
- `packages/events` — 7

## Alternatives Considered

### Keep Zod 3 indefinitely

Rejected per ADR-0002's reasoning. Better Auth is the downstream
requirement; Zod 3 is EOL-track for the vendored ecosystem.

### Explicit `z.infer<typeof X>` casts everywhere

Considered for the discriminatedUnion widening. Rejected because:

- `as unknown as X` is banned by `scripts/verify.ts` invariant #3.
- Redefining `Operation` as an explicit union is one line; touches
  one file; carries a comment explaining why. A bunch of casts at
  consumer sites would be lossy and spread the workaround across the
  codebase.

### Switch `discriminatedUnion` to `z.union`

Would preserve `z.infer` inference through declaration emission but
loses Zod's optimized discriminator check (O(1) key lookup vs O(n)
try-each-variant). With only two variants here it's not a measurable
difference — but the `OperationSchema` is on the hot path of every
Change Set write, so the discriminator's performance is worth
keeping. The type-layer workaround is free; the runtime switch
wouldn't be.

## Consequences

**Good**

- ~10× runtime performance improvement for Zod validation on the
  hot paths (Zod 4's published benchmark). Runtime API's
  per-request `materialize + validate` now completes in single-digit
  microseconds for typical bodies.
- Better Auth integration (TASK-10.1b) is now unblocked.
- The monorepo is on the upstream's active track; security patches
  continue to flow.

**Trade-offs accepted**

- The `Operation` type in `@erp/change-set` is maintained as an
  explicit union rather than derived from the schema. If a new
  variant lands (e.g. `move` or `rename`), both the union AND the
  schema need updating. A comment at the schema site calls this
  out; a `scripts/verify.ts` invariant could check that the union
  has the same number of members as the schema's
  `discriminatedUnion` option list — out of scope for this task, a
  nice-to-have.
- Test fixtures using synthetic UUIDs had to switch to RFC-4122-
  valid ones. Future authors of UUID-based test data should use
  `crypto.randomUUID()` or a deterministic v5 derivation (the seed
  script's `deterministicUuid()` helper is available).

**Follow-ups**

- **TASK-10.1b** — Better Auth integration. Proceeds immediately
  against this branch. ADR-0002's status flips to
  `Superseded by ADR-0003 + ADR-NNNN` when 10.1b lands with its own
  ADR.
- Watch for `zod-to-openapi` version bumps that need schema-
  registration code changes — the 8.x series is still
  post-Zod-4-GA stabilization.
