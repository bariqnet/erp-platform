import { describe, expect, it } from "vitest";

import {
  applyAppend,
  applyMergeListByKey,
  applyMergeObject,
  applyReplace,
  merge,
} from "./merge.js";

import type { LayerCandidate } from "@erp/core";

function candidate(partial: Partial<LayerCandidate> = {}): LayerCandidate {
  return {
    layer: "L2",
    object_id: "ent.customer",
    version: 1,
    operation: "upsert",
    body: {},
    ...partial,
  };
}

// ── applyReplace ──────────────────────────────────────────────────────

describe("applyReplace", () => {
  it("returns the overlay value", () => {
    expect(applyReplace(1, 2)).toBe(2);
    expect(applyReplace({ a: 1 }, { b: 2 })).toEqual({ b: 2 });
  });

  it("deep-clones the overlay so later mutation does not leak", () => {
    const overlay: { a: { b: number } } = { a: { b: 1 } };
    const base: { a: { b: number } } = { a: { b: 0 } };
    const out = applyReplace(base, overlay);
    overlay.a.b = 999;
    expect(out.a.b).toBe(1);
  });
});

// ── applyMergeObject ──────────────────────────────────────────────────

describe("applyMergeObject", () => {
  it("merges top-level keys with overlay winning", () => {
    const base = { a: 1, b: 2, c: 3 };
    const overlay = { b: 20, d: 40 };
    expect(applyMergeObject(base, overlay)).toEqual({ a: 1, b: 20, c: 3, d: 40 });
  });

  it("recursively merges nested plain objects", () => {
    const base = { label: { en: "Customer", ar: "عميل" }, storage: { strategy: "native" } };
    const overlay = { label: { ar: "زبون" } };
    expect(applyMergeObject(base, overlay)).toEqual({
      label: { en: "Customer", ar: "زبون" },
      storage: { strategy: "native" },
    });
  });

  it("replaces (not merges) arrays and scalars", () => {
    const base = { fields: [1, 2, 3], name: "x" };
    const overlay = { fields: [9], name: "y" };
    expect(applyMergeObject(base, overlay)).toEqual({ fields: [9], name: "y" });
  });

  it("does not mutate the base or overlay", () => {
    const base = { a: { b: 1 } };
    const overlay = { a: { c: 2 } };
    const out = applyMergeObject(base, overlay);
    expect(base).toEqual({ a: { b: 1 } });
    expect(overlay).toEqual({ a: { c: 2 } });
    expect(out).toEqual({ a: { b: 1, c: 2 } });
  });
});

// ── applyAppend ───────────────────────────────────────────────────────

describe("applyAppend", () => {
  it("concatenates two arrays", () => {
    expect(applyAppend([1, 2, 3], [4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  it("preserves duplicates — append is not set-union", () => {
    expect(applyAppend([1, 2], [2, 3])).toEqual([1, 2, 2, 3]);
  });

  it("deep-clones elements", () => {
    const original = { x: 1 };
    const out = applyAppend<object>([original], []);
    expect(out[0]).toEqual(original);
    expect(out[0]).not.toBe(original);
  });
});

// ── applyMergeListByKey ───────────────────────────────────────────────

describe("applyMergeListByKey", () => {
  const baseFields = [
    { name: "code", type: "string" },
    { name: "name", type: "string" },
  ];

  it("adds new entries, overrides matching entries", () => {
    const overlay = [
      { name: "name", type: "localized_string" },
      { name: "tax_id", type: "string" },
    ];
    expect(applyMergeListByKey(baseFields, overlay, "name")).toEqual([
      { name: "code", type: "string" },
      { name: "name", type: "localized_string" },
      { name: "tax_id", type: "string" },
    ]);
  });

  it("preserves base order", () => {
    const overlay = [{ name: "code", type: "int" }];
    const out = applyMergeListByKey(baseFields, overlay, "name");
    expect(out.map((e) => e.name)).toEqual(["code", "name"]);
  });

  it("throws when an overlay item is missing the key field", () => {
    expect(() => applyMergeListByKey(baseFields, [{ type: "string" }], "name")).toThrow(
      /missing key field "name"/,
    );
  });

  it("throws when keyField is the empty string", () => {
    expect(() => applyMergeListByKey(baseFields, [], "")).toThrow(/keyField/);
  });

  it("does not mutate inputs", () => {
    const base = [{ n: "a", v: 1 }];
    const overlay = [{ n: "a", v: 2 }];
    applyMergeListByKey(base, overlay, "n");
    expect(base).toEqual([{ n: "a", v: 1 }]);
    expect(overlay).toEqual([{ n: "a", v: 2 }]);
  });
});

// ── merge dispatcher ──────────────────────────────────────────────────

describe("merge dispatcher", () => {
  it("defaults to replace when no strategy is on the candidate", () => {
    const out = merge({ a: 1 }, { b: 2 }, candidate());
    expect(out).toEqual({ b: 2 });
  });

  it("applies replace explicitly", () => {
    const out = merge({ a: 1 }, { b: 2 }, candidate({ merge_strategy: "replace" }));
    expect(out).toEqual({ b: 2 });
  });

  it("applies merge_object", () => {
    const out = merge(
      { a: 1, b: 2 },
      { b: 20, c: 30 },
      candidate({ merge_strategy: "merge_object" }),
    );
    expect(out).toEqual({ a: 1, b: 20, c: 30 });
  });

  it("throws when merge_object is given a non-object", () => {
    expect(() => merge({ a: 1 }, [1, 2], candidate({ merge_strategy: "merge_object" }))).toThrow(
      /plain objects/,
    );
  });

  it("applies append", () => {
    const out = merge([1, 2], [3, 4], candidate({ merge_strategy: "append" }));
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it("throws when append is given a non-array", () => {
    expect(() => merge({ a: 1 }, [3, 4], candidate({ merge_strategy: "append" }))).toThrow(
      /arrays/,
    );
  });

  it("applies merge_list_by_key with the candidate's key_field", () => {
    const out = merge(
      [{ name: "code" }, { name: "name" }],
      [{ name: "name", type: "localized" }],
      candidate({ merge_strategy: "merge_list_by_key", key_field: "name" }),
    );
    expect(out).toEqual([{ name: "code" }, { name: "name", type: "localized" }]);
  });

  it("throws when merge_list_by_key is missing key_field on the candidate", () => {
    expect(() => merge([], [], candidate({ merge_strategy: "merge_list_by_key" }))).toThrow(
      /key_field/,
    );
  });

  it("throws when merge_list_by_key items are not plain objects", () => {
    expect(() =>
      merge([1, 2], [3], candidate({ merge_strategy: "merge_list_by_key", key_field: "name" })),
    ).toThrow(/plain objects/);
  });
});
