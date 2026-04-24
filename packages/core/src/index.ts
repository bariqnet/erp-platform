// Public surface of @erp/core. Every downstream package and app imports
// metadata-object types from here, never from per-file paths. Re-exports
// stay alphabetical per file for review-time diff clarity.

export { ChangeSetStatusSchema, type ChangeSetStatus } from "./change-set-status.js";

export {
  EnvelopeSchema,
  TombstoneEnvelopeSchema,
  UpsertEnvelopeSchema,
  envelopeWithBody,
  type Envelope,
  type TombstoneEnvelope,
  type UpsertEnvelope,
} from "./envelope.js";

export {
  EntityBodySchema,
  EntityNameSchema,
  IndexSchema,
  LifecycleSchema,
  LifecycleTransitionSchema,
  StorageSchema,
  StorageStrategySchema,
  allowedTransitionsFrom,
  findLifecycleTransition,
  type EntityBody,
  type Index,
  type Lifecycle,
  type LifecycleTransition,
  type Storage,
  type StorageStrategy,
} from "./entity.js";

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

export { LayerSchema, TENANT_SCOPED_LAYERS, VENDOR_GLOBAL_LAYERS, type Layer } from "./layer.js";

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
  EntityGrantsSchema,
  FieldGrantsSchema,
  GrantActionSchema,
  PermissionBodySchema,
  type EntityGrants,
  type FieldGrants,
  type GrantAction,
  type PermissionBody,
} from "./permission.js";

export {
  CascadeSchema,
  RelationshipSchema,
  RelationshipTypeSchema,
  type Cascade,
  type Relationship,
  type RelationshipType,
} from "./relationship.js";

export { OBJECT_TYPE_ID_PREFIX, ObjectTypeSchema, type ObjectType } from "./object-type.js";

export {
  DomainEventSchema,
  TraceContextSchema,
  type DomainEvent,
  type DomainEventBase,
  type EventBus,
  type EventHandler,
  type Subscription,
  type TraceContext,
  type WaitForOptions,
} from "./ports/event-bus.js";

export {
  DEFAULT_MERGE_STRATEGY,
  MergeStrategySchema,
  type FetchCandidateParams,
  type LayerCandidate,
  type MergeStrategy,
  type MetadataStore,
} from "./ports/metadata-store.js";

export { Result, type Err, type Ok } from "./result.js";
