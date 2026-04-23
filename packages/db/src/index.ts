export { createDatabase, createPool, type DatabaseConfig } from "./database.js";

export { createMigrator, parseMigration, SqlFileMigrationProvider } from "./migrator.js";

export { withTenantContext, withoutTenantContext } from "./tenant-context.js";

export { TenantRepository } from "./tenant-repository.js";

export {
  ChangeSetRepository,
  type AddOperationsParams,
  type ChangeSetRow,
  type CreateChangeSetParams,
  type RepoError as ChangeSetRepoError,
  type TransitionInput,
  type TransitionOutcome,
} from "./change-set-repository.js";

export {
  MetadataObjectRepository,
  type ListObjectsParams,
  type MetaObjectRow,
} from "./metadata-object-repository.js";

export {
  EntityRowRepository,
  type CreateEntityRowInput,
  type EntityRow,
  type ListEntityRowsParams,
  type PatchEntityRowInput,
} from "./entity-row-repository.js";

export {
  AuditRepository,
  canonicalize,
  computeAfterHash,
  type AppendAuditInput,
  type AuditRow,
} from "./audit-repository.js";

export {
  UserTenantRepository,
  type AddUserTenantInput,
  type UserTenantRow,
} from "./user-tenant-repository.js";

export type {
  AuthAccountTable,
  AuthSessionTable,
  AuthUserTable,
  AuthVerificationTable,
  ChangeSetStatus,
  Database,
  JsonB,
  MetaAuditLogTable,
  MetaChangeSetTable,
  MetadataLayer,
  MetadataOperation,
  MetaLayerActivationTable,
  MetaObjectTable,
  MetaOutboxTable,
  OpsEntityRowTable,
  UserTenantTable,
} from "./schema.js";
