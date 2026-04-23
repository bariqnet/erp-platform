-- File: 0004_ops_entity_rows.sql
-- Author: Claude Code
-- Issue: TASK-12 · Runtime API Auto-Derivation
-- RFC:   ERP-RFC-001 §1.3 (schema split) · §4.2 (JSONB storage)
--        · §10.1 (RLS) · §9.2 (Runtime API)
--
-- Rollback plan:
--   In dev: `pnpm db:migrate -- --down` reverses via the down block
--   below. In production the `ops` schema backs every tenant's row
--   data; rollback after pilots go live is destructive and is
--   performed by point-in-time WAL restore, not by running +migrate
--   down.
--
-- Shape of the change:
--   Introduces the operational schema (`ops`) alongside the existing
--   `metadata` schema (CLAUDE.md §2 "two schemas: metadata and ops")
--   and its single generic entity-row table. Every tenant's row for
--   every entity lives here, keyed by (tenant_id, entity_id, row_id).
--
--   Phase 1 storage policy (CLAUDE.md §6 "JSONB and native column,
--   not side-table yet"): we ship the JSONB strategy only. Field
--   values live in `body JSONB`; adding a field via the Admin API
--   requires no DDL and no redeploy — the next resolve picks up the
--   new shape, the next materialization builds a Zod validator that
--   accepts it, reads and writes proceed. "Native column" storage
--   is out of scope for this task and lands when the Migration
--   Primitives (RFC §11.3) do.
--
--   `status` is stored as a plain TEXT column so the lifecycle
--   state (Lifecycle.states) can be filtered/indexed without
--   unpacking the JSONB body. When the Workflow engine lands in
--   Phase 2 this column is where it reads and writes.
--
-- +migrate up

CREATE SCHEMA IF NOT EXISTS ops;

GRANT USAGE ON SCHEMA ops TO erp_app;

-- ── ops.entity_row ──────────────────────────────────────────────────────────
-- One row per tenant entity instance. (tenant_id, entity_id, row_id) is
-- unique; row_id is a UUID generated server-side on INSERT.
CREATE TABLE ops.entity_row (
    row_pk           BIGSERIAL    PRIMARY KEY,
    tenant_id        TEXT         NOT NULL,
    entity_id        TEXT         NOT NULL,              -- e.g. 'ent.customer'
    row_id           UUID         NOT NULL DEFAULT gen_random_uuid(),
    body             JSONB        NOT NULL DEFAULT '{}'::jsonb,
    status           TEXT,                                -- lifecycle state or NULL
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,                         -- soft-delete marker
    created_by       TEXT,
    updated_by       TEXT,
    UNIQUE (tenant_id, entity_id, row_id)
);

-- Hot-path index for listing rows of a given entity for a tenant,
-- filtering out soft-deleted rows at query time.
CREATE INDEX idx_entity_row_tenant_entity_active
    ON ops.entity_row (tenant_id, entity_id, row_id)
    WHERE deleted_at IS NULL;

-- Row-level security (RFC §10.1). Runs the same strict-tenant policy as
-- every other operational table: the row is visible only when its
-- tenant_id matches the current_setting('app.current_tenant') GUC. No
-- NULL-tenant escape hatch — ops data is strictly tenant-scoped.
ALTER TABLE ops.entity_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.entity_row FORCE ROW LEVEL SECURITY;

CREATE POLICY ops_entity_row_tenant_isolation ON ops.entity_row
    FOR ALL
    TO PUBLIC
    USING (tenant_id = current_setting('app.current_tenant', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.entity_row TO erp_app;
GRANT USAGE, SELECT ON SEQUENCE ops.entity_row_row_pk_seq TO erp_app;

-- +migrate down

DROP TABLE IF EXISTS ops.entity_row;
DROP SCHEMA IF EXISTS ops;
