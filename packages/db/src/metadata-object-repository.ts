// MetadataObjectRepository — data-layer access to metadata.meta_object
// for the Admin API and the Kernel resolver.
//
// Two roles in one class:
//   1. Implements @erp/core's `MetadataStore` port — `fetchCandidate` +
//      `getActiveLayers` — so the @erp/metadata resolver can read
//      through it.
//   2. Admin-API queries: `list`, `get`, `history` — used by the three
//      RFC §9.1 read-side endpoints.
//
// Vendor-level reads (L0/L1 candidates) bypass tenant context — the
// rows have tenant_id IS NULL and the resolver fetches them on every
// tenant's behalf. The `// @vendor-repository` style comment on
// `getVendorCandidate()` documents why this method skips runAsTenant.

import { type Layer, type LayerCandidate, type MetadataStore, type ObjectType } from "@erp/core";
import { type Selectable } from "kysely";

import { type MetaObjectTable } from "./schema.js";
import { TenantRepository } from "./tenant-repository.js";

const VENDOR_LAYERS: ReadonlySet<Layer> = new Set(["L0", "L1"]);

export interface ListObjectsParams {
  readonly type?: ObjectType;
  readonly layer?: Layer;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MetaObjectRow {
  readonly object_pk: string;
  readonly object_id: string;
  readonly object_type: string;
  readonly layer: Layer;
  readonly tenant_id: string | null;
  readonly template_id: string | null;
  readonly version: number;
  readonly operation: "upsert" | "tombstone";
  readonly body: Record<string, unknown> | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly created_via: string;
  readonly change_set_id: string;
  readonly valid_from: string;
  readonly valid_until: string | null;
  readonly superseded_by_change_set_id: string | null;
}

export class MetadataObjectRepository extends TenantRepository implements MetadataStore {
  /**
   * MetadataStore port — fetch the currently-active candidate at a
   * specific layer for the given object id. Vendor-global L0/L1 rows
   * have tenant_id NULL; tenant-scoped L2+ rows match the GUC.
   */
  async fetchCandidate(params: {
    layer: Layer;
    object_id: string;
    tenant_id: string | null;
  }): Promise<LayerCandidate | null> {
    if (VENDOR_LAYERS.has(params.layer)) {
      return this.runAsVendor(async (trx) => {
        const row = await trx
          .selectFrom("metadata.meta_object")
          .selectAll()
          .where("object_id", "=", params.object_id)
          .where("layer", "=", params.layer)
          .where("tenant_id", "is", null)
          .where("valid_until", "is", null)
          .executeTakeFirst();
        return row ? toCandidate(row) : null;
      });
    }
    if (params.tenant_id === null) return null;
    return this.runAsTenant(params.tenant_id, async (trx) => {
      const row = await trx
        .selectFrom("metadata.meta_object")
        .selectAll()
        .where("object_id", "=", params.object_id)
        .where("layer", "=", params.layer)
        .where("tenant_id", "=", params.tenant_id)
        .where("valid_until", "is", null)
        .executeTakeFirst();
      return row ? toCandidate(row) : null;
    });
  }

  /**
   * MetadataStore port — return the layer set active for a tenant.
   * Phase 1 default: ["L0", "L2"] (L1 templates land in Phase 2).
   * Tenants with explicit activation rows in `meta_layer_activation`
   * override this default — wired up when the activation API lands.
   */
  async getActiveLayers(_tenant: string): Promise<readonly Layer[]> {
    return ["L0", "L2"];
  }

  /**
   * Admin API · list metadata objects, filterable by type/layer.
   * Returns currently-active rows only (`valid_until IS NULL`).
   */
  async list(tenantId: string, params: ListObjectsParams): Promise<readonly MetaObjectRow[]> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = Math.max(params.offset ?? 0, 0);

    return this.runAsTenant(tenantId, async (trx) => {
      let q = trx.selectFrom("metadata.meta_object").selectAll().where("valid_until", "is", null);
      if (params.type !== undefined) q = q.where("object_type", "=", params.type);
      if (params.layer !== undefined) q = q.where("layer", "=", params.layer);
      const rows = await q
        .orderBy("layer")
        .orderBy("object_id")
        .limit(limit)
        .offset(offset)
        .execute();
      return rows.map(toRow);
    });
  }

  /**
   * Distinct object ids of a given type that are currently active for
   * the tenant (either at a vendor layer the tenant inherits, or at a
   * tenant-specific layer). Used by the Permission Gate to enumerate
   * every `prm.*` a tenant has, then resolve each through the layer
   * stack — the resolver knows nothing about the "set of active
   * objects for a tenant" concept, so we materialize it here.
   */
  async listActiveObjectIds(tenantId: string, type: ObjectType): Promise<readonly string[]> {
    // Union tenant-scoped + vendor-global rows, same as history().
    const [tenantRows, vendorRows] = await Promise.all([
      this.runAsTenant(tenantId, async (trx) =>
        trx
          .selectFrom("metadata.meta_object")
          .select("object_id")
          .distinct()
          .where("object_type", "=", type)
          .where("tenant_id", "=", tenantId)
          .where("valid_until", "is", null)
          .execute(),
      ),
      this.runAsVendor(async (trx) =>
        trx
          .selectFrom("metadata.meta_object")
          .select("object_id")
          .distinct()
          .where("object_type", "=", type)
          .where("tenant_id", "is", null)
          .where("valid_until", "is", null)
          .execute(),
      ),
    ]);

    const ids = new Set<string>();
    for (const r of tenantRows) ids.add(r.object_id);
    for (const r of vendorRows) ids.add(r.object_id);
    return [...ids].sort();
  }

  /**
   * Admin API · fetch a single object's currently-active row at a
   * specific layer. Returns null if no row exists.
   */
  async getAtLayer(
    tenantId: string,
    objectId: string,
    layer: Layer,
  ): Promise<MetaObjectRow | null> {
    if (VENDOR_LAYERS.has(layer)) {
      return this.runAsVendor(async (trx) => {
        const row = await trx
          .selectFrom("metadata.meta_object")
          .selectAll()
          .where("object_id", "=", objectId)
          .where("layer", "=", layer)
          .where("tenant_id", "is", null)
          .where("valid_until", "is", null)
          .executeTakeFirst();
        return row ? toRow(row) : null;
      });
    }
    return this.runAsTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom("metadata.meta_object")
        .selectAll()
        .where("object_id", "=", objectId)
        .where("layer", "=", layer)
        .where("tenant_id", "=", tenantId)
        .where("valid_until", "is", null)
        .executeTakeFirst();
      return row ? toRow(row) : null;
    });
  }

  /**
   * Admin API · full version history for an object. Returns every
   * row across every layer for this tenant (plus vendor-global rows
   * the tenant inherits), most recent first.
   */
  async history(tenantId: string, objectId: string): Promise<readonly MetaObjectRow[]> {
    // We want this tenant's rows AND vendor-global rows. Two queries
    // unioned because RLS on the tenant query would drop the NULL-
    // tenant rows.
    const [tenantRows, vendorRows] = await Promise.all([
      this.runAsTenant(tenantId, async (trx) =>
        trx
          .selectFrom("metadata.meta_object")
          .selectAll()
          .where("object_id", "=", objectId)
          .where("tenant_id", "=", tenantId)
          .orderBy("created_at", "desc")
          .execute(),
      ),
      this.runAsVendor(async (trx) =>
        trx
          .selectFrom("metadata.meta_object")
          .selectAll()
          .where("object_id", "=", objectId)
          .where("tenant_id", "is", null)
          .orderBy("created_at", "desc")
          .execute(),
      ),
    ]);

    const merged = [...tenantRows, ...vendorRows].sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
    return merged.map(toRow);
  }
}

// ── Conversions ──────────────────────────────────────────────────────

function toCandidate(row: Selectable<MetaObjectTable>): LayerCandidate {
  const candidate: LayerCandidate = {
    layer: row.layer,
    object_id: row.object_id,
    version: row.version,
    operation: row.operation,
  };
  if (row.body !== null) {
    (candidate as { body?: Record<string, unknown> }).body = row.body;
  }
  return candidate;
}

function toRow(row: Selectable<MetaObjectTable>): MetaObjectRow {
  return {
    object_pk: row.object_pk,
    object_id: row.object_id,
    object_type: row.object_type,
    layer: row.layer,
    tenant_id: row.tenant_id,
    template_id: row.template_id,
    version: row.version,
    operation: row.operation,
    body: row.body,
    created_at: row.created_at.toISOString(),
    created_by: row.created_by,
    created_via: row.created_via,
    change_set_id: row.change_set_id,
    valid_from: row.valid_from.toISOString(),
    valid_until: row.valid_until?.toISOString() ?? null,
    superseded_by_change_set_id: row.superseded_by_change_set_id,
  };
}

// Phase 1 keeps merge_strategy + key_field implicit at the candidate
// level (default: replace). When per-candidate strategy lands, decode
// it from row.body or a sidecar column added by a later migration.
