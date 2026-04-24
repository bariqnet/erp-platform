// resolve() — the layered resolver from RFC §3.2.
//
// Pure function of (tenant_id, object_id, active_layers). Zero I/O; the
// MetadataStore is injected. Given the same inputs and the same store
// responses, this function returns the same output — the determinism
// property the Kernel's cache depends on (RFC §5.3, §3.6).
//
// Algorithm mirrors RFC §3.2 literally: walk layers bottom-up, skip
// null candidates, reset on tombstone, deep-clone the first body,
// merge subsequent bodies per the candidate's strategy, append a
// provenance entry after each successful upsert step. If nothing
// contributes, return `object_not_found`.

import { Result } from "@erp/core";

import { deepClone, merge } from "./merge.js";

import type { Layer, MetadataStore, Result as ResultT } from "@erp/core";

// ── Types ─────────────────────────────────────────────────────────────

export interface ProvenanceEntry {
  readonly layer: Layer;
  readonly version: number;
  readonly object_id: string;
}

export interface ResolvedObject<TBody = Record<string, unknown>> {
  readonly object_id: string;
  readonly body: TBody;
  readonly provenance: readonly ProvenanceEntry[];
}

export type ResolveError = {
  readonly kind: "object_not_found";
  readonly object_id: string;
  readonly tenant_id: string;
};

export type ResolveResult<TBody = Record<string, unknown>> = ResultT<
  ResolvedObject<TBody>,
  ResolveError
>;

export interface ResolveParams {
  readonly object_id: string;
  readonly tenant_id: string;
  /**
   * Override the layer set. Defaults to `store.getActiveLayers(tenant_id)`.
   * Passing an explicit list is the typical path for tests and for the
   * simulate-change API (RFC §9.4) — run resolution with a hypothetical
   * layer activation without persisting anything.
   */
  readonly active_layers?: readonly Layer[];
}

// ── The algorithm ─────────────────────────────────────────────────────

/**
 * Resolve the effective metadata for `(tenant_id, object_id)` by walking
 * the tenant's active layers bottom-up and merging. Returns
 * `object_not_found` when no layer contributes a usable body (either
 * every layer was null, or every non-null layer was a tombstone with no
 * subsequent upsert to re-establish the object).
 */
export async function resolve<TBody = Record<string, unknown>>(
  params: ResolveParams,
  store: MetadataStore,
): Promise<ResolveResult<TBody>> {
  const layers = params.active_layers ?? (await store.getActiveLayers(params.tenant_id));

  let effective: Record<string, unknown> | null = null;
  let provenance: ProvenanceEntry[] = [];

  for (const layer of layers) {
    const candidate = await store.fetchCandidate({
      layer,
      object_id: params.object_id,
      tenant_id: tenantIdForLayer(layer, params.tenant_id),
    });

    if (candidate === null) continue;

    if (candidate.operation === "tombstone") {
      // RFC §3.4: the resolver resets the effective value to null and
      // lower layers no longer contribute. Provenance resets with it —
      // it is a property of `effective` in the pseudocode, so losing
      // `effective` loses the accumulated provenance. Layers above the
      // tombstone may re-establish both.
      effective = null;
      provenance = [];
      continue;
    }

    // Upsert without a body is a malformed candidate — skip defensively.
    if (candidate.body === undefined) continue;

    if (effective === null) {
      effective = deepClone(candidate.body);
    } else {
      const merged = merge(effective, candidate.body, candidate);
      if (!isPlainObject(merged)) {
        // merge() always returns the same structural shape it received
        // for merge_object; other strategies operate on arrays, which
        // cannot be assigned to a meta_object body directly. If we reach
        // here the candidate mis-declared its strategy.
        throw new Error(
          `resolve: merge at layer ${layer} produced a non-object for ${params.object_id}`,
        );
      }
      effective = merged;
    }

    provenance.push({
      layer: candidate.layer,
      version: candidate.version,
      object_id: candidate.object_id,
    });
  }

  if (effective === null) {
    return Result.err({
      kind: "object_not_found",
      object_id: params.object_id,
      tenant_id: params.tenant_id,
    });
  }

  return Result.ok({
    object_id: params.object_id,
    body: effective as TBody,
    provenance,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Translate the resolver's tenant_id to what the store expects at
 * each layer.
 *
 * - L0 rows are vendor-global and carry `tenant_id = null` in the DB;
 *   no tenant context needed.
 * - L1 rows are also vendor-global but scoped by `template_id`. The
 *   store needs the tenant_id to look up which template is activated
 *   for this tenant (TASK-17).
 * - L2+ rows are tenant-scoped.
 */
function tenantIdForLayer(layer: Layer, tenant_id: string): string | null {
  if (layer === "L0") return null;
  return tenant_id;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
