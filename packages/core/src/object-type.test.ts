import { describe, expect, it } from "vitest";

import { OBJECT_TYPE_ID_PREFIX, ObjectTypeSchema } from "./object-type.js";

describe("ObjectTypeSchema", () => {
  it.each([
    "Entity",
    "Field",
    "Relationship",
    "Workflow",
    "View",
    "Automation",
    "Permission",
    "Localization",
  ])("accepts RFC §2.2 type %s", (t) => {
    expect(ObjectTypeSchema.parse(t)).toBe(t);
  });

  it.each(["entity", "FIELD", "unknown", ""])("rejects %s", (t) => {
    expect(() => ObjectTypeSchema.parse(t)).toThrow();
  });

  it("has a non-overlapping prefix for every object type", () => {
    const prefixes = Object.values(OBJECT_TYPE_ID_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("round-trips through JSON", () => {
    const value = "Entity";
    expect(
      ObjectTypeSchema.parse(JSON.parse(JSON.stringify(ObjectTypeSchema.parse(value)))),
    ).toBe(value);
  });
});
