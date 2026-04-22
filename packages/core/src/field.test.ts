import { describe, expect, it } from "vitest";

import {
  FIELD_TYPES,
  FieldNameSchema,
  FieldSchema,
  MoneyFieldSchema,
  ReferenceFieldSchema,
  StringFieldSchema,
  type Field,
} from "./field.js";

describe("FieldNameSchema", () => {
  it.each(["name", "tax_id", "credit_limit", "a1"])("accepts %s", (name) => {
    expect(FieldNameSchema.parse(name)).toBe(name);
  });

  it.each(["Name", "1field", "tax-id", "tax.id", "", "a".repeat(64)])("rejects %s", (name) => {
    expect(() => FieldNameSchema.parse(name)).toThrow();
  });
});

describe("FIELD_TYPES", () => {
  it("covers the 15 variants shipped in TASK-04", () => {
    expect(FIELD_TYPES).toHaveLength(15);
    expect(new Set(FIELD_TYPES).size).toBe(FIELD_TYPES.length);
  });

  it.each(FIELD_TYPES)("the discriminated union accepts a minimal %s field", (type) => {
    const minimal: Record<string, unknown> = { name: "f", type };
    if (type === "decimal") {
      minimal.precision = 10;
      minimal.scale = 2;
    }
    if (type === "money") minimal.currency_field = "currency";
    if (type === "enum") minimal.values = ["a", "b"];
    if (type === "reference") minimal.target = "ent.other";
    if (type === "formula") {
      minimal.expression = "1 + 1";
      minimal.result_type = "integer";
    }
    if (type === "national_id") minimal.country = "IQ";

    expect(() => FieldSchema.parse(minimal)).not.toThrow();
  });
});

describe("FieldSchema — type-specific rules", () => {
  it("StringField accepts max_length, min_length, regex", () => {
    const v = {
      name: "code",
      type: "string" as const,
      max_length: 32,
      min_length: 1,
      regex: "^[A-Z0-9]+$",
      required: true,
      unique: true,
    };
    expect(StringFieldSchema.parse(v)).toEqual(v);
  });

  it("MoneyField requires currency_field", () => {
    expect(() => MoneyFieldSchema.parse({ name: "amount", type: "money" })).toThrow();
    expect(
      MoneyFieldSchema.parse({
        name: "amount",
        type: "money",
        currency_field: "currency",
        default: 0,
      }),
    ).toBeDefined();
  });

  it("ReferenceField requires a target with an ent./fld./... prefix", () => {
    expect(() =>
      ReferenceFieldSchema.parse({ name: "customer", type: "reference", target: "Customer" }),
    ).toThrow();
    expect(
      ReferenceFieldSchema.parse({
        name: "customer",
        type: "reference",
        target: "ent.customer",
        on_delete: "restrict",
      }),
    ).toBeDefined();
  });

  it("rejects an unknown field type at the discriminator", () => {
    expect(() => FieldSchema.parse({ name: "x", type: "widget" })).toThrow();
  });

  it("rejects unknown keys in strict mode", () => {
    expect(() =>
      StringFieldSchema.parse({
        name: "code",
        type: "string",
        surprise: "nope",
      }),
    ).toThrow();
  });
});

describe("FieldSchema — round-trip", () => {
  it("JSON round-trip preserves a rich string field", () => {
    const value: Field = {
      name: "name",
      type: "string",
      max_length: 255,
      required: true,
      i18n: true,
      label: { en: "Name", ar: "الاسم" },
    };
    const parsed = FieldSchema.parse(JSON.parse(JSON.stringify(FieldSchema.parse(value))));
    expect(parsed).toEqual(value);
  });

  it("JSON round-trip preserves a money field", () => {
    const value: Field = {
      name: "credit_limit",
      type: "money",
      currency_field: "currency",
      default: 0,
      label: { en: "Credit Limit", ar: "حد الائتمان" },
    };
    const parsed = FieldSchema.parse(JSON.parse(JSON.stringify(FieldSchema.parse(value))));
    expect(parsed).toEqual(value);
  });

  it("JSON round-trip preserves an enum field with labels", () => {
    const value: Field = {
      name: "loyalty_tier",
      type: "enum",
      values: ["bronze", "silver", "gold", "platinum"],
      labels: {
        bronze: { en: "Bronze", ar: "برونزي" },
        silver: { en: "Silver" },
        gold: { en: "Gold" },
        platinum: { en: "Platinum" },
      },
      default: "bronze",
    };
    const parsed = FieldSchema.parse(JSON.parse(JSON.stringify(FieldSchema.parse(value))));
    expect(parsed).toEqual(value);
  });
});
