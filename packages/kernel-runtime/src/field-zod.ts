// zodFromField — translate a metadata Field into a runtime Zod schema.
//
// This is the first half of the materialization pipeline (RFC §5.2
// stage 3): given the resolved Entity's field definitions, compile a
// validator chain that the Runtime API uses on every create/patch
// request (RFC §9.2 "schema, validation, and serialization are all
// derived from resolved metadata").
//
// Two knobs each field carries: `required` and the per-type shape.
// We produce a non-nullable schema when required is true; otherwise
// the schema accepts undefined (so partial PATCH bodies skip omitted
// fields without raising "undefined is not of type X").
//
// Phase 1 coverage: all 15 Field variants in @erp/core. A few (formula,
// reference) are narrow Phase-1 shapes; their validators will tighten
// in later tasks (formula needs an expression parser; reference needs
// a cross-entity FK check through the repository layer).

import { type Field } from "@erp/core";
import { z, type ZodTypeAny } from "zod";

/**
 * Build a Zod schema for a single Field. The result is ready to be
 * merged into a `z.object({ [field.name]: zodFromField(field) })`.
 */
export function zodFromField(field: Field): ZodTypeAny {
  const base = baseSchemaFor(field);
  // `required: true` fields reject undefined; otherwise they accept it
  // (a PATCH body can omit any number of fields, a create body has the
  // requirement enforced at the outer object level via `.strict()` +
  // the `required` flag on `z.object({…})`). We use `.optional()` to
  // mean "may be absent"; null is not a synonym — callers that want a
  // clear-this-field semantic send the type's empty value, not null.
  return field.required === true ? base : base.optional();
}

function baseSchemaFor(field: Field): ZodTypeAny {
  switch (field.type) {
    case "string":
      return stringSchema(field);
    case "localized_string":
      return localizedStringSchema(field);
    case "integer":
      return integerSchema(field);
    case "decimal":
      return decimalSchema(field);
    case "money":
      // Money is stored as an integer minor-unit value (CLAUDE.md §5,
      // §7 #10). The validator enforces integer; the paired currency
      // field is validated independently via its own FieldSchema.
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "date":
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "expected YYYY-MM-DD" });
    case "datetime":
      return z.string().datetime();
    case "enum":
      // z.enum requires a non-empty readonly tuple of string literals.
      // The Field schema already asserts values.length >= 1, so we
      // can safely cast to the tuple shape Zod wants.
      return z.enum(field.values as [string, ...string[]]);
    case "reference":
      // Phase 1: a reference is an opaque row_id (UUID). Cross-entity
      // FK enforcement lives at the service layer where the repository
      // is available; the Zod validator only asserts shape.
      return z.string().uuid();
    case "attachment":
      // Phase 1: attachment is an S3 object key — arbitrary non-empty
      // string. MIME/size checks belong at the upload handler when
      // binary uploads land.
      return z.string().min(1);
    case "formula":
      // Phase 1: formulas are not evaluated; the Runtime API accepts
      // them as opaque. Tightens when the formula engine ships.
      return z.unknown();
    case "json":
      // Optionally schema-validated. The embedded JSON Schema is
      // stored as `unknown` in @erp/core (no JSON Schema parser in the
      // domain package); here we either apply it when a parser is
      // wired up, or fall through to z.unknown(). Phase 1 = unknown.
      return z.unknown();
    case "phone":
      // E.164: '+' followed by 8–15 digits. The metadata schema
      // declares a default_country hint for client-side formatting;
      // storage is always the normalized form.
      return z.string().regex(/^\+\d{8,15}$/, { message: "expected E.164 phone (+<digits>)" });
    case "national_id":
      // Country-specific checksum validators are too broad to embed
      // here; the runtime accepts any non-empty string for now and a
      // later task wires a per-country checksum module.
      return z.string().min(1);
  }
}

// ── Per-type builders ────────────────────────────────────────────────

function stringSchema(f: Extract<Field, { type: "string" }>): ZodTypeAny {
  let s: z.ZodString = z.string();
  if (f.min_length !== undefined) s = s.min(f.min_length);
  if (f.max_length !== undefined) s = s.max(f.max_length);
  if (f.regex !== undefined) s = s.regex(new RegExp(f.regex));
  return s;
}

function localizedStringSchema(f: Extract<Field, { type: "localized_string" }>): ZodTypeAny {
  // A localized string at the body layer is a `{ locale: value }` map.
  // Keys are 2-letter ISO codes; values are strings bounded by
  // max_length when the field declared one.
  const valueSchema = f.max_length !== undefined ? z.string().max(f.max_length) : z.string();
  return z.record(z.string().regex(/^[a-z]{2}$/), valueSchema);
}

function integerSchema(f: Extract<Field, { type: "integer" }>): ZodTypeAny {
  let s: z.ZodNumber = z.number().int();
  if (f.min !== undefined) s = s.min(f.min);
  if (f.max !== undefined) s = s.max(f.max);
  return s;
}

function decimalSchema(f: Extract<Field, { type: "decimal" }>): ZodTypeAny {
  // Decimals are stored as JSON numbers for now — the Zod layer cannot
  // express arbitrary precision without a custom refinement. `precision`
  // and `scale` are enforced elsewhere (the serializer rounds before
  // persisting; the DB layer eventually uses NUMERIC(p, s) when native
  // columns land).
  let s: z.ZodNumber = z.number();
  if (f.min !== undefined) s = s.min(f.min);
  if (f.max !== undefined) s = s.max(f.max);
  return s;
}
