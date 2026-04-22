import { describe, expect, it } from "vitest";

import { GrantActionSchema, PermissionBodySchema, type PermissionBody } from "./permission.js";

describe("GrantActionSchema", () => {
  it.each(["read", "create", "update", "delete", "approve", "reject", "submit", "export"])(
    "accepts %s",
    (action) => {
      expect(GrantActionSchema.parse(action)).toBe(action);
    },
  );

  it("rejects unknown actions", () => {
    expect(() => GrantActionSchema.parse("admin")).toThrow();
  });
});

describe("PermissionBodySchema", () => {
  const approver: PermissionBody = {
    role_id: "prm.po_approver",
    label: { en: "PO Approver", ar: "معتمد أمر الشراء" },
    description: "Approves purchase orders up to the role's spending limit.",
    entity_grants: {
      "ent.purchase_order": ["read", "approve", "reject"],
      "ent.supplier": ["read"],
    },
    field_grants: {
      "ent.purchase_order": {
        notes: ["read", "update"],
      },
    },
    record_predicate: "po.total <= 50000",
    implicit_owner: true,
    inherits_from: ["prm.po_viewer"],
  };

  it("accepts a full permission body", () => {
    expect(PermissionBodySchema.parse(approver)).toEqual(approver);
  });

  it("accepts a minimal permission body (just role_id)", () => {
    const minimal = { role_id: "prm.reader" };
    expect(PermissionBodySchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects a role_id that is not an ObjectId", () => {
    expect(() => PermissionBodySchema.parse({ role_id: "reader" })).toThrow();
  });

  it("rejects entity_grants with a non-ObjectId key", () => {
    expect(() =>
      PermissionBodySchema.parse({
        role_id: "prm.r",
        entity_grants: { Customer: ["read"] },
      }),
    ).toThrow();
  });

  it("rejects entity_grants with an unknown action", () => {
    expect(() =>
      PermissionBodySchema.parse({
        role_id: "prm.r",
        entity_grants: { "ent.customer": ["admin"] },
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => PermissionBodySchema.parse({ role_id: "prm.r", god_mode: true })).toThrow();
  });

  it("round-trips through JSON", () => {
    const parsed = PermissionBodySchema.parse(
      JSON.parse(JSON.stringify(PermissionBodySchema.parse(approver))),
    );
    expect(parsed).toEqual(approver);
  });
});
