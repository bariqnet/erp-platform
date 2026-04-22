import { describe, expect, it } from "vitest";

import { LocaleSchema, LocalizationBodySchema, LocalizedStringSchema } from "./localization.js";

describe("LocaleSchema", () => {
  it.each(["en", "ar", "ar-IQ", "fr-CA", "ku", "aii"])("accepts %s", (locale) => {
    expect(LocaleSchema.parse(locale)).toBe(locale);
  });

  it.each(["EN", "english", "en_US", "ar-iq", "", "a"])("rejects %s", (locale) => {
    expect(() => LocaleSchema.parse(locale)).toThrow();
  });
});

describe("LocalizedStringSchema", () => {
  it("requires the en fallback", () => {
    expect(() => LocalizedStringSchema.parse({ ar: "عميل" })).toThrow();
  });

  it("accepts en alone or en with extras", () => {
    expect(LocalizedStringSchema.parse({ en: "Customer" })).toEqual({ en: "Customer" });
    expect(LocalizedStringSchema.parse({ en: "Customer", ar: "عميل" })).toEqual({
      en: "Customer",
      ar: "عميل",
    });
  });

  it("rejects an empty English string", () => {
    expect(() => LocalizedStringSchema.parse({ en: "" })).toThrow();
  });

  it("round-trips through JSON", () => {
    const value = { en: "Customer", ar: "عميل", "ar-IQ": "زبون" };
    const parsed = LocalizedStringSchema.parse(
      JSON.parse(JSON.stringify(LocalizedStringSchema.parse(value))),
    );
    expect(parsed).toEqual(value);
  });
});

describe("LocalizationBodySchema", () => {
  it("accepts a valid localization override", () => {
    const value = {
      locale: "ar",
      target: "ent.customer",
      overrides: { label: "عميل", description: "عميل أو جهة تشتري السلع" },
    };
    expect(LocalizationBodySchema.parse(value)).toEqual(value);
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      LocalizationBodySchema.parse({
        locale: "ar",
        target: "ent.customer",
        overrides: {},
        extra: "nope",
      }),
    ).toThrow();
  });

  it("round-trips through JSON", () => {
    const value = {
      locale: "en",
      target: "ent.customer",
      overrides: { label: "Client", description: "A purchasing party." },
    };
    const parsed = LocalizationBodySchema.parse(
      JSON.parse(JSON.stringify(LocalizationBodySchema.parse(value))),
    );
    expect(parsed).toEqual(value);
  });
});
