import { describe, expect, it } from "vitest";

import { RelationshipSchema, type Relationship } from "./relationship.js";

describe("RelationshipSchema", () => {
  it("accepts a minimal many_to_one", () => {
    const value: Relationship = {
      name: "primary_contact",
      type: "many_to_one",
      target: "ent.contact",
    };
    expect(RelationshipSchema.parse(value)).toEqual(value);
  });

  it("accepts a one_to_many with `via`", () => {
    const value: Relationship = {
      name: "invoices",
      type: "one_to_many",
      target: "ent.invoice",
      via: "customer_id",
    };
    expect(RelationshipSchema.parse(value)).toEqual(value);
  });

  it("rejects a one_to_many without `via`", () => {
    expect(() =>
      RelationshipSchema.parse({
        name: "invoices",
        type: "one_to_many",
        target: "ent.invoice",
      }),
    ).toThrow();
  });

  it("rejects an invalid cascade", () => {
    expect(() =>
      RelationshipSchema.parse({
        name: "primary_contact",
        type: "many_to_one",
        target: "ent.contact",
        cascade: "cascade_always",
      }),
    ).toThrow();
  });

  it("rejects a target that is not an ObjectId", () => {
    expect(() =>
      RelationshipSchema.parse({
        name: "primary_contact",
        type: "many_to_one",
        target: "Contact",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      RelationshipSchema.parse({
        name: "primary_contact",
        type: "many_to_one",
        target: "ent.contact",
        surprise: "nope",
      }),
    ).toThrow();
  });

  it("JSON round-trip preserves a rich relationship", () => {
    const value: Relationship = {
      name: "invoices",
      type: "one_to_many",
      target: "ent.invoice",
      via: "customer_id",
      cascade: "restrict",
      label: { en: "Invoices", ar: "الفواتير" },
      description: "Every invoice billed to this customer.",
      required: false,
    };
    const parsed = RelationshipSchema.parse(
      JSON.parse(JSON.stringify(RelationshipSchema.parse(value))),
    );
    expect(parsed).toEqual(value);
  });
});
