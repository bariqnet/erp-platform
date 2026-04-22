// Public surface of @erp/core. Every downstream package and app imports
// metadata-object types from here, never from per-file paths. Re-exports
// stay alphabetical per file for review-time diff clarity.

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
  OBJECT_TYPE_ID_PREFIX,
  ObjectTypeSchema,
  type ObjectType,
} from "./object-type.js";
