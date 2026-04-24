// buildServer() — the single place every dependency is wired up.
// CLAUDE.md §7 #11: Fastify, Kysely, Redis, pino, OTel, Better Auth
// are instantiated only here. Every other file in apps/api receives
// these via constructor parameters or via request.appContext.
//
// Test code calls buildServer() with overridden dependencies (e.g.
// an in-memory pool, a NoopBus). Production calls it with real ones.

import { type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  AuditRepository,
  ChangeSetRepository,
  EntityRowRepository,
  MetadataObjectRepository,
  createDatabase,
  type Database,
} from "@erp/db";
import { OutboxBus } from "@erp/events";
import { MaterializedEntityCache } from "@erp/kernel-runtime";
import { createLogger, type Logger } from "@erp/telemetry";
import { fastify, type FastifyInstance } from "fastify";
import { type Kysely } from "kysely";

import "./context.js"; // Augments fastify's FastifyRequest type.

import { createOpenApiRegistry } from "./openapi-registry.js";
import authPlugin from "./plugins/auth.js";
import errorsPlugin from "./plugins/errors.js";
import openapiPlugin from "./plugins/openapi.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import telemetryPlugin from "./plugins/telemetry.js";
import tenantContextPlugin from "./plugins/tenant-context.js";
import { registerChangeSetRoutes } from "./routes/admin/changes.js";
import { registerMetadataObjectRoutes } from "./routes/admin/metadata-objects.js";
import { registerTemplatesRoutes } from "./routes/admin/templates.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRuntimeEntityRoutes } from "./routes/runtime/entities.js";
import { ChangeSetService } from "./services/change-set-service.js";
import { MetadataObjectService } from "./services/metadata-object-service.js";
import { PermissionGate } from "./services/permission-gate.js";
import { RuntimeEntityService } from "./services/runtime-entity-service.js";

export interface BuildServerInput {
  /** Postgres connection string. */
  readonly databaseUrl?: string;
  /** Pre-built Kysely instance — tests inject this to share a Testcontainers DB. */
  readonly db?: Kysely<Database>;
  /** Pre-built logger — tests pass a silent one. */
  readonly logger?: Logger;
  /** OpenAPI registry — tests can inject one with extra routes. */
  readonly registry?: OpenAPIRegistry;
  /** Override for the auth plugin's `required` flag. */
  readonly authRequired?: boolean;
}

export interface ServerHandle {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly registry: OpenAPIRegistry;
  /** Owner of the resources buildServer created — close them on shutdown. */
  close(): Promise<void>;
}

const SERVICE_NAME = "erp-api";
const STARTED_AT = new Date();

export async function buildServer(input: BuildServerInput = {}): Promise<ServerHandle> {
  const logger = input.logger ?? createLogger({ service: SERVICE_NAME });
  const ownsDb = input.db === undefined;
  const databaseUrl = input.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const db =
    input.db ??
    createDatabase({
      connectionString: databaseUrl,
      applicationName: SERVICE_NAME,
    });
  const registry = input.registry ?? createOpenApiRegistry();

  const app = fastify({
    // We provide our own logger via the telemetry plugin so the
    // request-scoped child logger lives on request.appContext.logger.
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    requestIdHeader: "x-request-id",
    genReqId: () => "",
  });

  await app.register(telemetryPlugin, { logger });
  await app.register(errorsPlugin);
  const authOpts: {
    db: Kysely<Database>;
    required?: boolean;
  } = input.authRequired !== undefined ? { db, required: input.authRequired } : { db };
  await app.register(authPlugin, authOpts);
  await app.register(tenantContextPlugin);
  await app.register(rateLimitPlugin, {});
  await app.register(openapiPlugin, {
    registry,
    title: "ERP Platform API",
    version: "0.0.0",
    description: "Admin API + Runtime API for the ERP platform.",
  });

  // Repositories + services. Constructed once per server, not per-request
  // — the Kysely instance is the connection pool, repositories carry no
  // state of their own.
  const metadataObjectRepo = new MetadataObjectRepository(db);
  const changeSetRepo = new ChangeSetRepository(db);
  const entityRowRepo = new EntityRowRepository(db);
  const auditRepo = new AuditRepository(db);
  const metadataObjectService = new MetadataObjectService(metadataObjectRepo);
  const changeSetService = new ChangeSetService(changeSetRepo);

  // Runtime API: the materialized-entity cache is version-keyed
  // (RFC §5.3 #6) — new deploys produce new keys, old keys age out
  // via LRU. No explicit invalidation needed on the hot path.
  const materializedCache = new MaterializedEntityCache();
  const permissionGate = new PermissionGate(metadataObjectRepo, (tenantId) =>
    metadataObjectRepo.listActiveObjectIds(tenantId, "Permission"),
  );
  // Runtime events (TASK-15) — lifecycle-action transitions emit
  // `runtime.<entity_id>.<action>` into the outbox. apps/worker's
  // OutboxPump drains these; consumers subscribe via the bus.
  const outboxBus = new OutboxBus(db);
  const runtimeEntityService = new RuntimeEntityService(
    metadataObjectRepo,
    entityRowRepo,
    auditRepo,
    metadataObjectRepo,
    permissionGate,
    materializedCache,
    db,
    outboxBus,
  );

  await registerHealthRoutes(app, {
    serviceName: SERVICE_NAME,
    db,
    registry,
    startedAt: STARTED_AT,
  });
  await registerMetadataObjectRoutes(app, { registry, service: metadataObjectService });
  await registerChangeSetRoutes(app, { registry, service: changeSetService });
  await registerTemplatesRoutes(app, { registry, repo: metadataObjectRepo });
  await registerRuntimeEntityRoutes(app, { registry, service: runtimeEntityService });

  return {
    app,
    db,
    logger,
    registry,
    close: async () => {
      await app.close();
      if (ownsDb) await db.destroy();
    },
  };
}
