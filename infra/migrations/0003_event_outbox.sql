-- File: 0003_event_outbox.sql
-- Author: Claude Code
-- Issue: TASK-08 · In-Process EventBus + Outbox
-- RFC:   ERP-RFC-001 §10.2 (event isolation) · CLAUDE.md §2 (Events)
--
-- Rollback plan:
--   In dev: `pnpm db:migrate -- --down` reverses via the down block
--   below. In production this table backs every domain event the
--   platform fires; rollback after pilot is destructive and is done
--   by point-in-time WAL restore, not by running +migrate down.
--
-- Shape of the change:
--   Adds the outbox table that backs the @erp/events `OutboxBus`. The
--   bus's publish() / publishWithin() inserts a row per event inside
--   the caller's transaction (or its own). The OutboxPump (worker)
--   reads `WHERE delivered_at IS NULL` rows in batches with
--   FOR UPDATE SKIP LOCKED, dispatches to in-process subscribers, and
--   sets delivered_at = now() on success.
--
--   Two UNIQUE constraints serve different roles:
--     event_id   — every DomainEvent has a unique UUID; the constraint
--                  catches accidental double-INSERTs from buggy producers.
--     dedup_key  — producer-side at-least-once dedup. When a Change
--                  Set deploy is retried, the dedup_key is stable so
--                  the second publish ON CONFLICT DO NOTHING.
--
--   RLS keeps tenant-scoped events isolated; the pump runs as a
--   vendor-level reader (the `erp` superuser bypasses RLS) so it
--   sees and dispatches every tenant's events.
--
-- +migrate up

CREATE TABLE metadata.meta_outbox (
    outbox_pk        BIGSERIAL PRIMARY KEY,
    event_id         UUID         NOT NULL UNIQUE,
    event_type       TEXT         NOT NULL,
    event_version    INT          NOT NULL DEFAULT 1,
    occurred_at      TIMESTAMPTZ  NOT NULL,
    tenant_id        TEXT,
    actor_id         TEXT,
    change_set_id    TEXT,
    dedup_key        TEXT         NOT NULL UNIQUE,
    trace            JSONB,
    payload          JSONB        NOT NULL,
    enqueued_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    delivered_at     TIMESTAMPTZ,
    attempt_count    INT          NOT NULL DEFAULT 0,
    last_attempt_at  TIMESTAMPTZ,
    last_error       TEXT
);

-- Hot-path index for the pump's "give me the next N pending events" query.
CREATE INDEX idx_meta_outbox_pending
    ON metadata.meta_outbox (outbox_pk)
    WHERE delivered_at IS NULL;

-- Subscribers occasionally look up an event by its UUID (for diagnostics
-- and the at-least-once dedup helpers); add a non-partial index.
CREATE INDEX idx_meta_outbox_event_type_pending
    ON metadata.meta_outbox (event_type)
    WHERE delivered_at IS NULL;

-- Row-level security — same policy shape as meta_audit_log: NULL tenant
-- (vendor-level events) or matching tenant. The pump bypasses RLS
-- because it runs as the erp superuser; tenant-scoped consumers get
-- only their own events.
ALTER TABLE metadata.meta_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.meta_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_outbox_tenant_isolation ON metadata.meta_outbox
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

GRANT SELECT, INSERT, UPDATE ON metadata.meta_outbox TO erp_app;
GRANT USAGE, SELECT ON SEQUENCE metadata.meta_outbox_outbox_pk_seq TO erp_app;

-- +migrate down

DROP INDEX IF EXISTS metadata.idx_meta_outbox_event_type_pending;
DROP INDEX IF EXISTS metadata.idx_meta_outbox_pending;
DROP TABLE IF EXISTS metadata.meta_outbox;
