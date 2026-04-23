import type { Layer, LayerCandidate, MetadataStore } from "@erp/core";
import { Result } from "@erp/core";
import { describe, expect, it } from "vitest";

import { resolve } from "./resolve.js";

// ── Fixture store ─────────────────────────────────────────────────────

/**
 * In-memory MetadataStore for tests. Candidates are seeded with an
 * optional `tenant_id` (null = vendor-global); fetchCandidate matches
 * the exact (layer, object_id, tenant_id) tuple.
 */
class InMemoryStore implements MetadataStore {
  private rows: (LayerCandidate & { tenant_id: string | null })[] = [];
  private activeLayers: readonly Layer[] = ["L0", "L1", "L2", "L3", "L4"];

  setActiveLayers(layers: readonly Layer[]): this {
    this.activeLayers = layers;
    return this;
  }

  seed(row: LayerCandidate & { tenant_id: string | null }): this {
    this.rows.push(row);
    return this;
  }

  async fetchCandidate(params: {
    layer: Layer;
    object_id: string;
    tenant_id: string | null;
  }): Promise<LayerCandidate | null> {
    const found = this.rows.find(
      (r) =>
        r.layer === params.layer &&
        r.object_id === params.object_id &&
        r.tenant_id === params.tenant_id,
    );
    if (!found) return null;
    // Strip the test-only tenant_id field before returning.
    const { tenant_id: _unused, ...candidate } = found;
    return candidate;
  }

  async getActiveLayers(_tenant: string): Promise<readonly Layer[]> {
    return this.activeLayers;
  }
}

const TENANT = "t_4f8a3c";

// ── Basic resolution ──────────────────────────────────────────────────

describe("resolve — single layer", () => {
  it("returns Ok with the L0 body when only L0 contributes", async () => {
    const store = new InMemoryStore().seed({
      layer: "L0",
      tenant_id: null,
      object_id: "ent.customer",
      version: 1,
      operation: "upsert",
      body: { name: "Customer", label: { en: "Customer" } },
    });

    const r = await resolve({ object_id: "ent.customer", tenant_id: TENANT }, store);
    expect(Result.isOk(r)).toBe(true);
    if (r.ok) {
      expect(r.value.body).toEqual({ name: "Customer", label: { en: "Customer" } });
      expect(r.value.provenance).toEqual([
        { layer: "L0", version: 1, object_id: "ent.customer" },
      ]);
    }
  });

  it("returns object_not_found when every layer is null", async () => {
    const store = new InMemoryStore();
    const r = await resolve({ object_id: "ent.nothing", tenant_id: TENANT }, store);
    expect(Result.isErr(r)).toBe(true);
    if (!r.ok) {
      expect(r.error).toEqual({
        kind: "object_not_found",
        object_id: "ent.nothing",
        tenant_id: TENANT,
      });
    }
  });
});

// ── Two-layer composition ─────────────────────────────────────────────

describe("resolve — two layers with merge strategies", () => {
  it("replace (default): L2 overrides L0 outright", async () => {
    const store = new InMemoryStore()
      .seed({
        layer: "L0",
        tenant_id: null,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { a: 1, b: 2 },
      })
      .seed({
        layer: "L2",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { a: 100 },
      });

    const r = await resolve({ object_id: "ent.x", tenant_id: TENANT }, store);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body).toEqual({ a: 100 });
      expect(r.value.provenance.map((p) => p.layer)).toEqual(["L0", "L2"]);
    }
  });

  it("merge_object: L2 deep-merges into L0", async () => {
    const store = new InMemoryStore()
      .seed({
        layer: "L0",
        tenant_id: null,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { label: { en: "X", ar: "س" }, icon: "u" },
      })
      .seed({
        layer: "L2",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        merge_strategy: "merge_object",
        body: { label: { ar: "إكس" } },
      });

    const r = await resolve({ object_id: "ent.x", tenant_id: TENANT }, store);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body).toEqual({ label: { en: "X", ar: "إكس" }, icon: "u" });
    }
  });

  it("append list via an object wrapper: fields merge_list_by_key on body.fields", async () => {
    // The idiomatic shape — body is an object, the list lives at body.fields,
    // and the candidate is merge_object so the resolver recurses. Nested
    // lists still get replaced wholesale by merge_object; true list-merge
    // at the field-annotation level is a follow-up (per the TASK-06 plan).
    const store = new InMemoryStore()
      .seed({
        layer: "L0",
        tenant_id: null,
        object_id: "ent.customer",
        version: 1,
        operation: "upsert",
        body: { name: "Customer", fields: [{ name: "code" }, { name: "name" }] },
      })
      .seed({
        layer: "L2",
        tenant_id: TENANT,
        object_id: "ent.customer",
        version: 1,
        operation: "upsert",
        merge_strategy: "merge_object",
        body: { fields: [{ name: "name" }, { name: "tax_id" }] },
      });

    const r = await resolve({ object_id: "ent.customer", tenant_id: TENANT }, store);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // merge_object replaces arrays wholesale.
      expect(r.value.body).toEqual({
        name: "Customer",
        fields: [{ name: "name" }, { name: "tax_id" }],
      });
    }
  });
});

// ── Tombstones ────────────────────────────────────────────────────────

describe("resolve — tombstones", () => {
  it("a tombstone at L2 severs L0/L1 contribution; L3 upsert re-establishes", async () => {
    const store = new InMemoryStore()
      .seed({
        layer: "L0",
        tenant_id: null,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { from: "L0" },
      })
      .seed({
        layer: "L1",
        tenant_id: null,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        merge_strategy: "merge_object",
        body: { from: "L1" },
      })
      .seed({
        layer: "L2",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 1,
        operation: "tombstone",
        reason: "retired",
      })
      .seed({
        layer: "L3",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { from: "L3" },
      });

    const r = await resolve({ object_id: "ent.x", tenant_id: TENANT }, store);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Only L3 contributes — L0 and L1 were tombstoned out.
      expect(r.value.body).toEqual({ from: "L3" });
      expect(r.value.provenance.map((p) => p.layer)).toEqual(["L3"]);
    }
  });

  it("a tombstone with no upsert after yields object_not_found", async () => {
    const store = new InMemoryStore()
      .seed({
        layer: "L0",
        tenant_id: null,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { from: "L0" },
      })
      .seed({
        layer: "L2",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 1,
        operation: "tombstone",
      });

    const r = await resolve({ object_id: "ent.x", tenant_id: TENANT }, store);
    expect(Result.isErr(r)).toBe(true);
  });

  it("a tombstone on a layer with nothing below it is a no-op", async () => {
    const store = new InMemoryStore()
      .seed({
        layer: "L2",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 1,
        operation: "tombstone",
      })
      .seed({
        layer: "L3",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { from: "L3" },
      });

    const r = await resolve({ object_id: "ent.x", tenant_id: TENANT }, store);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body).toEqual({ from: "L3" });
    }
  });
});

// ── active_layers override ────────────────────────────────────────────

describe("resolve — active_layers override", () => {
  it("uses the explicit list when provided; store.getActiveLayers is not called", async () => {
    const store = new InMemoryStore()
      .seed({
        layer: "L0",
        tenant_id: null,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { a: 1 },
      })
      .seed({
        layer: "L2",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { a: 100 },
      })
      // Set default active to something the test does NOT want to use.
      .setActiveLayers(["L0", "L1", "L2", "L3", "L4"]);

    // Restrict to L0 only — L2's override should not apply.
    const r = await resolve(
      { object_id: "ent.x", tenant_id: TENANT, active_layers: ["L0"] },
      store,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body).toEqual({ a: 1 });
      expect(r.value.provenance).toHaveLength(1);
    }
  });
});

// ── Determinism ───────────────────────────────────────────────────────

describe("resolve — determinism", () => {
  it("returns structurally equal output for the same inputs", async () => {
    const store = new InMemoryStore()
      .seed({
        layer: "L0",
        tenant_id: null,
        object_id: "ent.x",
        version: 1,
        operation: "upsert",
        body: { label: { en: "A", ar: "أ" }, fields: [1, 2] },
      })
      .seed({
        layer: "L2",
        tenant_id: TENANT,
        object_id: "ent.x",
        version: 3,
        operation: "upsert",
        merge_strategy: "merge_object",
        body: { label: { ar: "ب" }, icon: "x" },
      });

    const r1 = await resolve({ object_id: "ent.x", tenant_id: TENANT }, store);
    const r2 = await resolve({ object_id: "ent.x", tenant_id: TENANT }, store);
    expect(r1).toEqual(r2);
  });
});
