// Public surface of @erp/core. Every downstream package and app imports
// metadata-object types from here, never from per-file paths. Re-exports
// stay alphabetical per file for review-time diff clarity.

export {
  AttachmentFieldSchema,
  BooleanFieldSchema,
  DateFieldSchema,
  DatetimeFieldSchema,
  DecimalFieldSchema,
  EnumFieldSchema,
  FIELD_TYPES,
  FieldNameSchema,
  FieldSchema,
  FormulaFieldSchema,
  IntegerFieldSchema,
  JsonFieldSchema,
  LocalizedStringFieldSchema,
  MoneyFieldSchema,
  NationalIdFieldSchema,
  PhoneFieldSchema,
  ReferenceFieldSchema,
  StringFieldSchema,
  type Field,
  type FieldType,
} from "./field.js";

export {
  LayerSchema,
  TENANT_SCOPED_LAYERS,
  VENDOR_GLOBAL_LAYERS,
  type Layer,
} from "./layer.js";

export {
  LocaleSchema,
  LocalizationBodySchema,
  LocalizedStringSchema,
  type Locale,
  type LocalizationBody,
  type LocalizedString,
} from "./localization.js";

export { ObjectIdSchema, type ObjectId } from "./object-id.js";

export {
  CascadeSchema,
  RelationshipSchema,
  RelationshipTypeSchema,
  type Cascade,
  type Relationship,
  type RelationshipType,
} from "./relationship.js";

export {
  OBJECT_TYPE_ID_PREFIX,
  ObjectTypeSchema,
  type ObjectType,
} from "./object-type.js";
