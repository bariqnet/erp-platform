// TASK-06 · Property-based resolver tests.
//
// Generate arbitrary layer stacks and assert the three RFC §3 invariants
// the resolver must satisfy:
//
//   1. Determinism — same inputs → same output (structurally equal).
//   2. Tombstone correctness — a tombstone severs contribution from every
//      layer below it; only layers ABOVE the tombstone can influence the
//      result.
//   3. Ordered layer application — higher layers overlay lower ones;
//      the final body reflects the last-applied upsert for each key.

import { Result } from "@erp/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { resolve } from "./resolve.js";

import type { Layer, LayerCandidate, MetadataStore } from "@erp/core";

// ── Fixture store ─────────────────────────────────────────────────────

class InMemoryStore implements MetadataStore {
  private rows: (LayerCandidate & { tenant_id: string | null })[];
  constructor(
    rows: (LayerCandidate & { tenant_id: string | null })[],
    private readonly activeLayers: readonly Layer[],
  ) {
    this.rows = rows;
  }
  async fetchCandidate(params: {
    layer: Layer;
    object_id: string;
    tenant_id: string | null;
  }): Promise<LayerCandidate | null> {
    // TASK-17 · the resolver now passes the tenant_id for L1 (not
    // null) so the real store can look up a template activation.
    // Tests seed L1 rows at tenant_id=null (vendor-global) the same
    // way production does, so match on null for L1 regardless of
    // what the resolver passed.
    const effectiveTenant =
      params.layer === "L0" || params.layer === "L1" ? null : params.tenant_id;
    const found = this.rows.find(
      (r) =>
        r.layer === params.layer &&
        r.object_id === params.object_id &&
        r.tenant_id === effectiveTenant,
    );
    if (!found) return null;
    const { tenant_id: _t, ...rest } = found;
    return rest;
  }
  async getActiveLayers(): Promise<readonly Layer[]> {
    return this.activeLayers;
  }
}

const TENANT = "t_property";
const OBJECT_ID = "ent.probe";
const LAYERS: readonly Layer[] = ["L0", "L1", "L2", "L3", "L4"];

// ── Arbitraries ───────────────────────────────────────────────────────

/** A candidate with a simple `{ layer: <layer-name>, v: <version> }` body
 *  so we can cleanly detect which layer's value won for each key. */
const upsertCandidate = (layer: Layer): fc.Arbitrary<LayerCandidate> =>
  fc
    .record({
      version: fc.integer({ min: 1, max: 1000 }),
      body: fc.record({
        // Every layer writes under its own name as a key — makes it easy
        // to check "which layers survive in the final body".
        [layer]: fc.string({ minLength: 1, maxLength: 8 }),
      }),
    })
    .map(
      ({ version, body }) =>
        ({
          layer,
          object_id: OBJECT_ID,
          version,
          operation: "upsert" as const,
          merge_strategy: "merge_object" as const,
          body: body as Record<string, unknown>,
        }) satisfies LayerCandidate,
    );

const tombstoneCandidate = (layer: Layer): fc.Arbitrary<LayerCandidate> =>
  fc.constant<LayerCandidate>({
    layer,
    object_id: OBJECT_ID,
    version: 1,
    operation: "tombstone",
  });

/** At each layer: nothing, an upsert, or a tombstone. Bias toward upsert. */
const perLayerArb = (layer: Layer): fc.Arbitrary<LayerCandidate | null> =>
  fc.oneof(
    { weight: 3, arbitrary: upsertCandidate(layer) },
    { weight: 1, arbitrary: tombstoneCandidate(layer) },
    { weight: 1, arbitrary: fc.constant(null) },
  );

const stackArb = fc
  .tuple(
    perLayerArb("L0"),
    perLayerArb("L1"),
    perLayerArb("L2"),
    perLayerArb("L3"),
    perLayerArb("L4"),
  )
  .map((items) =>
    items
      .map((c, i) =>
        c === null
          ? null
          : ({
              ...c,
              tenant_id: i <= 1 ? null : TENANT,
            } satisfies LayerCandidate & { tenant_id: string | null }),
      )
      .filter((x): x is LayerCandidate & { tenant_id: string | null } => x !== null),
  );

// ── Invariant 1: determinism ─────────────────────────────────────────

describe("property: determinism", () => {
  it("same inputs produce structurally equal output", async () => {
    await fc.assert(
      fc.asyncProperty(stackArb, async (stack) => {
        const store1 = new InMemoryStore([...stack], LAYERS);
        const store2 = new InMemoryStore([...stack], LAYERS);
        const r1 = await resolve({ object_id: OBJECT_ID, tenant_id: TENANT }, store1);
        const r2 = await resolve({ object_id: OBJECT_ID, tenant_id: TENANT }, store2);
        expect(r1).toEqual(r2);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Invariant 2: tombstone correctness ───────────────────────────────

describe("property: tombstone correctness", () => {
  it("a tombstone at layer Lk severs contribution from every layer L<k", async () => {
    // Build: upsert at layers below Lk, tombstone at Lk, upsert at some
    // layers above. The result's provenance must NOT contain any layer
    // below the tombstone.
    const scenario = fc
      .integer({ min: 1, max: 4 })
      .chain((k) => {
        const below = LAYERS.slice(0, k);
        const above = LAYERS.slice(k + 1);
        return fc.record({
          tombstoneLayer: fc.constant(LAYERS[k]!),
          belowLayers: fc.constant(below),
          aboveLayers: fc.constant(above),
          aboveMask: fc.tuple(...above.map(() => fc.boolean())) as fc.Arbitrary<boolean[]>,
        });
      })
      .map(({ tombstoneLayer, belowLayers, aboveLayers, aboveMask }) => {
        const rows: (LayerCandidate & { tenant_id: string | null })[] = [];
        for (const l of belowLayers) {
          rows.push({
            layer: l,
            tenant_id: l === "L0" || l === "L1" ? null : TENANT,
            object_id: OBJECT_ID,
            version: 1,
            operation: "upsert",
            merge_strategy: "merge_object",
            body: { [l]: "x" },
          });
        }
        rows.push({
          layer: tombstoneLayer,
          tenant_id: tombstoneLayer === "L0" || tombstoneLayer === "L1" ? null : TENANT,
          object_id: OBJECT_ID,
          version: 1,
          operation: "tombstone",
        });
        aboveLayers.forEach((l, i) => {
          if (aboveMask[i]) {
            rows.push({
              layer: l,
              tenant_id: l === "L0" || l === "L1" ? null : TENANT,
              object_id: OBJECT_ID,
              version: 1,
              operation: "upsert",
              merge_strategy: "merge_object",
              body: { [l]: "y" },
            });
          }
        });
        return { rows, tombstoneLayer, belowLayers };
      });

    await fc.assert(
      fc.asyncProperty(scenario, async ({ rows, tombstoneLayer, belowLayers }) => {
        const store = new InMemoryStore(rows, LAYERS);
        const r = await resolve({ object_id: OBJECT_ID, tenant_id: TENANT }, store);

        if (Result.isErr(r)) {
          // If the result is object_not_found (no upserts above the tomb),
          // the invariant is trivially satisfied — no provenance at all.
          return;
        }

        // No provenance entry should be at a layer strictly below the
        // tombstone layer OR at the tombstone layer itself.
        const tombIdx = LAYERS.indexOf(tombstoneLayer);
        for (const entry of r.value.provenance) {
          const entryIdx = LAYERS.indexOf(entry.layer);
          expect(entryIdx).toBeGreaterThan(tombIdx);
        }

        // And the body must not contain keys named after the pre-tomb layers.
        for (const below of belowLayers) {
          expect(r.value.body).not.toHaveProperty(below);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ── Invariant 3: ordered layer application ──────────────────────────

describe("property: ordered layer application", () => {
  it("the final body contains the key `L{n}` iff L{n} upserted and no later layer tombstoned", async () => {
    // Stack constructed explicitly: pick a subset of layers for upserts
    // (each writing { [layer]: "ok" }), optionally choose a single
    // tombstone layer. Verify body contains EXACTLY the layer keys that
    // sit above the tombstone (or all of them, if no tombstone).
    const scenario = fc.record({
      upsertLayers: fc
        .subarray([...LAYERS], { minLength: 0, maxLength: LAYERS.length })
        .map((xs) => [...new Set(xs)]),
      tombstoneAt: fc.option(
        fc.integer({ min: 0, max: LAYERS.length - 1 }).map((i) => LAYERS[i]!),
        { nil: null, freq: 2 },
      ),
    });

    await fc.assert(
      fc.asyncProperty(scenario, async ({ upsertLayers, tombstoneAt }) => {
        // A layer holds either an upsert OR a tombstone — never both. If
        // the scenario chose the same layer for both, the tombstone wins
        // (upsert is discarded from the fixture before seeding).
        const effectiveUpserts = upsertLayers.filter((l) => l !== tombstoneAt);

        const rows: (LayerCandidate & { tenant_id: string | null })[] = [];
        for (const l of effectiveUpserts) {
          rows.push({
            layer: l,
            tenant_id: l === "L0" || l === "L1" ? null : TENANT,
            object_id: OBJECT_ID,
            version: 1,
            operation: "upsert",
            merge_strategy: "merge_object",
            body: { [l]: "ok" },
          });
        }
        if (tombstoneAt !== null) {
          rows.push({
            layer: tombstoneAt,
            tenant_id: tombstoneAt === "L0" || tombstoneAt === "L1" ? null : TENANT,
            object_id: OBJECT_ID,
            version: 1,
            operation: "tombstone",
          });
        }

        const store = new InMemoryStore(rows, LAYERS);
        const r = await resolve({ object_id: OBJECT_ID, tenant_id: TENANT }, store);

        const expectedKeys = effectiveUpserts.filter((l) => {
          if (tombstoneAt === null) return true;
          return LAYERS.indexOf(l) > LAYERS.indexOf(tombstoneAt);
        });

        if (expectedKeys.length === 0) {
          expect(Result.isErr(r)).toBe(true);
        } else {
          expect(Result.isOk(r)).toBe(true);
          if (r.ok) {
            expect(Object.keys(r.value.body).sort()).toEqual(expectedKeys.sort());
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
