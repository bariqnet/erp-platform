import { describe, expect, it } from "vitest";

import {
  EntityBodySchema,
  EntityNameSchema,
  LifecycleSchema,
  StorageSchema,
  allowedTransitionsFrom,
  findLifecycleTransition,
  type EntityBody,
  type Lifecycle,
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

  it("accepts a transitions array referencing only declared states", () => {
    const value = {
      states: ["draft", "active", "archived"],
      initial: "draft",
      transitions: [
        { from: "draft", to: "active", action: "activate" },
        { from: "active", to: "archived", action: "archive" },
        { from: "active", to: "draft" }, // action-less: PATCH-driven only
      ],
    };
    expect(LifecycleSchema.parse(value)).toEqual(value);
  });

  it("rejects a transition.from outside states", () => {
    // Zod 4 errors stringify as a JSON array of issues — quotes inside
    // the message get escaped. Matching on the non-quoted portion
    // keeps the assertion tight without fighting the serialization.
    expect(() =>
      LifecycleSchema.parse({
        states: ["draft", "active"],
        initial: "draft",
        transitions: [{ from: "stale", to: "active", action: "activate" }],
      }),
    ).toThrow(/transition\.from .*stale.* is not in states/);
  });

  it("rejects a transition.to outside states", () => {
    expect(() =>
      LifecycleSchema.parse({
        states: ["draft", "active"],
        initial: "draft",
        transitions: [{ from: "draft", to: "void", action: "activate" }],
      }),
    ).toThrow(/transition\.to .*void.* is not in states/);
  });

  it("allows an action name to repeat across different `from` states", () => {
    // `start` from `open` vs `start` from `reopened` is fine — semantically
    // they both mean "begin work" and land in the same target state.
    const value = {
      states: ["open", "in_progress", "resolved", "reopened"],
      initial: "open",
      transitions: [
        { from: "open", to: "in_progress", action: "start" },
        { from: "reopened", to: "in_progress", action: "start" },
      ],
    };
    expect(LifecycleSchema.parse(value)).toEqual(value);
  });

  it("rejects a duplicate (from, action) pair", () => {
    // Two `start` actions from `a` would give one caller-visible route
    // two possible destinations — ambiguous, must reject.
    expect(() =>
      LifecycleSchema.parse({
        states: ["a", "b", "c"],
        initial: "a",
        transitions: [
          { from: "a", to: "b", action: "start" },
          { from: "a", to: "c", action: "start" },
        ],
      }),
    ).toThrow(/duplicate \(from, action\).*a.*start/);
  });

  it("round-trips transitions through JSON", () => {
    const lc: Lifecycle = {
      states: ["draft", "active", "archived"],
      initial: "draft",
      transitions: [
        { from: "draft", to: "active", action: "activate" },
        { from: "active", to: "archived", action: "archive" },
      ],
    };
    const parsed = LifecycleSchema.parse(JSON.parse(JSON.stringify(LifecycleSchema.parse(lc))));
    expect(parsed).toEqual(lc);
  });
});

describe("findLifecycleTransition + allowedTransitionsFrom", () => {
  const lc: Lifecycle = {
    states: ["draft", "active", "on_hold", "archived"],
    initial: "draft",
    transitions: [
      { from: "draft", to: "active", action: "activate" },
      { from: "active", to: "on_hold", action: "hold" },
      { from: "on_hold", to: "active", action: "resume" },
      { from: "active", to: "archived", action: "archive" },
      { from: "draft", to: "draft" }, // action-less self-loop
    ],
  };

  it("matches a transition by action + current state", () => {
    expect(findLifecycleTransition(lc, "draft", { action: "activate" })).toEqual({
      from: "draft",
      to: "active",
      action: "activate",
    });
  });

  it("returns null for an action declared but not legal from current state", () => {
    expect(findLifecycleTransition(lc, "archived", { action: "activate" })).toBeNull();
  });

  it("matches a transition by target state", () => {
    expect(findLifecycleTransition(lc, "on_hold", { toState: "active" })).toEqual({
      from: "on_hold",
      to: "active",
      action: "resume",
    });
  });

  it("enumerates allowed transitions from a state", () => {
    expect(allowedTransitionsFrom(lc, "active")).toEqual([
      { from: "active", to: "on_hold", action: "hold" },
      { from: "active", to: "archived", action: "archive" },
    ]);
  });

  it("returns an empty array when the state has no outgoing transitions", () => {
    expect(allowedTransitionsFrom(lc, "archived")).toEqual([]);
  });

  it("returns an empty array when the lifecycle has no transitions at all", () => {
    const noTransitions: Lifecycle = { states: ["draft"], initial: "draft" };
    expect(allowedTransitionsFrom(noTransitions, "draft")).toEqual([]);
    expect(findLifecycleTransition(noTransitions, "draft", { action: "anything" })).toBeNull();
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
