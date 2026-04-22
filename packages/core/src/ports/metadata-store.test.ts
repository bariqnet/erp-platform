import { describe, expect, it } from "vitest";

import {
  DEFAULT_MERGE_STRATEGY,
  MergeStrategySchema,
  type LayerCandidate,
  type MetadataStore,
  type MergeStrategy,
} from "./metadata-store.js";

describe("MergeStrategySchema", () => {
  it.each(["replace", "merge_object", "append", "merge_list_by_key"])(
    "accepts RFC §3.3 strategy %s",
    (s) => {
      expect(MergeStrategySchema.parse(s)).toBe(s);
    },
  );

  it.each(["Replace", "override", "merge", "deep_merge"])("rejects %s", (s) => {
    expect(() => MergeStrategySchema.parse(s)).toThrow();
  });

  it("DEFAULT_MERGE_STRATEGY is one of the canonical four", () => {
    expect(MergeStrategySchema.parse(DEFAULT_MERGE_STRATEGY)).toBe(DEFAULT_MERGE_STRATEGY);
  });
});

describe("MetadataStore interface shape", () => {
  // Compile-time check: a minimal in-memory fixture satisfies the port.
  // If the interface drifts, this stops compiling — which is exactly
  // what we want for a public port.
  class InMemoryStore implements MetadataStore {
    private rows: LayerCandidate[] = [];

    async fetchCandidate({
      layer,
      object_id,
    }: {
      layer: LayerCandidate["layer"];
      object_id: string;
      tenant_id: string | null;
    }): Promise<LayerCandidate | null> {
      return this.rows.find((r) => r.layer === layer && r.object_id === object_id) ?? null;
    }

    async getActiveLayers(): Promise<readonly LayerCandidate["layer"][]> {
      return ["L0", "L2"];
    }

    seed(candidate: LayerCandidate): void {
      this.rows.push(candidate);
    }
  }

  it("fetchCandidate returns a typed LayerCandidate", async () => {
    const store = new InMemoryStore();
    store.seed({
      layer: "L0",
      object_id: "ent.customer",
      version: 1,
      operation: "upsert",
      body: { name: "Customer" },
    });

    const c = await store.fetchCandidate({
      layer: "L0",
      object_id: "ent.customer",
      tenant_id: null,
    });
    expect(c?.body?.name).toBe("Customer");
  });

  it("fetchCandidate returns null when no row exists at that layer", async () => {
    const store = new InMemoryStore();
    expect(
      await store.fetchCandidate({ layer: "L0", object_id: "ent.x", tenant_id: null }),
    ).toBeNull();
  });

  it("getActiveLayers returns a readonly Layer[]", async () => {
    const store = new InMemoryStore();
    const layers = await store.getActiveLayers("t_4f8a3c");
    expect(layers).toEqual(["L0", "L2"]);
  });

  it("LayerCandidate supports tombstones without a body", () => {
    const tombstone: LayerCandidate = {
      layer: "L2",
      object_id: "ent.customer",
      version: 3,
      operation: "tombstone",
      reason: "field retired",
    };
    expect(tombstone.body).toBeUndefined();
    expect(tombstone.operation).toBe("tombstone");
  });

  it("LayerCandidate.merge_strategy is optional and one of the four", () => {
    const variants: MergeStrategy[] = [
      "replace",
      "merge_object",
      "append",
      "merge_list_by_key",
    ];
    for (const s of variants) {
      const c: LayerCandidate = {
        layer: "L2",
        object_id: "ent.customer",
        version: 1,
        operation: "upsert",
        body: {},
        merge_strategy: s,
      };
      expect(c.merge_strategy).toBe(s);
    }
  });
});
