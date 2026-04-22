// MetadataStore port — the adapter the resolver fetches candidates through.
// CLAUDE.md §3 lists this as a canonical port; §7 #12 keeps I/O out of
// domain code. Adapters live in @erp/db (for the Postgres meta_object
// table) and in tests as in-memory fixtures.
//
// The port is stateless. Every call carries the tenant_id explicitly.
// Adapters that connect to a tenant-scoped session (via
// withTenantContext in @erp/db) still accept tenant_id as a parameter
// so the port stays transport-agnostic.

import { z } from "zod";

import type { Layer } from "../layer.js";

// ── Merge strategies (RFC §3.3) ────────────────────────────────────────

export const MergeStrategySchema = z.enum([
  "replace",
  "merge_object",
  "append",
  "merge_list_by_key",
]);

export type MergeStrategy = z.infer<typeof MergeStrategySchema>;

/** Default strategy when a candidate does not declare one explicitly. */
export const DEFAULT_MERGE_STRATEGY: MergeStrategy = "replace";

// ── LayerCandidate (what the store returns) ───────────────────────────
// Slightly narrower than the DB row in `metadata.meta_object`: it carries
// only the columns the resolver uses, plus a resolution-specific
// `merge_strategy`/`key_field` pair that the adapter infers from the
// envelope's annotations.

export interface LayerCandidate {
  /** The layer this candidate was fetched at (L0–L4). */
  readonly layer: Layer;
  /** Object id this candidate is a version of, e.g. `ent.customer`. */
  readonly object_id: string;
  /** Monotonic per-(object_id, layer, tenant) version, starts at 1. */
  readonly version: number;
  /** Upsert contributes a body; tombstone severs inheritance. */
  readonly operation: "upsert" | "tombstone";
  /** Present when `operation === "upsert"`. Absent for tombstones. */
  readonly body?: Record<string, unknown> | undefined;
  /**
   * How this candidate's body combines with the accumulated effective
   * value. Defaults to `replace` when absent (see DEFAULT_MERGE_STRATEGY).
   * Only applied when the candidate is not the first non-null body (i.e.
   * there's something below it to merge into).
   */
  readonly merge_strategy?: MergeStrategy;
  /**
   * Key field for `merge_list_by_key`. Required if strategy is
   * `merge_list_by_key`; ignored otherwise.
   */
  readonly key_field?: string;
  /** Free-form reason attached to a tombstone (RFC §3.4). */
  readonly reason?: string;
}

// ── MetadataStore port ─────────────────────────────────────────────────

export interface FetchCandidateParams {
  readonly layer: Layer;
  readonly object_id: string;
  /**
   * null for vendor-global reads (L0/L1 candidates). Non-null for
   * tenant-scoped reads at L2+.
   */
  readonly tenant_id: string | null;
}

/**
 * Adapters fetch candidates one layer at a time. The resolver walks
 * layers bottom-up and combines. Keeping fetch() per-layer (rather than
 * `fetchAll(object_id)`) lets adapters apply per-layer caching and
 * lets the resolver short-circuit with an async iteration if needed
 * (not exercised in Phase 1).
 */
export interface MetadataStore {
  /**
   * Return the currently-active candidate for (`object_id`, `layer`,
   * `tenant_id`). "Currently active" means the row whose `valid_until`
   * is NULL. Returns null if no candidate exists at that layer.
   */
  fetchCandidate(params: FetchCandidateParams): Promise<LayerCandidate | null>;

  /**
   * Return the layers active for a tenant, in bottom-up order (L0 first,
   * L4 last). Tenants without explicit activation rows fall back to
   * `["L0", "L2"]` (the Phase 1 default — no L1/L3/L4 yet).
   */
  getActiveLayers(tenant_id: string): Promise<readonly Layer[]>;
}
