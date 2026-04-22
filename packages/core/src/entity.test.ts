import { describe, expect, it } from "vitest";

import {
  EntityBodySchema,
  EntityNameSchema,
  LifecycleSchema,
  StorageSchema,
  type EntityBody,
} from "./entity.js";

describe("EntityNameSchema", () => {
  it.each(["Customer", "PurchaseOrder", "Invoice", "T"])("accepts %s", (n) => {
    expect(EntityNameSchema.parse(n)).toBe(n);
  });

  it.each(["customer", "1Customer", "Customer-Name", "", "a".repeat(65)])("rejects %s", (n) => {
    expect(() => EntityNameSchema.parse(n)).toThrow();
  });
});

describe("StorageSchema", () => {
  it("accepts each of the four strategies", () => {
    for (const strategy of ["native", "hybrid", "jsonb", "side_table"] as const) {
      expect(StorageSchema.parse({ strategy })).toEqual({ strategy });
    }
  });

  it("accepts an optional table name", () => {
    expect(StorageSchema.parse({ strategy: "hybrid", table: "cust_customer" })).toEqual({
      strategy: "hybrid",
      table: "cust_customer",
    });
  });

  it("rejects an invalid strategy", () => {
    expect(() => StorageSchema.parse({ strategy: "memory" })).toThrow();
  });
});

describe("LifecycleSchema", () => {
  it("accepts a valid lifecycle", () => {
    const value = {
      states: ["draft", "active", "archived"],
      initial: "draft",
      workflow_id: "wfl.customer_lifecycle",
    };
    expect(LifecycleSchema.parse(value)).toEqual(value);
  });

  it("rejects when initial is not in states", () => {
    expect(() => LifecycleSchema.parse({ states: ["a", "b"], initial: "c" })).toThrow(
      /initial state .* must appear in states/,
    );
  });
});

describe("EntityBodySchema", () => {
  const customer: EntityBody = {
    name: "Customer",
    plural: "Customers",
    label: { en: "Customer", ar: "عميل" },
    icon: "users",
    description: "A person or organization that purchases goods or services.",
    storage: { table: "cust_customer", strategy: "hybrid" },
    fields: [
      { name: "code", type: "string", required: true, unique: true, max_length: 32 },
      { name: "name", type: "string", required: true, max_length: 255, i18n: true },
      { name: "currency", type: "string", required: true, max_length: 3 },
      { name: "credit_limit", type: "money", currency_field: "currency", default: 0 },
      { name: "tax_id", type: "string", max_length: 64 },
    ],
    relationships: [
      { name: "primary_contact", type: "many_to_one", target: "ent.contact", cascade: "nullify" },
      { name: "invoices", type: "one_to_many", target: "ent.invoice", via: "customer_id" },
    ],
    lifecycle: {
      states: ["draft", "active", "on_hold", "archived"],
      initial: "draft",
      workflow_id: "wfl.customer_lifecycle",
    },
    indexes: [
      { fields: ["code"], unique: true },
      { fields: ["name"] },
      { fields: ["tax_id"], where: "tax_id IS NOT NULL" },
    ],
    permissions_base: "prm.customer_defaults",
    audit: true,
  };

  it("accepts the RFC §2.3 Customer example", () => {
    expect(EntityBodySchema.parse(customer)).toEqual(customer);
  });

  it("rejects duplicate field names", () => {
    expect(() =>
      EntityBodySchema.parse({
        ...customer,
        fields: [
          { name: "code", type: "string" },
          { name: "code", type: "integer" },
        ],
      }),
    ).toThrow(/duplicate field name/);
  });

  it("rejects a money field whose currency_field does not exist", () => {
    expect(() =>
      EntityBodySchema.parse({
        ...customer,
        fields: [
          { name: "code", type: "string" },
          { name: "credit_limit", type: "money", currency_field: "missing_currency" },
        ],
      }),
    ).toThrow(/currency_field.*missing_currency/);
  });

  it("rejects a stray top-level key", () => {
    expect(() => EntityBodySchema.parse({ ...customer, surprise: true })).toThrow();
  });

  it("requires at least one field", () => {
    expect(() => EntityBodySchema.parse({ ...customer, fields: [] })).toThrow();
  });

  it("round-trips through JSON", () => {
    const parsed = EntityBodySchema.parse(
      JSON.parse(JSON.stringify(EntityBodySchema.parse(customer))),
    );
    expect(parsed).toEqual(customer);
  });
});
