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
   *
   * TASK-17 · L1 rows are vendor-global but scoped by `template_id`.
   * `getActiveLayers` returns L1 only when the tenant has activated
   * a template; this method reads the activation row to know *which*
   * template_id to filter by, then fetches the L1 row that matches.
   */
  async fetchCandidate(params: {
    layer: Layer;
    object_id: string;
    tenant_id: string | null;
  }): Promise<LayerCandidate | null> {
    if (params.layer === "L1") {
      // L1 rows are vendor-global (tenant_id = NULL) but scoped by
      // `template_id`. Look up the tenant's active template first;
      // no activation → no L1 contribution.
      if (params.tenant_id === null) return null;
      const templateId = await this.getActiveTemplateId(params.tenant_id);
      if (templateId === null) return null;
      return this.runAsVendor(async (trx) => {
        const row = await trx
          .selectFrom("metadata.meta_object")
          .selectAll()
          .where("object_id", "=", params.object_id)
          .where("layer", "=", "L1")
          .where("tenant_id", "is", null)
          .where("template_id", "=", templateId)
          .where("valid_until", "is", null)
          .executeTakeFirst();
        return row ? toCandidate(row) : null;
      });
    }
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
   *
   * - Default: `["L0", "L2"]`.
   * - When the tenant has an active template activation row
   *   (TASK-17), splice `L1` between `L0` and `L2`.
   * - Future: L3 / L4 follow the same pattern.
   *
   * The activation read goes through the vendor role because the
   * resolver runs with `tenant_id` set only via the port. RLS on
   * `meta_layer_activation` is strict-tenant — without the GUC, a
   * tenant-role SELECT returns zero rows even for its own data.
   */
  async getActiveLayers(tenant: string): Promise<readonly Layer[]> {
    const templateId = await this.getActiveTemplateId(tenant);
    return templateId !== null ? ["L0", "L1", "L2"] : ["L0", "L2"];
  }

  /**
   * Read the active L1 `source_id` for the tenant. Returns null when
   * no template is activated. TASK-17 · used by both
   * `fetchCandidate(L1)` and `getActiveLayers`.
   */
  async getActiveTemplateId(tenantId: string): Promise<string | null> {
    return this.runAsVendor(async (trx) => {
      const row = await trx
        .selectFrom("metadata.meta_layer_activation")
        .select("source_id")
        .where("tenant_id", "=", tenantId)
        .where("layer", "=", "L1")
        .executeTakeFirst();
      return row?.source_id ?? null;
    });
  }

  /**
   * TASK-17 · activate (or rotate) a template for a tenant. Writes
   * the `meta_layer_activation` row. Runs under vendor privilege —
   * activation is a platform-admin action, not a tenant-self-service
   * op (that posture may change in a later phase).
   */
  async activateTemplate(input: {
    readonly tenantId: string;
    readonly templateId: string;
    readonly version: string;
    readonly activatedBy: string;
  }): Promise<{ readonly templateId: string; readonly version: string }> {
    return this.runAsVendor(async (trx) => {
      await trx
        .insertInto("metadata.meta_layer_activation")
        .values({
          tenant_id: input.tenantId,
          layer: "L1",
          source_id: input.templateId,
          version: input.version,
          activated_by: input.activatedBy,
        })
        .onConflict((c) =>
          c.columns(["tenant_id", "layer"]).doUpdateSet({
            source_id: input.templateId,
            version: input.version,
            activated_by: input.activatedBy,
            activated_at: new Date(),
          }),
        )
        .execute();
      return { templateId: input.templateId, version: input.version };
    });
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
