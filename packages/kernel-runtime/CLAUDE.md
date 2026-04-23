# @erp/kernel-runtime — Materialization & L1 Cache

## Purpose

Implements the materialization pipeline (RFC §5.2): compile resolved
metadata into runtime artifacts (typed-field map, Zod validators,
eventually serializers) and cache them in an in-process LRU keyed by
`(tenant, object, version)` per RFC §5.3.

Populated in **TASK-12** alongside the Runtime API. Every
`apps/api` Runtime request goes:

```
resolve(MetadataStore)          @erp/metadata
    → materialize(resolved)     this package
    → createValidator / patchValidator.parse(body)
    → EntityRowRepository.{list, get, create, patch, softDelete}
```

## Boundaries

**Imports:** `@erp/core`, `@erp/metadata`, `zod`. Nothing
infrastructural.

**Must never import:** `kysely`, `fastify`, `redis`, `@erp/db`,
`@erp/events`, `@erp/telemetry` — pure package, zero I/O. The cache
adapters and the outbox-driven invalidation wiring live in the apps
that consume it, not here.

**Exports:** `materialize(resolved)` + `materializeEntity(entity)`,
`zodFromField(field)`, `MaterializedEntity` type,
`MaterializedEntityCache` (version-keyed LRU).

## Patterns

- **Schema-first per-field validation** — `zodFromField(field)`
  switches on the 15 `Field` variants (string, localized_string,
  integer, decimal, money, boolean, date, datetime, enum, reference,
  attachment, formula, json, phone, national_id). Required fields
  become non-nullable; non-required fields carry `.optional()`.
- **Two validators per entity** — `createValidator` enforces
  `required` on every field; `patchValidator` makes every field
  optional (PATCH semantics). Both are `.strict()` — unknown keys
  fail fast so tenants can't smuggle in fields the metadata doesn't
  declare.
- **Version-keyed cache** — `MaterializedEntityCache` stores by
  `(tenant, entity, version)`. Apps that use it derive the version
  from the resolver's full provenance stack, not `max(version)` —
  see `apps/api/src/services/runtime-entity-service.ts` for the
  provenance-hash approach.
- **Idempotent + deterministic** — repeatedly materializing the same
  resolved input yields the same validator set. Safe to call on
  every request; the cache is an optimization.

## Invariants

1. No Redis client, no Postgres client, no HTTP server. Those
   belong in `apps/kernel` and `apps/api`.
2. Materialization is deterministic given a resolved metadata object.
3. Unknown keys in bodies fail the `.strict()` validator.
4. Phase-1 storage strategies the Runtime API supports are `jsonb`
   and `hybrid`. The `native` + `side_table` strategies parse fine
   at the metadata layer but Runtime writes are refused with 501
   upstream; enforcement lives in the consumer (`RuntimeEntityService`).

## Known gotchas

- `zodFromField` for `money` validates integer minor units only —
  the paired `currency` field is a *sibling* and is validated via
  its own `zodFromField` call. Cross-field invariants (e.g. "currency
  must be a 3-letter ISO code when present") land with the Workflow
  engine's custom-formula hook in Phase 2.
- `localized_string` validates against `{[lowercaseIsoCode]: string}`.
  `max_length` on the field bounds each value.
- `formula` and `json` pass through as `z.unknown()` in Phase 1 —
  tightening requires an expression parser (formula) or a JSON
  Schema parser (json) neither of which the pure package pulls in.
