import { describe, expect, it } from "vitest";

import {
  OperationSchema,
  OperationsSchema,
  TombstoneOperationSchema,
  UpsertOperationSchema,
} from "./operations.js";

describe("UpsertOperationSchema", () => {
  it("accepts a minimal upsert", () => {
    const v = {
      op: "upsert" as const,
      object_id: "ent.customer",
      object_type: "Entity" as const,
      layer: "L2" as const,
      body: { name: "Customer" },
    };
    expect(UpsertOperationSchema.parse(v)).toEqual(v);
  });

  it("accepts merge_list_by_key with key_field", () => {
    const v = {
      op: "upsert" as const,
      object_id: "ent.customer",
      object_type: "Entity" as const,
      layer: "L2" as const,
      body: { fields: [{ name: "tax_id" }] },
      merge_strategy: "merge_list_by_key" as const,
      key_field: "name",
    };
    expect(UpsertOperationSchema.parse(v)).toEqual(v);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      UpsertOperationSchema.parse({
        op: "upsert",
        object_id: "ent.x",
        object_type: "Entity",
        layer: "L2",
        body: {},
        surprise: 42,
      }),
    ).toThrow();
  });

  it("rejects a body that is not a plain record", () => {
    expect(() =>
      UpsertOperationSchema.parse({
        op: "upsert",
        object_id: "ent.x",
        object_type: "Entity",
        layer: "L2",
        body: [1, 2, 3],
      }),
    ).toThrow();
  });

  it("rejects an invalid layer", () => {
    expect(() =>
      UpsertOperationSchema.parse({
        op: "upsert",
        object_id: "ent.x",
        object_type: "Entity",
        layer: "L9",
        body: {},
      }),
    ).toThrow();
  });

  it("rejects an object_id that is not in the dotted-prefix shape", () => {
    expect(() =>
      UpsertOperationSchema.parse({
        op: "upsert",
        object_id: "Customer",
        object_type: "Entity",
        layer: "L2",
        body: {},
      }),
    ).toThrow();
  });
});

describe("TombstoneOperationSchema", () => {
  it("accepts a minimal tombstone", () => {
    const v = {
      op: "tombstone" as const,
      object_id: "ent.customer",
      layer: "L2" as const,
    };
    expect(TombstoneOperationSchema.parse(v)).toEqual(v);
  });

  it("accepts an optional reason", () => {
    const v = {
      op: "tombstone" as const,
      object_id: "ent.customer",
      layer: "L2" as const,
      reason: "retired",
    };
    expect(TombstoneOperationSchema.parse(v)).toEqual(v);
  });

  it("rejects a tombstone that also declares body", () => {
    expect(() =>
      TombstoneOperationSchema.parse({
        op: "tombstone",
        object_id: "ent.x",
        layer: "L2",
        body: { nope: true },
      }),
    ).toThrow();
  });
});

describe("OperationSchema discriminated union", () => {
  it("discriminates by op", () => {
    const u = OperationSchema.parse({
      op: "upsert",
      object_id: "ent.x",
      object_type: "Entity",
      layer: "L2",
      body: {},
    });
    expect(u.op).toBe("upsert");

    const t = OperationSchema.parse({
      op: "tombstone",
      object_id: "ent.x",
      layer: "L2",
    });
    expect(t.op).toBe("tombstone");
  });

  it("rejects an unknown op", () => {
    expect(() =>
      OperationSchema.parse({
        op: "delete",
        object_id: "ent.x",
        object_type: "Entity",
        layer: "L2",
        body: {},
      }),
    ).toThrow();
  });
});

describe("OperationsSchema round-trip", () => {
  it("JSON round-trips a mixed list", () => {
    const v = [
      {
        op: "upsert" as const,
        object_id: "ent.customer",
        object_type: "Entity" as const,
        layer: "L2" as const,
        body: { label: { en: "Customer" } },
        merge_strategy: "merge_object" as const,
      },
      {
        op: "tombstone" as const,
        object_id: "fld.customer.tax_id",
        layer: "L2" as const,
        reason: "never collected",
      },
    ];
    const parsed = OperationsSchema.parse(JSON.parse(JSON.stringify(OperationsSchema.parse(v))));
    expect(parsed).toEqual(v);
  });
});
