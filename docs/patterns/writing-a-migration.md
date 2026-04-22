# Pattern — Writing a Database Migration

CLAUDE.md §5: migrations are forward-only in dev with a documented
rollback plan in the file's header comment. Indexes are created
`CONCURRENTLY` to never block writes. All timestamps are
`timestamptz` UTC. All money is integer minor units paired with a
`currency_field`.

`scripts/verify.ts` invariant #5 enforces the header rule — every
migration file must have a `-- Rollback plan:` block before the
`-- +migrate up` marker.

## File shape

```sql
-- File: NNNN_short_description.sql
-- Author: Claude Code
-- Issue: TASK-NN · short title
-- RFC:   ERP-RFC-001 §<sections>
--
-- Rollback plan:
--   One or more bullet points describing how to undo this migration
--   in dev (where `-- +migrate down` is run) and in production
--   (where rollback is by WAL restore, not by running +migrate down).
--
-- Structure: one short paragraph on the shape of the change — any
-- non-obvious choices (e.g. "we FORCE RLS because the dev superuser
-- otherwise bypasses it"), index strategy, and why the ordering
-- inside the up block matters.
--
-- +migrate up

<DDL or DML>

-- +migrate down

<reverse DDL or DML, when reversible; otherwise explain in the header>
```

## Canonical example — `0001_metadata_schema.sql`

The first migration in the repo is the RFC §4.1 metadata schema. The
full file lives in [`infra/migrations/0001_metadata_schema.sql`](../../infra/migrations/0001_metadata_schema.sql);
the relevant shape below.

### Header — the bit `verify.ts` inspects

```sql
-- File: 0001_metadata_schema.sql
-- Author: Claude Code
-- Issue: TASK-03 · Metadata Schema
-- RFC:   ERP-RFC-001 §4.1 (tables) · §10.1 (RLS) · §1.3 (schema split)
--
-- Rollback plan:
--   The metadata schema holds no ops data and is safe to drop wholesale
--   in dev. In production this migration runs before any tenant data
--   lands, so rolling back is destructive only after pilots go live
--   — at which point rollback is performed by point-in-time WAL
--   restore, not by the `-- +migrate down` block below.
```

### Up block — schema, application role, tables, RLS, grants, in order

```sql
-- +migrate up

CREATE SCHEMA IF NOT EXISTS metadata;

-- Application role. Superusers bypass RLS; app runs as erp_app so policies fire.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
        CREATE ROLE erp_app NOLOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
    END IF;
END$$;
GRANT USAGE ON SCHEMA metadata TO erp_app;

CREATE TABLE metadata.meta_object ( … );
CREATE INDEX idx_meta_object_current ON metadata.meta_object (object_id, layer, tenant_id)
    WHERE valid_until IS NULL;

-- (three more CREATE TABLE statements…)

ALTER TABLE metadata.meta_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.meta_object FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_object_tenant_isolation ON metadata.meta_object
    FOR ALL TO PUBLIC
    USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', true))
    WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', true));

-- (three more policies…)

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA metadata TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA metadata TO erp_app;
```

### Down block — reversible in dev

```sql
-- +migrate down

DROP SCHEMA IF EXISTS metadata CASCADE;
DROP ROLE IF EXISTS erp_app;
```

## Online migration recipes (for later tasks)

For schema changes that touch a large existing table:

- **Adding a column:** add nullable, backfill in batches, set
  `NOT NULL` in a follow-up migration.
- **Dropping a column:** stop writing in code first, deploy, then
  drop in a follow-up migration.
- **Index creation:** `CREATE INDEX CONCURRENTLY`. Never bare
  `CREATE INDEX` on a table with traffic.
- **Renaming:** add new, dual-write, switch reads, drop old. Three
  migrations, never one.

None of these apply to `0001` because it runs on an empty database —
but they kick in as soon as a second tenant exists.

## Running migrations

```bash
pnpm db:migrate                    # apply every unapplied up-migration
pnpm db:migrate -- --down          # roll back the most recent migration
pnpm db:migrate -- --down-to NAME  # roll back to a specific migration
pnpm db:migrate -- --down-all      # roll back everything (dev only)
```

`DATABASE_URL` must be set; see `.env.example`. The CLI uses Kysely's
built-in Migrator, which tracks applied migrations in a
`kysely_migration` table — so re-running is idempotent.

## Verified by

- `scripts/verify.ts` invariant #5 — every migration has a
  `-- Rollback plan:` header block.
- `packages/db/test/integration/migrator.integration.test.ts` —
  proves migrateToLatest is idempotent and migrateDown → migrateToLatest
  round-trips cleanly.
- `packages/db/test/integration/rls.integration.test.ts` — proves the
  policies created by this migration actually block cross-tenant
  reads and writes.
