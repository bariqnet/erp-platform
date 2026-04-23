// Unit tests for the materializer + its version-keyed cache.

import { type EntityBody } from "@erp/core";
import { type ResolvedObject } from "@erp/metadata";
import { describe, expect, it } from "vitest";

import { MaterializedEntityCache } from "./entity-cache.js";
import { materialize, materializeEntity } from "./materialize.js";

const CUSTOMER: EntityBody = {
  name: "Customer",
  plural: "Customers",
  label: { en: "Customer", ar: "عميل" },
  storage: { strategy: "jsonb" },
  fields: [
    { name: "name", type: "string", required: true, max_length: 120 },
    { name: "phone", type: "phone", required: false },
    {
      name: "loyalty_tier",
      type: "enum",
      required: false,
      values: ["bronze", "silver", "gold"],
    },
    { name: "currency", type: "string", required: true, max_length: 3 },
    {
      name: "credit_limit_fils",
      type: "money",
      required: false,
      currency_field: "currency",
    },
  ],
};

describe("materializeEntity", () => {
  it("returns fieldsByName, createValidator, patchValidator", () => {
    const m = materializeEntity(CUSTOMER);
    expect(m.entity).toBe(CUSTOMER);
    expect(m.fieldsByName.get("name")?.type).toBe("string");
    expect(m.fieldsByName.size).toBe(5);
    expect(typeof m.createValidator.parse).toBe("function");
    expect(typeof m.patchValidator.parse).toBe("function");
  });

  it("createValidator enforces required fields", () => {
    const m = materializeEntity(CUSTOMER);
    const ok = m.createValidator.safeParse({
      name: "Acme",
      currency: "IQD",
      loyalty_tier: "gold",
    });
    expect(ok.success).toBe(true);

    const missingRequired = m.createValidator.safeParse({ phone: "+9647700000000" });
    expect(missingRequired.success).toBe(false);
  });

  it("createValidator rejects unknown keys (strict)", () => {
    const m = materializeEntity(CUSTOMER);
    const unknown = m.createValidator.safeParse({
      name: "Acme",
      currency: "IQD",
      definitely_not_a_field: 42,
    });
    expect(unknown.success).toBe(false);
  });

  it("patchValidator skips required enforcement", () => {
    const m = materializeEntity(CUSTOMER);
    const partial = m.patchValidator.safeParse({ loyalty_tier: "silver" });
    expect(partial.success).toBe(true);
    const empty = m.patchValidator.safeParse({});
    expect(empty.success).toBe(true);
  });

  it("patchValidator still enforces per-field shape", () => {
    const m = materializeEntity(CUSTOMER);
    const bad = m.patchValidator.safeParse({ loyalty_tier: "platinum" });
    expect(bad.success).toBe(false);
  });

  it("validates enum members correctly", () => {
    const m = materializeEntity(CUSTOMER);
    const good = m.createValidator.safeParse({
      name: "Acme",
      currency: "IQD",
      loyalty_tier: "gold",
    });
    expect(good.success).toBe(true);
    const bad = m.createValidator.safeParse({
      name: "Acme",
      currency: "IQD",
      loyalty_tier: "diamond",
    });
    expect(bad.success).toBe(false);
  });
});

describe("materialize(ResolvedObject)", () => {
  it("happy path — EntityBody-shaped body materializes", () => {
    // Round-trip through JSON so the ResolvedObject.body type
    // (Record<string, unknown>) is reached via Zod/JSON rather than a
    // TypeScript `as unknown as` cast — scripts/verify.ts invariant
    // #3 flags that pattern.
    const resolved: ResolvedObject = {
      object_id: "ent.customer",
      body: JSON.parse(JSON.stringify(CUSTOMER)) as Record<string, unknown>,
      provenance: [{ layer: "L0", version: 1, object_id: "ent.customer" }],
    };
    const m = materialize(resolved);
    expect(m.entity.name).toBe("Customer");
  });

  it("throws when the body is not a valid EntityBody", () => {
    const resolved: ResolvedObject = {
      object_id: "ent.broken",
      body: { this: "is not an entity" },
      provenance: [],
    };
    expect(() => materialize(resolved)).toThrow(/not a valid EntityBody/);
  });
});

describe("MaterializedEntityCache", () => {
  it("stores + retrieves by (tenant, entity, version)", () => {
    const cache = new MaterializedEntityCache();
    const m = materializeEntity(CUSTOMER);
    cache.set("t_a", "ent.customer", 1, m);
    expect(cache.get("t_a", "ent.customer", 1)).toBe(m);
    expect(cache.get("t_a", "ent.customer", 2)).toBeUndefined();
    expect(cache.get("t_b", "ent.customer", 1)).toBeUndefined();
  });

  it("evicts the oldest entry when maxEntries is reached", () => {
    const cache = new MaterializedEntityCache({ maxEntries: 2 });
    const m = materializeEntity(CUSTOMER);
    cache.set("t_a", "ent.customer", 1, m);
    cache.set("t_a", "ent.customer", 2, m);
    cache.set("t_a", "ent.customer", 3, m);
    expect(cache.size).toBe(2);
    expect(cache.get("t_a", "ent.customer", 1)).toBeUndefined();
    expect(cache.get("t_a", "ent.customer", 2)).toBe(m);
    expect(cache.get("t_a", "ent.customer", 3)).toBe(m);
  });

  it("get touches the LRU order", () => {
    const cache = new MaterializedEntityCache({ maxEntries: 2 });
    const m = materializeEntity(CUSTOMER);
    cache.set("t_a", "ent.customer", 1, m);
    cache.set("t_a", "ent.customer", 2, m);
    cache.get("t_a", "ent.customer", 1); // refresh
    cache.set("t_a", "ent.customer", 3, m);
    // version 2 should be evicted, not 1.
    expect(cache.get("t_a", "ent.customer", 1)).toBe(m);
    expect(cache.get("t_a", "ent.customer", 2)).toBeUndefined();
    expect(cache.get("t_a", "ent.customer", 3)).toBe(m);
  });
});
