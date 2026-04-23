// Kysely types for the metadata schema (RFC §4.1).
//
// Every Database key is the fully-qualified `metadata.meta_*` name — Kysely
// resolves the schema automatically. New tables land here as they ship.

import type { ChangeSetStatus, Layer } from "@erp/core";
import type { ColumnType, Generated } from "kysely";

export type { ChangeSetStatus } from "@erp/core";

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * JSONB column. Select returns a parsed object; insert/update accept either
 * an object (pg serializes it) or a pre-serialized string.
 */
export type JsonB<T> = ColumnType<T, T | string, T | string>;

// ── Discriminated string unions used across tables ────────────────────────
// MetadataLayer mirrors @erp/core's `Layer` so callers can keep the
// short, table-flavored name when working in the DB layer.

export type MetadataLayer = Layer;

export type MetadataOperation = "upsert" | "tombstone";

// ── meta_object ─────────────────────────────────────────────────────────────
// Immutable-versioned row table. Never UPDATE a data field (§7 #2); a change
// is a new row with valid_from = now() and the prior row's valid_until set.
export interface MetaObjectTable {
  object_pk: Generated<string>; // BIGSERIAL — pg returns bigint as string
  object_id: string;
  object_type: string;
  layer: MetadataLayer;
  tenant_id: string | null; // null for L0/L1 (vendor-global rows)
  template_id: string | null; // non-null for L1 rows only
  version: number;
  operation: ColumnType<
    MetadataOperation,
    MetadataOperation | undefined, // insert: default 'upsert' at DB layer
    MetadataOperation
  >;
  body: JsonB<Record<string, unknown>> | null;
  created_at: Generated<Date>;
  created_by: string;
  created_via: string;
  change_set_id: string;
  valid_from: Generated<Date>;
  valid_until: Date | null;
  /**
   * Populated by deploy() when a newer Change Set supersedes this row.
   * rollback() uses this column to find and revert the exact rows a
   * given deploy touched (RFC §11.4 · O(1) rollback).
   */
  superseded_by_change_set_id: string | null;
}

// ── meta_change_set ─────────────────────────────────────────────────────────
// State machine lives in @erp/change-set; this table is its backing store.
export interface MetaChangeSetTable {
  change_set_id: string;
  tenant_id: string;
  status: ChangeSetStatus;
  description: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  approved_by: string | null;
  approved_at: Date | null;
  deployed_at: Date | null;
  rolled_back_at: Date | null;
  /**
   * Accumulates the Change Set's pending operations until deploy. Each
   * entry is a `{ op: "upsert" | "tombstone", object_id, layer, body?,
   * merge_strategy?, key_field?, reason? }` — see @erp/change-set for
   * the Zod schema. Empty `[]` by default.
   */
  staged_operations: JsonB<readonly Record<string, unknown>[]>;
}

// ── meta_layer_activation ───────────────────────────────────────────────────
// Which layers are active for a tenant. `version` is a string because L1/L4
// sources publish semver; L0 is pinned to the platform release.
export interface MetaLayerActivationTable {
  tenant_id: string;
  layer: MetadataLayer;
  source_id: string;
  version: string;
  activated_at: Generated<Date>;
  activated_by: string;
}

// ── meta_audit_log ──────────────────────────────────────────────────────────
// Append-only. `before_hash` chains to the prior row's `after_hash`; tamper
// detection is an application-layer responsibility (RFC §13.2).
export interface MetaAuditLogTable {
  audit_pk: Generated<string>;
  tenant_id: string | null;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  change_set_id: string | null;
  before_hash: string | null;
  after_hash: string | null;
  diff: JsonB<Record<string, unknown>> | null;
  context: JsonB<Record<string, unknown>> | null;
  created_at: Generated<Date>;
}

// ── Database surface ────────────────────────────────────────────────────────

export interface Database {
  "metadata.meta_object": MetaObjectTable;
  "metadata.meta_change_set": MetaChangeSetTable;
  "metadata.meta_layer_activation": MetaLayerActivationTable;
  "metadata.meta_audit_log": MetaAuditLogTable;
}
