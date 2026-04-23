// Unit tests for zodFromField — one case per Field variant.

import { type Field } from "@erp/core";
import { describe, expect, it } from "vitest";

import { zodFromField } from "./field-zod.js";

describe("zodFromField", () => {
  it("string with min/max/regex", () => {
    const f: Field = {
      type: "string",
      name: "code",
      required: true,
      min_length: 3,
      max_length: 10,
      regex: "^[A-Z]+$",
    };
    const s = zodFromField(f);
    expect(s.safeParse("ABC").success).toBe(true);
    expect(s.safeParse("AB").success).toBe(false);
    expect(s.safeParse("abcdef").success).toBe(false);
  });

  it("integer with min/max", () => {
    const f: Field = { type: "integer", name: "qty", required: true, min: 0, max: 100 };
    const s = zodFromField(f);
    expect(s.safeParse(50).success).toBe(true);
    expect(s.safeParse(-1).success).toBe(false);
    expect(s.safeParse(1.5).success).toBe(false);
    expect(s.safeParse(101).success).toBe(false);
  });

  it("decimal respects min/max", () => {
    const f: Field = {
      type: "decimal",
      name: "rate",
      precision: 5,
      scale: 2,
      min: 0,
      max: 999.99,
      required: true,
    };
    const s = zodFromField(f);
    expect(s.safeParse(12.34).success).toBe(true);
    expect(s.safeParse(-0.1).success).toBe(false);
  });

  it("money validates integer minor units", () => {
    const f: Field = {
      type: "money",
      name: "total_fils",
      required: true,
      currency_field: "currency",
    };
    const s = zodFromField(f);
    expect(s.safeParse(1_000_000).success).toBe(true);
    expect(s.safeParse(1.5).success).toBe(false);
  });

  it("boolean accepts only true/false", () => {
    const s = zodFromField({ type: "boolean", name: "active", required: true });
    expect(s.safeParse(true).success).toBe(true);
    expect(s.safeParse("yes").success).toBe(false);
  });

  it("date requires YYYY-MM-DD", () => {
    const s = zodFromField({ type: "date", name: "birthday", required: true });
    expect(s.safeParse("2026-04-23").success).toBe(true);
    expect(s.safeParse("2026/04/23").success).toBe(false);
    expect(s.safeParse("2026-4-23").success).toBe(false);
  });

  it("datetime requires ISO 8601", () => {
    const s = zodFromField({ type: "datetime", name: "fired_at", required: true });
    expect(s.safeParse("2026-04-23T12:00:00.000Z").success).toBe(true);
    expect(s.safeParse("2026-04-23 12:00:00").success).toBe(false);
  });

  it("enum restricts to declared values", () => {
    const s = zodFromField({
      type: "enum",
      name: "tier",
      required: true,
      values: ["bronze", "silver", "gold"],
    });
    expect(s.safeParse("gold").success).toBe(true);
    expect(s.safeParse("platinum").success).toBe(false);
  });

  it("reference accepts only UUIDs", () => {
    const s = zodFromField({
      type: "reference",
      name: "customer_id",
      required: true,
      target: "ent.customer",
    });
    // Zod 4's .uuid() is stricter than v3 — variant bits must match
    // RFC 4122. Use a real v4 UUID for the positive case.
    expect(s.safeParse("f47ac10b-58cc-4372-a567-0e02b2c3d479").success).toBe(true);
    expect(s.safeParse("not-a-uuid").success).toBe(false);
  });

  it("phone requires E.164", () => {
    const s = zodFromField({ type: "phone", name: "mobile", required: true });
    expect(s.safeParse("+9647700000000").success).toBe(true);
    expect(s.safeParse("0770-000-0000").success).toBe(false);
  });

  it("localized_string accepts the {locale: value} shape", () => {
    const s = zodFromField({
      type: "localized_string",
      name: "label",
      required: true,
      max_length: 64,
    });
    expect(s.safeParse({ en: "Customer", ar: "عميل" }).success).toBe(true);
    expect(s.safeParse({ EN: "bad-locale" }).success).toBe(false);
  });

  it("non-required fields accept undefined", () => {
    const s = zodFromField({ type: "string", name: "nickname" });
    expect(s.safeParse(undefined).success).toBe(true);
    expect(s.safeParse("Bob").success).toBe(true);
  });

  it("required fields reject undefined", () => {
    const s = zodFromField({ type: "string", name: "id", required: true });
    expect(s.safeParse(undefined).success).toBe(false);
  });
});
