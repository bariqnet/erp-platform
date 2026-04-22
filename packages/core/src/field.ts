// Field — a typed attribute on an Entity. RFC §2.4 lists 30+ concrete
// field types; this module ships the 15 most common ones as a
// Zod discriminated union over `type`. Each variant carries the
// common envelope (name, label, required, unique) plus its own
// type-specific keys (max_length, currency_field, target, …).
//
// Extending: add a new variant by defining its schema and appending
// it to FIELD_VARIANT_SCHEMAS. The FieldSchema discriminator handles
// the rest.

import { z } from "zod";

import { LocalizedStringSchema } from "./localization.js";
import { ObjectIdSchema } from "./object-id.js";

// ── Shared primitives ──────────────────────────────────────────────────

/**
 * A field's sql-name. Lowercase, starts with a letter, `_` separator only.
 * Matches the naming convention that downstream Postgres columns will use.
 */
export const FieldNameSchema = z
  .string()
  .min(1)
  .max(63) // Postgres identifier limit
  .regex(/^[a-z][a-z0-9_]*$/, {
    message: "field name must match [a-z][a-z0-9_]*",
  });

const FieldCommonSchema = z.object({
  name: FieldNameSchema,
  label: LocalizedStringSchema.optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  indexed: z.boolean().optional(),
  deprecated: z.boolean().optional(),
});

// ── String ─────────────────────────────────────────────────────────────

export const StringFieldSchema = FieldCommonSchema.extend({
  type: z.literal("string"),
  max_length: z.number().int().positive().optional(),
  min_length: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
  i18n: z.boolean().optional(),
  default: z.string().optional(),
}).strict();

// ── LocalizedString ────────────────────────────────────────────────────

export const LocalizedStringFieldSchema = FieldCommonSchema.extend({
  type: z.literal("localized_string"),
  max_length: z.number().int().positive().optional(),
  default: LocalizedStringSchema.optional(),
}).strict();

// ── Integer ────────────────────────────────────────────────────────────

export const IntegerFieldSchema = FieldCommonSchema.extend({
  type: z.literal("integer"),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  default: z.number().int().optional(),
}).strict();

// ── Decimal ────────────────────────────────────────────────────────────

export const DecimalFieldSchema = FieldCommonSchema.extend({
  type: z.literal("decimal"),
  precision: z.number().int().positive(),
  scale: z.number().int().nonnegative(),
  min: z.number().optional(),
  max: z.number().optional(),
  default: z.number().optional(),
}).strict();

// ── Money ──────────────────────────────────────────────────────────────
// Integer minor units paired with a currency field (CLAUDE.md §5 and §7 #10).

export const MoneyFieldSchema = FieldCommonSchema.extend({
  type: z.literal("money"),
  /** Name of the sibling field that holds the ISO-4217 currency code. */
  currency_field: FieldNameSchema,
  /** Default value in minor units. IQD=fils, USD=cents. Never a float. */
  default: z.number().int().optional(),
}).strict();

// ── Boolean (tri-state) ────────────────────────────────────────────────

export const BooleanFieldSchema = FieldCommonSchema.extend({
  type: z.literal("boolean"),
  default: z.boolean().optional(),
}).strict();

// ── Date (calendar date, no time) ──────────────────────────────────────

export const DateFieldSchema = FieldCommonSchema.extend({
  type: z.literal("date"),
  calendar: z.enum(["gregorian", "hijri"]).optional(),
  default: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
}).strict();

// ── Datetime (timestamptz at rest, UTC) ────────────────────────────────

export const DatetimeFieldSchema = FieldCommonSchema.extend({
  type: z.literal("datetime"),
  default: z.string().datetime().optional(),
}).strict();

// ── Enum (ordered list of codes) ───────────────────────────────────────

export const EnumFieldSchema = FieldCommonSchema.extend({
  type: z.literal("enum"),
  values: z.array(z.string().min(1)).min(1),
  labels: z.record(z.string(), LocalizedStringSchema).optional(),
  default: z.string().optional(),
}).strict();

// ── Reference (typed FK) ───────────────────────────────────────────────

export const ReferenceFieldSchema = FieldCommonSchema.extend({
  type: z.literal("reference"),
  target: ObjectIdSchema,
  on_delete: z.enum(["cascade", "restrict", "nullify", "set_default"]).optional(),
}).strict();

// ── Attachment (binary in S3, uuid reference in-row) ───────────────────

export const AttachmentFieldSchema = FieldCommonSchema.extend({
  type: z.literal("attachment"),
  max_size_bytes: z.number().int().positive().optional(),
  allowed_mime_types: z.array(z.string()).optional(),
}).strict();

// ── Formula (virtual, computed) ────────────────────────────────────────

export const FormulaFieldSchema = FieldCommonSchema.extend({
  type: z.literal("formula"),
  expression: z.string().min(1),
  result_type: z.enum(["string", "integer", "decimal", "boolean", "date", "datetime"]),
}).strict();

// ── JSON (free-form, optionally schema-validated) ──────────────────────

export const JsonFieldSchema = FieldCommonSchema.extend({
  type: z.literal("json"),
  /** An embedded JSON Schema, applied during validation. `unknown` at this
   *  layer so we don't pull in an entire JSON Schema parser. */
  schema: z.unknown().optional(),
}).strict();

// ── Phone (country-aware, stored E.164 normalized) ─────────────────────

export const PhoneFieldSchema = FieldCommonSchema.extend({
  type: z.literal("phone"),
  default_country: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/)
    .optional(),
}).strict();

// ── National ID (per-country checksum validator) ───────────────────────

export const NationalIdFieldSchema = FieldCommonSchema.extend({
  type: z.literal("national_id"),
  country: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/),
}).strict();

// ── Discriminated union over every variant ─────────────────────────────

export const FieldSchema = z.discriminatedUnion("type", [
  StringFieldSchema,
  LocalizedStringFieldSchema,
  IntegerFieldSchema,
  DecimalFieldSchema,
  MoneyFieldSchema,
  BooleanFieldSchema,
  DateFieldSchema,
  DatetimeFieldSchema,
  EnumFieldSchema,
  ReferenceFieldSchema,
  AttachmentFieldSchema,
  FormulaFieldSchema,
  JsonFieldSchema,
  PhoneFieldSchema,
  NationalIdFieldSchema,
]);

export type Field = z.infer<typeof FieldSchema>;

/** The set of recognized field type tags. Useful for exhaustiveness checks. */
export const FIELD_TYPES = [
  "string",
  "localized_string",
  "integer",
  "decimal",
  "money",
  "boolean",
  "date",
  "datetime",
  "enum",
  "reference",
  "attachment",
  "formula",
  "json",
  "phone",
  "national_id",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];
