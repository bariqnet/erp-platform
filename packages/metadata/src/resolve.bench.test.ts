// TASK-06 · Resolver benchmark.
//
// Required by the task: 30-field entity through 3 layers resolves in
// under 0.5 ms p99. The measurement is of the resolver's own work —
// the store is an in-memory Map, so fetchCandidate is O(1) and
// contributes negligible overhead.
//
// Ran via `pnpm test` along with the rest of the suite; the assertion
// turns a SLO into a regression test. If a future change pushes p99
// above 0.5 ms, CI catches it.

import { Result } from "@erp/core";
import { describe, expect, it } from "vitest";

import { resolve } from "./resolve.js";

import type { Layer, LayerCandidate, MetadataStore } from "@erp/core";

const TENANT = "t_bench";
const OBJECT_ID = "ent.customer";
const LAYERS: readonly Layer[] = ["L0", "L1", "L2"];

/**
 * In-memory store. O(1) lookups via Map so the benchmark reflects only
 * the resolver's internal work.
 */
class BenchStore implements MetadataStore {
  private index = new Map<string, LayerCandidate>();

  constructor(rows: (LayerCandidate & { tenant_id: string | null })[]) {
    for (const r of rows) {
      const { tenant_id: _t, ...rest } = r;
      this.index.set(`${r.layer}|${r.object_id}|${r.tenant_id ?? "*"}`, rest);
    }
  }

  async fetchCandidate(params: {
    layer: Layer;
    object_id: string;
    tenant_id: string | null;
  }): Promise<LayerCandidate | null> {
    return this.index.get(`${params.layer}|${params.object_id}|${params.tenant_id ?? "*"}`) ?? null;
  }

  async getActiveLayers(): Promise<readonly Layer[]> {
    return LAYERS;
  }
}

// Build a 30-field Customer-ish body. Lives at body.fields as an array.
function makeFields(count: number): Array<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    fields.push({
      name: `f${i}`,
      type: i % 3 === 0 ? "string" : i % 3 === 1 ? "integer" : "boolean",
      required: i % 2 === 0,
      max_length: 255,
    });
  }
  return fields;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx]!;
}

describe("resolve — benchmark", () => {
  it("30-field entity through 3 layers resolves in under 0.5 ms p99", async () => {
    const baseFields = makeFields(30);
    const l1Fields = [...baseFields, { name: "f30", type: "string" }];
    const l2Fields = [...l1Fields, { name: "f31", type: "integer" }];

    const store = new BenchStore([
      {
        layer: "L0",
        tenant_id: null,
        object_id: OBJECT_ID,
        version: 1,
        operation: "upsert",
        body: { name: "Customer", label: { en: "Customer" }, fields: baseFields },
      },
      {
        layer: "L1",
        tenant_id: null,
        object_id: OBJECT_ID,
        version: 1,
        operation: "upsert",
        merge_strategy: "merge_object",
        body: { label: { ar: "عميل" }, fields: l1Fields },
      },
      {
        layer: "L2",
        tenant_id: TENANT,
        object_id: OBJECT_ID,
        version: 1,
        operation: "upsert",
        merge_strategy: "merge_object",
        body: { icon: "users", fields: l2Fields },
      },
    ]);

    // Warm-up: V8 inlines hot paths after a few hundred calls. Measure
    // after the profile is stable.
    for (let i = 0; i < 200; i += 1) {
      const r = await resolve({ object_id: OBJECT_ID, tenant_id: TENANT }, store);
      expect(Result.isOk(r)).toBe(true);
    }

    const N = 1000;
    const samples = new Array<number>(N);
    for (let i = 0; i < N; i += 1) {
      const start = performance.now();
      const r = await resolve({ object_id: OBJECT_ID, tenant_id: TENANT }, store);
      const end = performance.now();
      if (!r.ok) throw new Error("benchmark: unexpected err");
      samples[i] = end - start;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    const p95 = quantile(sorted, 0.95);
    const p99 = quantile(sorted, 0.99);
    const max = sorted[sorted.length - 1]!;

    // Reported as a sanity log — failure is only on p99 threshold.
    console.warn(
      `[resolve bench] p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms ` +
        `p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms (N=${N})`,
    );

    expect(p99).toBeLessThan(0.5);
  });
});
