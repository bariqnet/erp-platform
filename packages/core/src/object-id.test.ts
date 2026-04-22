import { describe, expect, it } from "vitest";

import { ObjectIdSchema } from "./object-id.js";

describe("ObjectIdSchema", () => {
  it.each([
    "ent.customer",
    "ent.purchase_order",
    "fld.customer.tax_id",
    "rel.invoice.customer",
    "wfl.po_lifecycle",
    "vw.customer_list",
    "aut.on_invoice_posted",
    "prm.po_approver",
    "loc.ar.customer",
  ])("accepts a valid id %s", (id) => {
    expect(ObjectIdSchema.parse(id)).toBe(id);
  });

  it.each([
    "Customer", // no prefix
    "entity.customer", // wrong prefix
    "ent", // missing segment
    "ent.", // empty segment
    "ent.Customer", // uppercase segment
    "ent.1customer", // segment starts with digit
    "ent.customer.", // trailing dot
    "ent.customer-name", // hyphen in segment
    "", // empty
  ])("rejects an invalid id %s", (id) => {
    expect(() => ObjectIdSchema.parse(id)).toThrow();
  });

  it("round-trips through JSON", () => {
    const value = "ent.customer";
    expect(ObjectIdSchema.parse(JSON.parse(JSON.stringify(ObjectIdSchema.parse(value))))).toBe(
      value,
    );
  });
});
