# @erp/metadata — Layered Resolution

## Purpose

Implements RFC §3 — the layered resolution algorithm: walk active
layers (L0..L4) for a given `(tenant_id, object_id)`, apply the
correct merge strategy per field, honor tombstones, and surface
conflicts. **Pure functions only** — no I/O.

## Boundaries

**Imports:** `@erp/core` (for the metadata-object types and ports).
Nothing infrastructural.

**Must never import:** `kysely`, `redis`, `fastify`, `fs`, `node:fetch`,
or any other I/O surface. The resolver fetches layer rows via an
injected `MetadataStore` port (declared in `@erp/core`), not directly.

**Exports:** `resolve(tenant, objectId, store)`, the four merge
strategies (`replace`, `merge_object`, `append`, `merge_list_by_key`),
and the conflict types.

## Patterns

- Resolution algorithm matches the RFC §3.2 pseudocode exactly. Any
  divergence is a bug.
- Determinism: same `(tenant_id, object_id, active_layers)` always
  yields the same result. This invariant is property-tested with
  `fast-check` (TASK-06).
- Tombstones halt resolution at the layer they appear; lower layers
  no longer contribute (RFC §3.4).
- Conflicts surface explicitly — the resolver never silently merges
  incompatible types (RFC §3.5).

## Invariants

1. Zero I/O. Anywhere `fetch`, `kysely`, or `redis` appears in this
   package, it is a bug.
2. Resolution is deterministic — verified by `fast-check` property
   tests in TASK-06.
3. Result of resolution is JSON-serializable; the cache keys this on
   `(tenant, object, version)` per RFC §5.3.

## Known gotchas

- `merge_list_by_key` must use the entry's declared key field (e.g.
  `name` for fields, `from+trigger` for transitions). Mis-keying
  silently dedupes the wrong rows.
- This package populates in **TASK-06**. TASK-01 ships only the
  scaffold.
