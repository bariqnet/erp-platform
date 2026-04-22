# 0001 — Metadata Schema Shape

**Status:** Accepted
**Date:** 2026-04-22

## Context

The Customization Platform needs a persistence layer that can

- store metadata for every tenant, every layer (L0–L4), every version,
- serve "currently active row per tenant/object" lookups in sub-millisecond
  steady state (RFC §12, p99 < 0.5 ms at the L1 cache),
- support O(1) rollback by pointer flip (CLAUDE.md §7 non-negotiable #7),
- prevent cross-tenant data leaks even when the application user is
  unconstrained (CLAUDE.md §9 — "the one thing we must not get wrong"),
- keep an immutable, hash-chained audit trail of every change
  (RFC §13.2).

RFC §4.1 already specifies the DDL for four tables. This ADR records the
non-DDL decisions: schema naming, the application role, RLS semantics,
and the CI/dev tooling that keeps the schema honest.

## Decision

### 1. Tables live in a dedicated `metadata` schema (`metadata.meta_*`)

RFC §1.3 separates `metadata`, `ops`, and `analytics` schemas.
RFC §4.1 names tables with a `meta_` prefix. We honor both —
`metadata.meta_object`, `metadata.meta_change_set`, etc. The prefix is
redundant _within_ the schema but useful in queries that join across
schemas (reporting, analytics CDC) where bare `object` would collide
with tenant entity tables.

### 2. A non-superuser role `erp_app` is created by the migration

Postgres superusers **unconditionally bypass RLS**, even when tables
are marked `FORCE ROW LEVEL SECURITY`. The dev compose stack creates
the `erp` user via `POSTGRES_USER`, which makes it a superuser. If the
application connects as `erp`, the policies never fire and the "cross-
tenant leak" class of bug becomes invisible in dev, impossible to
regression-test.

The migration creates `erp_app` (`NOLOGIN NOSUPERUSER NOBYPASSRLS
INHERIT`) and grants it CRUD on every metadata table. Every
tenant-scoped code path calls `withTenantContext(db, tenantId, fn)`,
which opens a transaction and issues `SET LOCAL ROLE erp_app` before
running the body. In production the connecting user _is_ `erp_app` and
the `SET LOCAL ROLE` is a no-op; in dev it demotes the superuser
session so RLS policies fire exactly as they will in prod.

### 3. RLS policies use `current_setting('app.current_tenant', true)`

The second argument (`missing_ok`) returns `NULL` when the GUC is
unset, so a connection without a tenant context sees:

- **rows where `tenant_id IS NULL`** — i.e. L0/L1 vendor-global data on
  `meta_object` and vendor-level entries on `meta_audit_log`;
- **no rows at all** on `meta_change_set` and `meta_layer_activation`
  (both have `tenant_id NOT NULL`, so the comparison against NULL is
  NULL → filtered).

The `WITH CHECK` clause mirrors `USING`, so an application cannot
write a row whose `tenant_id` does not match its GUC. That is defense
against the "write to another tenant" class of bug the way RLS guards
against the "read from another tenant" class.

### 4. `meta_object` is immutable-versioned

Every change to an object creates a new row. The prior row has its
`valid_until` set to the new `valid_from`. Rollback is a pointer flip:
set `valid_until` back to NULL on the prior row and mark the current
row as superseded. No row is ever UPDATEd except for `valid_until`
pointers and the deploy-state housekeeping in `meta_change_set`.

This is what lets RFC §5.3's cache be **version-keyed rather than
invalidation-based**: the cache key includes the metadata version, so
a new deploy creates a new key, and old readers continue to hit the
old key until they themselves advance.

### 5. Migrations run through the Kysely Migrator with a SQL-file provider

CLAUDE.md §2 pins "plain SQL files, versioned." The SQL file format is

```
-- Rollback plan: …
-- +migrate up
<DDL>
-- +migrate down
<reverse DDL>
```

The `-- Rollback plan:` header is enforced by `scripts/verify.ts`
invariant #5; the `+migrate up` / `+migrate down` markers are parsed
by `packages/db/src/migrator.ts`. Idempotency is delegated to Kysely —
it keeps a `kysely_migration` table that records every applied file,
so `pnpm db:migrate` is safe to re-run.

### 6. Integration tests exercise RLS against real Postgres, not mocks

Two test files under `packages/db/test/integration/`:

- `migrator.integration.test.ts` — applies, no-ops on re-apply, rolls
  back and re-applies cleanly.
- `rls.integration.test.ts` — six tests proving tenant A cannot read
  or write tenant B's data, and that L0 rows are visible to every
  tenant.

Both spin up a fresh Postgres 16 container via Testcontainers. Runs
via `pnpm test:integration`, excluded from `pnpm test` / `pnpm verify`
so the every-commit loop stays fast.

## Alternatives Considered

### Schema per tenant

Each tenant gets its own Postgres schema (e.g. `t_4f8a3c.meta_object`).
Rejected because:

- migrations would have to iterate over every tenant schema, turning a
  one-minute DDL deploy into an hour-long rolling upgrade;
- the resolver would need dynamic SQL against a per-tenant schema
  name, defeating query-plan caching;
- cross-tenant audit and vendor-level operations need an admin plane
  that works _against_ the partition, which defeats the point of
  schema-per-tenant isolation.

RLS + `tenant_id` columns solve the isolation problem without those
costs.

### Database per tenant

Even stronger isolation, same problems as schema-per-tenant plus
connection-pool fragmentation and backup sprawl. Considered only for
regulated-industry tenants as a Phase 4+ opt-in add-on; not the
default.

### Store metadata in a document DB (Mongo, DynamoDB)

Rejected. Immutable-versioning, hash-chained audit, and atomic
multi-object deploys (RFC §9.3) all lean heavily on ACID transactions.
Postgres already owns the operational data; one database, two schemas
is simpler than two engines.

### Write migrations as Kysely TS modules instead of SQL files

Rejected. Kysely's TS builder is great for day-to-day queries, not so
great for CREATE POLICY, ALTER TABLE ENABLE RLS, or PL/pgSQL DO blocks
(like the erp_app role creation). SQL files are also what DBAs read
during incident review. The custom provider hands raw SQL to Kysely's
`sql.raw().execute(db)` so the migrator runs it inside the same
transaction-tracking machinery as JS migrations would.

## Consequences

**Good**

- One consistent API (`withTenantContext`) for every tenant-scoped
  query. No repository method escapes without naming a tenant.
- RLS is actually exercised in dev because `erp_app` is enforced via
  `SET LOCAL ROLE`, not assumed.
- Rolling back a metadata change is a pointer flip, not a data
  restore.
- The migration stays replay-able — dev reset loop is
  `docker compose down -v && up -d && pnpm db:migrate`.

**Trade-offs accepted**

- Every tenant-scoped query pays a two-statement overhead at
  transaction start (SET LOCAL ROLE + set_config). Measured at ~0.3 ms
  on the compose stack, dominated by connection check-out rather than
  the SETs themselves. SLO budget in RFC §12 is 5 ms for a simple
  entity read, so this is fine.
- The `erp` superuser is not subject to RLS even via `FORCE`. Any
  runbook that connects as `erp` (rare — emergency-only) must carry
  an explicit warning.
- Kysely's Migrator uses lex order. Migration filenames MUST begin
  with a zero-padded sequence number (`0001_…`, `0002_…`). A
  `scripts/verify.ts` invariant for this would be cheap to add —
  deferred until we have the second migration.

**Follow-ups**

- `TenantRepository` base class lands in TASK-04/05 alongside the
  first repository. It wraps `withTenantContext` so every method
  inherits it automatically.
- An append-only trigger on `meta_audit_log` (reject UPDATE/DELETE)
  lands when the first write to the audit log is implemented — no
  reason to trigger-guard an empty table.
- A `scripts/verify.ts` invariant #6 rejecting unsequenced migration
  filenames is cheap and worth adding when the second migration
  ships.
