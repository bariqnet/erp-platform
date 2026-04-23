-- File: 0002_change_set_operations.sql
-- Author: Claude Code
-- Issue: TASK-07 · Change Set State Machine
-- RFC:   ERP-RFC-001 §9.3 (state machine) · §4.4 (immutable versioning)
--        · §11.4 (rollback as a pointer update)
--
-- Rollback plan:
--   In dev: `pnpm db:migrate -- --down` reverses the DDL via the
--   `-- +migrate down` block below. In prod, rollback after pilots
--   are live is done by WAL restore — not by running the down block.
--   The two columns added here are additive (no data drops on roll-
--   forward); a forward-only rollback of a deploy is handled by the
--   Change Set state machine itself (deployed → rolled_back), not by
--   reversing this migration.
--
-- Shape of the change:
--   1. staged_operations JSONB on meta_change_set — a draft Change Set
--      accumulates `{op: upsert|tombstone, object_id, layer, body,
--      merge_strategy?, key_field?, reason?}` entries here. They do
--      NOT become meta_object rows until the Change Set is deployed.
--      This keeps idx_meta_object_current (WHERE valid_until IS NULL)
--      pure — only deployed rows ever land in that partial index.
--
--   2. superseded_by_change_set_id TEXT on meta_object — on deploy,
--      the deploying Change Set records which of its ops replaced
--      each prior row. On rollback we find those rows by
--      `WHERE superseded_by_change_set_id = $cs` and revert their
--      valid_until to NULL in a single UPDATE — O(1) per operation
--      per RFC §11.4.
--
-- +migrate up

ALTER TABLE metadata.meta_change_set
    ADD COLUMN staged_operations JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE metadata.meta_object
    ADD COLUMN superseded_by_change_set_id TEXT;

-- Index the rollback lookup. Partial — only rows a Change Set has
-- actually superseded contribute to the index.
CREATE INDEX idx_meta_object_superseded_by
    ON metadata.meta_object (superseded_by_change_set_id)
    WHERE superseded_by_change_set_id IS NOT NULL;

-- Grant the new surface to the erp_app role introduced in 0001.
-- (ALTER TABLE … ADD COLUMN inherits the table-level grants, but
--  granting explicitly is harmless and keeps the migration
--  self-auditable.)
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata.meta_change_set TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata.meta_object TO erp_app;

-- +migrate down

DROP INDEX IF EXISTS metadata.idx_meta_object_superseded_by;
ALTER TABLE metadata.meta_object DROP COLUMN IF EXISTS superseded_by_change_set_id;
ALTER TABLE metadata.meta_change_set DROP COLUMN IF EXISTS staged_operations;
