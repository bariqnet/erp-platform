import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EntityBodySchema } from "./entity.js";
import {
  EnvelopeSchema,
  TombstoneEnvelopeSchema,
  UpsertEnvelopeSchema,
  envelopeWithBody,
  type Envelope,
  type UpsertEnvelope,
} from "./envelope.js";

const BASE = {
  object_id: "ent.customer",
  object_type: "Entity" as const,
  layer: "L2" as const,
  tenant_id: "t_4f8a3c",
  template_id: null,
  version: 37,
  valid_from: "2026-04-15T09:30:00.000Z",
  valid_until: null,
  created_by: "u_7b2f",
  created_via: "configuration_studio",
  change_set_id: "cs_9e4a",
};

describe("UpsertEnvelopeSchema", () => {
  it("parses the RFC §2.1 example", () => {
    const value = {
      ...BASE,
      operation: "upsert" as const,
      body: { type_specific: "payload" },
    };
    expect(UpsertEnvelopeSchema.parse(value)).toEqual(value);
  });

  it("rejects an envelope with the wrong operation literal", () => {
    expect(() =>
      UpsertEnvelopeSchema.parse({ ...BASE, operation: "tombstone", body: {} }),
    ).toThrow();
  });

  it("rejects a stray top-level key (strict)", () => {
    expect(() =>
      UpsertEnvelopeSchema.parse({
        ...BASE,
        operation: "upsert",
        body: {},
        rogue: 42,
      }),
    ).toThrow();
  });

  it("round-trips through JSON", () => {
    const value = { ...BASE, operation: "upsert" as const, body: { a: 1, b: "two" } };
    const parsed = UpsertEnvelopeSchema.parse(
      JSON.parse(JSON.stringify(UpsertEnvelopeSchema.parse(value))),
    );
    expect(parsed).toEqual(value);
  });
});

describe("TombstoneEnvelopeSchema", () => {
  it("parses a tombstone with a reason", () => {
    const value = {
      ...BASE,
      operation: "tombstone" as const,
      reason: "Tenant does not collect tax IDs; field hidden from all forms.",
    };
    expect(TombstoneEnvelopeSchema.parse(value)).toEqual(value);
  });

  it("parses a tombstone without a reason (legacy import compat)", () => {
    const value = { ...BASE, operation: "tombstone" as const };
    expect(TombstoneEnvelopeSchema.parse(value)).toEqual(value);
  });

  it("allows explicit body: null", () => {
    const value = { ...BASE, operation: "tombstone" as const, body: null, reason: "x" };
    expect(TombstoneEnvelopeSchema.parse(value)).toEqual(value);
  });

  it("rejects a tombstone with a non-null body", () => {
    expect(() =>
      TombstoneEnvelopeSchema.parse({
        ...BASE,
        operation: "tombstone",
        body: { oops: true },
      }),
    ).toThrow();
  });

  it("round-trips through JSON", () => {
    const value = {
      ...BASE,
      operation: "tombstone" as const,
      reason: "No longer in use.",
    };
    const parsed = TombstoneEnvelopeSchema.parse(
      JSON.parse(JSON.stringify(TombstoneEnvelopeSchema.parse(value))),
    );
    expect(parsed).toEqual(value);
  });
});

describe("EnvelopeSchema discriminated union", () => {
  it("discriminates upsert vs tombstone by `operation`", () => {
    const upsert = EnvelopeSchema.parse({ ...BASE, operation: "upsert", body: {} });
    const tomb = EnvelopeSchema.parse({ ...BASE, operation: "tombstone", reason: "x" });
    expect(upsert.operation).toBe("upsert");
    expect(tomb.operation).toBe("tombstone");
  });

  it("narrows `body` based on operation", () => {
    const envelope: Envelope = { ...BASE, operation: "upsert", body: { a: 1 } };
    if (envelope.operation === "upsert") {
      // Type narrowing: body is unknown, not optional-null.
      expect(envelope.body).toEqual({ a: 1 });
    }
  });

  it("rejects an unknown operation", () => {
    expect(() => EnvelopeSchema.parse({ ...BASE, operation: "patch", body: {} })).toThrow();
  });
});

describe("envelopeWithBody", () => {
  it("returns an upsert-envelope with a typed body", () => {
    const EntityEnvelope = envelopeWithBody(EntityBodySchema);
    const value = {
      ...BASE,
      operation: "upsert" as const,
      body: {
        name: "Customer",
        label: { en: "Customer", ar: "عميل" },
        storage: { strategy: "hybrid" as const },
        fields: [{ name: "code", type: "string" as const }],
      },
    };
    const parsed = EntityEnvelope.parse(value);
    // Body is typed as EntityBody; .name is a known string.
    expect(parsed.body.name).toBe("Customer");
  });

  it("rejects bodies that do not match the passed schema", () => {
    const IntBody = envelopeWithBody(z.object({ n: z.number().int() }).strict());
    expect(() => IntBody.parse({ ...BASE, operation: "upsert", body: { n: 1.5 } })).toThrow();
  });

  it("round-trips through JSON with the typed body preserved", () => {
    const EntityEnvelope = envelopeWithBody(EntityBodySchema);
    const value = {
      ...BASE,
      operation: "upsert" as const,
      body: {
        name: "Customer",
        label: { en: "Customer" },
        storage: { strategy: "jsonb" as const },
        fields: [{ name: "code", type: "string" as const, required: true }],
      },
    };
    const parsed = EntityEnvelope.parse(JSON.parse(JSON.stringify(EntityEnvelope.parse(value))));
    expect(parsed).toEqual(value);
  });
});

describe("UpsertEnvelope<Body> type exports", () => {
  it("narrows the body type when the generic is supplied", () => {
    // Compile-time check via a type assignment; the runtime side is the
    // envelopeWithBody test above.
    const typed: UpsertEnvelope<{ name: string }> = {
      ...BASE,
      operation: "upsert",
      body: { name: "ok" },
    };
    expect(typed.body.name).toBe("ok");
  });
});
