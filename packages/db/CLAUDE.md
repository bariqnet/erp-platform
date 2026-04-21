# @erp/db — Database Layer

## Purpose

The Kysely type-set for the `metadata` and `ops` schemas, the SQL
migration set, and the **`TenantRepository`** base class — every
tenant-scoped repository in the codebase extends it (CLAUDE.md §7
non-negotiable #4 and §9). Direct Kysely against tenant tables is a
bug.

## Boundaries

**Imports:** `@erp/core`, `kysely` (added in TASK-03).

**Must never import:** `fastify`, `redis`. Those are owned by their
respective apps/packages.

**Exports:** Kysely DB types (`type DB = { meta_object: ...; ops_invoice:
...; }`), the `TenantRepository` base, and migration runner glue.

## Patterns

- Every `tenant_id` column is `TEXT NOT NULL`. RLS enabled on every
  tenant-scoped table (RFC §10.1).
- Connections set `app.current_tenant` via `SET LOCAL` at check-out
  (§4.3, RFC §10.1).
- Migrations are forward-only in dev with a documented rollback plan
  in the file header. See `docs/patterns/writing-a-migration.md`
  (populated in TASK-03).
- Indexes are created `CONCURRENTLY` (CLAUDE.md §5).

## Invariants

1. Every tenant-scoped repository class extends `TenantRepository`.
   Enforced by `scripts/verify.ts` invariant #1.
2. Every migration file has a `-- Rollback plan:` header block.
   Enforced by `scripts/verify.ts` invariant #5.
3. All timestamps are `timestamptz`, UTC. Never `timestamp`.
4. All money is `bigint` (integer minor units) paired with a
   `currency_field`. Never `numeric` for money.

## Known gotchas

- This package populates in **TASK-03** (schema + RLS) and grows in
  every later task. TASK-01 ships only the scaffold.
