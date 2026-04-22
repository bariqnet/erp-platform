-- File: 0001_metadata_schema.sql
-- Author: Claude Code
-- Issue: TASK-03 · Metadata Schema
-- RFC:   ERP-RFC-001 §4.1 (tables) · §10.1 (RLS) · §1.3 (schema split)
--
-- Rollback plan:
--   The metadata schema holds no ops data and is safe to drop wholesale in
--   dev. In production this migration is applied before any tenant data
--   lands, so rolling back (DROP SCHEMA metadata CASCADE) is destructive
--   only after pilots go live — at which point rollback is performed by
--   point-in-time restore from WAL, not by running the `-- +migrate down`
--   block below. See docs/runbooks/local-dev.md for dev-side resets.
--
-- Structure: four tables live in the `metadata` schema (§1.3), named with
--   a `meta_` prefix per §4.1. RLS is ENABLED and FORCED on every table,
--   so even the table owner is bound by the per-tenant policy — this
--   catches policy bugs in dev instead of shipping them to prod.
--
-- +migrate up

CREATE SCHEMA IF NOT EXISTS metadata;

-- ── Application role ────────────────────────────────────────────────────────
-- Superusers bypass RLS unconditionally — FORCE ROW LEVEL SECURITY doesn't
-- save you. So we create a non-superuser `erp_app` role and have every
-- tenant-scoped connection `SET LOCAL ROLE erp_app` before touching metadata
-- tables (see packages/db/src/tenant-context.ts). In production the app user
-- IS erp_app, so the SET LOCAL is a no-op; in dev where the connection
-- starts as the `erp` superuser, it demotes the session so policies fire.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
        CREATE ROLE erp_app NOLOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
    END IF;
END$$;
GRANT USAGE ON SCHEMA metadata TO erp_app;

-- ── meta_object ─────────────────────────────────────────────────────────────
-- Every metadata object, every version, every layer, in one table.
-- Immutable-versioned: new versions are new rows; the prior row has its
-- valid_until set. Never UPDATE a data field (CLAUDE.md §7 #2).
CREATE TABLE metadata.meta_object (
    object_pk        BIGSERIAL PRIMARY KEY,
    object_id        TEXT        NOT NULL,       -- e.g. 'ent.customer'
    object_type      TEXT        NOT NULL,       -- 'Entity', 'Workflow', ...
    layer            TEXT        NOT NULL,       -- 'L0'..'L4'
    tenant_id        TEXT,                       -- null for L0/L1
    template_id      TEXT,                       -- non-null for L1 only
    version          INT         NOT NULL,
    operation        TEXT        NOT NULL
                     DEFAULT 'upsert'
                     CHECK (operation IN ('upsert','tombstone')),
    body             JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       TEXT        NOT NULL,
    created_via      TEXT        NOT NULL,
    change_set_id    TEXT        NOT NULL,
    valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until      TIMESTAMPTZ,                -- set when superseded
    UNIQUE (object_id, layer, tenant_id, version)
);

-- Fast lookup for the "currently active" row in a given layer/tenant.
CREATE INDEX idx_meta_object_current
    ON metadata.meta_object (object_id, layer, tenant_id)
    WHERE valid_until IS NULL;

-- ── meta_change_set ─────────────────────────────────────────────────────────
-- Groups related metadata operations under a single atomic deploy.
CREATE TABLE metadata.meta_change_set (
    change_set_id    TEXT        PRIMARY KEY,
    tenant_id        TEXT        NOT NULL,
    status           TEXT        NOT NULL CHECK
                     (status IN ('draft','proposed','approved','deployed','rolled_back')),
    description      TEXT,
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by      TEXT,
    approved_at      TIMESTAMPTZ,
    deployed_at      TIMESTAMPTZ,
    rolled_back_at   TIMESTAMPTZ
);

-- ── meta_layer_activation ───────────────────────────────────────────────────
-- Which layers are active for a tenant, at which source version.
CREATE TABLE metadata.meta_layer_activation (
    tenant_id        TEXT        NOT NULL,
    layer            TEXT        NOT NULL,
    source_id        TEXT        NOT NULL,       -- e.g. template id or tenant id
    version          TEXT        NOT NULL,       -- semver for L1/L4
    activated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_by     TEXT        NOT NULL,
    PRIMARY KEY (tenant_id, layer)
);

-- ── meta_audit_log ──────────────────────────────────────────────────────────
-- Append-only chain. before_hash carries sha256 of the prior row; tamper
-- detection is an application-layer responsibility (RFC §13.2).
CREATE TABLE metadata.meta_audit_log (
    audit_pk         BIGSERIAL PRIMARY KEY,
    tenant_id        TEXT,
    actor_id         TEXT        NOT NULL,
    action           TEXT        NOT NULL,
    target_type      TEXT,
    target_id        TEXT,
    change_set_id    TEXT,
    before_hash      TEXT,                       -- sha256 of prior state
    after_hash       TEXT,
    diff             JSONB,
    context          JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Row-level security (RFC §10.1) ──────────────────────────────────────────
-- Every connection MUST issue `SET LOCAL app.current_tenant = '<id>'` at
-- check-out. current_setting(..., true) returns NULL when the GUC is unset,
-- so a connection without tenant context sees only rows where tenant_id IS
-- NULL (L0/L1 vendor rows) or nothing at all (strictly-scoped tables).
--
-- FORCE ROW LEVEL SECURITY makes the policy apply to the table owner too;
-- in dev the `erp` superuser both owns these tables and runs the app, so
-- without FORCE the policies would never fire.

-- meta_object: allow rows where tenant_id IS NULL (L0/L1) or matches tenant.
ALTER TABLE metadata.meta_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.meta_object FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_object_tenant_isolation ON metadata.meta_object
    FOR ALL
    TO PUBLIC
    USING (
        tenant_id IS NULL
        OR tenant_id = current_setting('app.current_tenant', true)
    )
    WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = current_setting('app.current_tenant', true)
    );

-- meta_change_set: strictly tenant-scoped.
ALTER TABLE metadata.meta_change_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.meta_change_set FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_change_set_tenant_isolation ON metadata.meta_change_set
    FOR ALL
    TO PUBLIC
    USING (tenant_id = current_setting('app.current_tenant', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true));

-- meta_layer_activation: strictly tenant-scoped.
ALTER TABLE metadata.meta_layer_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.meta_layer_activation FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_layer_activation_tenant_isolation ON metadata.meta_layer_activation
    FOR ALL
    TO PUBLIC
    USING (tenant_id = current_setting('app.current_tenant', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true));

-- meta_audit_log: allow NULL (vendor-level operations) or matching tenant.
ALTER TABLE metadata.meta_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.meta_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_audit_log_tenant_isolation ON metadata.meta_audit_log
    FOR ALL
    TO PUBLIC
    USING (
        tenant_id IS NULL
        OR tenant_id = current_setting('app.current_tenant', true)
    )
    WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = current_setting('app.current_tenant', true)
    );

-- ── Grants on erp_app ───────────────────────────────────────────────────────
-- Applied after the tables exist.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA metadata TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA metadata TO erp_app;

-- +migrate down

DROP SCHEMA IF EXISTS metadata CASCADE;
DROP ROLE IF EXISTS erp_app;
