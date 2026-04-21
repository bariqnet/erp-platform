# @erp/kernel-runtime — Materialization & L1 Cache

## Purpose

Implements the materialization pipeline (RFC §5.2): compile resolved
metadata into runtime artifacts (validators, ORM mappers, serializers)
and cache them in an in-process LRU keyed by
`(tenant, object, version)` per RFC §5.3.

## Boundaries

**Imports:** `@erp/core`, `@erp/metadata`. The Redis L2 cache and the
event-driven invalidation wiring live in `apps/kernel`, not here —
this package is the pure materialization engine, infrastructure-free.

**Exports:** `materialize(resolved)`, `MaterializedEntity` type, the
LRU-cache adapter interface, and the version-keyed cache wrapper.

## Patterns

- Cache keys are version-keyed, never invalidation-based on the hot
  path. New version = new key. Old key ages out via LRU.
- Materialization is idempotent — repeatedly materializing the same
  `(tenant, object, version)` yields the same artifact.

## Invariants

1. No Redis client, no Postgres client, no HTTP server. Those belong
   in `apps/kernel` and `apps/api`.
2. Materialization is deterministic given a resolved metadata object.

## Known gotchas

- This package populates in **TASK-11**. TASK-01 ships only the
  scaffold.
