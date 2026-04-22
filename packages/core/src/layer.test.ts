import { describe, expect, it } from "vitest";

import { LayerSchema, TENANT_SCOPED_LAYERS, VENDOR_GLOBAL_LAYERS, type Layer } from "./layer.js";

describe("LayerSchema", () => {
  it.each(["L0", "L1", "L2", "L3", "L4"])("accepts the canonical layer %s", (layer) => {
    expect(LayerSchema.parse(layer)).toBe(layer);
  });

  it.each(["L5", "l0", "", "L10", "level-0"])("rejects non-canonical %s", (layer) => {
    expect(() => LayerSchema.parse(layer)).toThrow();
  });

  it("partitions layers by tenant-scope", () => {
    const union = [...TENANT_SCOPED_LAYERS, ...VENDOR_GLOBAL_LAYERS] satisfies readonly Layer[];
    expect(new Set(union)).toEqual(new Set(["L0", "L1", "L2", "L3", "L4"]));
    const overlap = TENANT_SCOPED_LAYERS.filter((l) => VENDOR_GLOBAL_LAYERS.includes(l));
    expect(overlap).toHaveLength(0);
  });

  it("round-trips through JSON", () => {
    const value: Layer = "L2";
    const parsed = LayerSchema.parse(JSON.parse(JSON.stringify(LayerSchema.parse(value))));
    expect(parsed).toBe(value);
  });
});
