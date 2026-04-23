// buildKernel() — the single place every kernel dependency is wired
// up. CLAUDE.md §7 non-negotiable #11: Fastify, Kysely, Redis, pino,
// OTel — all instantiated only here. Every other file in apps/kernel
// receives these via constructor parameters or request.appContext.
//
// Wiring order matters:
//   1. Logger (silent in tests via input.logger override).
//   2. Kysely — owner of the connection pool.
//   3. KernelCache — L1 Map + optional L2 Redis.
//   4. MetadataObjectRepository — the MetadataStore the resolver uses.
//   5. ResolveService — glues cache + repository + logger + tracer.
//   6. CacheInvalidator — polls the outbox and evicts on deploy events.
//   7. Fastify app + plugins + routes.
//   8. Return a ServerHandle whose close() reverses the above.
//
// Tests call buildKernel({ db, logger, cache?, invalidatorTickIntervalMs? })
// to share a Testcontainers DB and to drive the invalidator manually.

import { type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { MetadataObjectRepository, createDatabase, type Database } from "@erp/db";
import { createLogger, type Logger } from "@erp/telemetry";
import { fastify, type FastifyInstance } from "fastify";
import { type Kysely } from "kysely";

import "./context.js"; // Augments fastify's FastifyRequest type.

import { CacheInvalidator } from "./cache-invalidator.js";
import { KernelCache } from "./cache.js";
import { createOpenApiRegistry } from "./openapi-registry.js";
import errorsPlugin from "./plugins/errors.js";
import openapiPlugin from "./plugins/openapi.js";
import telemetryPlugin from "./plugins/telemetry.js";
import { ResolveService } from "./resolve-service.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerResolveRoutes } from "./routes/resolve.js";

export interface BuildKernelInput {
  /** Postgres connection string. */
  readonly databaseUrl?: string;
  /** Pre-built Kysely instance — tests inject this to share a Testcontainers DB. */
  readonly db?: Kysely<Database>;
  /** Pre-built logger — tests pass a silent one. */
  readonly logger?: Logger;
  /** Pre-built cache — tests pass one wired with no Redis (L1 only). */
  readonly cache?: KernelCache;
  /** OpenAPI registry — tests can inject one with extra routes. */
  readonly registry?: OpenAPIRegistry;
  /** Redis URL for L2. When undefined and no cache is injected, L2 is disabled. */
  readonly redisUrl?: string;
  /** Override the invalidator tick interval (ms). Defaults to 250. */
  readonly invalidatorTickIntervalMs?: number;
  /** When true, start the CacheInvalidator polling loop. Defaults to true. */
  readonly startInvalidator?: boolean;
}

export interface KernelHandle {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly registry: OpenAPIRegistry;
  readonly cache: KernelCache;
  readonly invalidator: CacheInvalidator;
  readonly resolveService: ResolveService;
  /** Owner of the resources buildKernel created — close them on shutdown. */
  close(): Promise<void>;
}

const SERVICE_NAME = "erp-kernel";
const STARTED_AT = new Date();

export async function buildKernel(input: BuildKernelInput = {}): Promise<KernelHandle> {
  const logger = input.logger ?? createLogger({ service: SERVICE_NAME });
  const ownsDb = input.db === undefined;
  const databaseUrl = input.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const db =
    input.db ??
    createDatabase({
      connectionString: databaseUrl,
      applicationName: SERVICE_NAME,
    });

  // Cache — the tests pass a pre-built one (no Redis). Production reads
  // REDIS_URL from the environment.
  const ownsCache = input.cache === undefined;
  const cache =
    input.cache ??
    new KernelCache({
      logger,
      ...(input.redisUrl !== undefined ? { redisUrl: input.redisUrl } : {}),
    });

  const registry = input.registry ?? createOpenApiRegistry();

  // Repositories + services. Constructed once per kernel, not per-request
  // — the Kysely instance is the pool, the repo carries no state.
  const metadataRepo = new MetadataObjectRepository(db);
  const resolveService = new ResolveService(cache, metadataRepo, logger);

  const tickMs = input.invalidatorTickIntervalMs ?? 250;
  const invalidator = new CacheInvalidator({
    db,
    cache,
    logger,
    tickIntervalMs: tickMs,
  });

  // Seed the cursor to the current max(outbox_pk) so the invalidator
  // only reacts to deploys published *after* this kernel started.
  await invalidator.initCursor();

  if (input.startInvalidator !== false) {
    invalidator.start();
  }

  // Fastify app
  const app = fastify({
    // Our telemetry plugin owns the request-scoped logger.
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    requestIdHeader: "x-request-id",
    genReqId: () => "",
  });

  await app.register(telemetryPlugin, { logger });
  await app.register(errorsPlugin);
  await app.register(openapiPlugin, {
    registry,
    title: "ERP Kernel",
    version: "0.0.0",
    description: "Application Kernel — resolves metadata, owns the L2 Redis cache.",
  });

  await registerHealthRoutes(app, {
    serviceName: SERVICE_NAME,
    db,
    registry,
    startedAt: STARTED_AT,
  });
  await registerResolveRoutes(app, { registry, service: resolveService });

  return {
    app,
    db,
    logger,
    registry,
    cache,
    invalidator,
    resolveService,
    close: async () => {
      await invalidator.stop();
      await app.close();
      if (ownsCache) await cache.close();
      if (ownsDb) await db.destroy();
    },
  };
}
