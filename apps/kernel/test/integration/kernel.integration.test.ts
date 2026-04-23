// TASK-11 · kernel integration tests.
//
// Contract + the fleet-wide cache-invalidation SLO from RFC §5.4.
//
// Coverage:
//   1. /healthz and /readyz contract against the real Fastify factory.
//   2. POST /internal/resolve — miss → warm → L1 hit → 404 on unknown id.
//   3. Two kernel instances share the same Postgres DB. Each pre-warms
//      its own L1 cache. A `metadata.change_set_deployed` event lands
//      in the outbox. Both kernels' invalidators drain once. Both
//      kernels' caches evict the tenant's entries — the next resolve
//      is a fresh miss. This is the core RFC §5.4 SLO (propagation
//      across the fleet) expressed as a test.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMigrator, type Database } from "@erp/db";
import { createLogger } from "@erp/telemetry";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { KernelCache } from "../../src/cache.js";
import { buildKernel, type KernelHandle } from "../../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT = "t_alpha";
const OTHER_TENANT = "t_beta";
const OBJECT_ID = "ent.customer";

let container: StartedTestContainer;
let db: Kysely<Database>;

// ── Helpers ─────────────────────────────────────────────────────────

async function freshDb(): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS metadata CASCADE`.execute(db);
  await sql`DROP SCHEMA IF EXISTS ops CASCADE`.execute(db);
  await sql`DROP ROLE IF EXISTS erp_app`.execute(db);
  await sql`DELETE FROM kysely_migration`.execute(db).catch(() => undefined);
  await sql`DELETE FROM kysely_migration_lock`.execute(db).catch(() => undefined);
  const m = createMigrator(db, MIGRATIONS_DIR);
  const r = await m.migrateToLatest();
  if (r.error) throw r.error;
}

/**
 * Seed an active L0 row for `OBJECT_ID`. The resolver walks L0 → L2
 * for every tenant by default; an L0 row with tenant_id = NULL is
 * visible to everyone.
 */
async function seedL0Customer(): Promise<void> {
  await db
    .insertInto("metadata.meta_object")
    .values({
      object_id: OBJECT_ID,
      object_type: "Entity",
      layer: "L0",
      tenant_id: null,
      template_id: null,
      version: 1,
      operation: "upsert",
      body: JSON.stringify({ name: "Customer", label: { en: "Customer" } }),
      created_by: "seed",
      created_via: "test",
      change_set_id: "cs_seed",
    })
    .execute();
}

/**
 * Insert a `metadata.change_set_deployed` event into the outbox for
 * the given tenant. The invalidator reads from the outbox directly;
 * we don't need to route through OutboxBus + OutboxPump here.
 */
async function publishDeployEvent(tenantId: string): Promise<void> {
  await db
    .insertInto("metadata.meta_outbox")
    .values({
      event_id: randomUUID(),
      event_type: "metadata.change_set_deployed",
      event_version: 1,
      occurred_at: new Date(),
      tenant_id: tenantId,
      actor_id: "u_deployer",
      change_set_id: `cs_${randomUUID()}`,
      dedup_key: `metadata.change_set_deployed:${randomUUID()}`,
      trace: null,
      payload: JSON.stringify({
        change_set_id: "cs_test",
        tenant_id: tenantId,
        from_state: "approved",
        to_state: "deployed",
        actor_id: "u_deployer",
        operation_count: 1,
      }),
    })
    .execute();
}

/**
 * Build a kernel wired for tests: silent logger, its own L1-only
 * cache, invalidator not auto-started (we drive it with drainOnce()
 * so the assertions are deterministic).
 */
async function makeKernel(): Promise<KernelHandle> {
  const logger = createLogger({ service: "erp-kernel-test", level: "fatal", pretty: false });
  return buildKernel({
    db,
    logger,
    cache: new KernelCache({ logger }), // L1-only — no redisUrl
    startInvalidator: false,
  });
}

// ── Container lifecycle ─────────────────────────────────────────────

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "erp", POSTGRES_PASSWORD: "erp", POSTGRES_DB: "erp_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        host: container.getHost(),
        port: container.getMappedPort(5432),
        user: "erp",
        password: "erp",
        database: "erp_test",
        max: 8,
      }),
    }),
  });
});

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

beforeEach(async () => {
  await freshDb();
});

// ── /healthz + /readyz ──────────────────────────────────────────────

describe("health endpoints", () => {
  it("/healthz returns 200 with the kernel body", async () => {
    const handle = await makeKernel();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; service: string; uptime_seconds: number };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("erp-kernel");
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    } finally {
      await handle.close();
    }
  });

  it("/readyz returns 200 ready when the DB is reachable", async () => {
    const handle = await makeKernel();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; checks: Record<string, { status: string }> };
      expect(body.status).toBe("ready");
      expect(body.checks.database?.status).toBe("pass");
    } finally {
      await handle.close();
    }
  });

  it("/docs/openapi.json exposes /internal/resolve with its Zod schemas", async () => {
    const handle = await makeKernel();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/docs/openapi.json" });
      expect(res.statusCode).toBe(200);
      const spec = res.json() as {
        openapi: string;
        info: { title: string };
        paths?: Record<string, Record<string, unknown>>;
      };
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.info.title).toBe("ERP Kernel");
      expect(spec.paths?.["/internal/resolve"]?.post).toBeDefined();
      expect(spec.paths?.["/healthz"]?.get).toBeDefined();
    } finally {
      await handle.close();
    }
  });
});

// ── /internal/resolve contract ──────────────────────────────────────

describe("POST /internal/resolve", () => {
  it("returns 200 with cache_status=miss on the first call, l1_hit on the second", async () => {
    await seedL0Customer();
    const handle = await makeKernel();
    try {
      const first = await handle.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as {
        object_id: string;
        body: Record<string, unknown>;
        cache_status: string;
        provenance: { layer: string; version: number }[];
        duration_ms: number;
      };
      expect(firstBody.object_id).toBe(OBJECT_ID);
      expect(firstBody.body).toMatchObject({ name: "Customer" });
      expect(firstBody.cache_status).toBe("miss");
      expect(firstBody.provenance).toEqual([{ layer: "L0", version: 1, object_id: OBJECT_ID }]);
      expect(firstBody.duration_ms).toBeGreaterThanOrEqual(0);

      const second = await handle.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      expect(second.statusCode).toBe(200);
      expect((second.json() as { cache_status: string }).cache_status).toBe("l1_hit");
    } finally {
      await handle.close();
    }
  });

  it("returns 404 problem+json when no layer contributes a body", async () => {
    const handle = await makeKernel();
    try {
      const res = await handle.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: "ent.absent" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.json()).toMatchObject({
        kind: "object_not_found",
        status: 404,
      });
    } finally {
      await handle.close();
    }
  });

  it("400 problem+json when the request body fails Zod validation", async () => {
    const handle = await makeKernel();
    try {
      const res = await handle.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: "bad tenant", object_id: OBJECT_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ kind: "validation_error" });
    } finally {
      await handle.close();
    }
  });
});

// ── Multi-kernel cache invalidation (RFC §5.4) ──────────────────────

describe("fleet-wide cache invalidation", () => {
  it("both kernels' L1 caches evict on a metadata.change_set_deployed event", async () => {
    await seedL0Customer();
    const k1 = await makeKernel();
    const k2 = await makeKernel();
    try {
      // Warm each kernel's L1.
      const warm = async (k: KernelHandle): Promise<void> => {
        const r = await k.app.inject({
          method: "POST",
          url: "/internal/resolve",
          payload: { tenant_id: TENANT, object_id: OBJECT_ID },
        });
        expect(r.statusCode).toBe(200);
      };
      await warm(k1);
      await warm(k2);

      // Both caches now hold the tenant's entry.
      expect(k1.cache.l1Size).toBe(1);
      expect(k2.cache.l1Size).toBe(1);

      // Second hit on each is L1.
      const hitK1 = await k1.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      expect((hitK1.json() as { cache_status: string }).cache_status).toBe("l1_hit");
      const hitK2 = await k2.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      expect((hitK2.json() as { cache_status: string }).cache_status).toBe("l1_hit");

      // A deploy lands in the outbox — somebody else's kernel wrote it.
      await publishDeployEvent(TENANT);

      // Each kernel's invalidator sees the event and sweeps its cache.
      const consumed1 = await k1.invalidator.drainOnce();
      const consumed2 = await k2.invalidator.drainOnce();
      expect(consumed1).toBe(1);
      expect(consumed2).toBe(1);
      expect(k1.cache.l1Size).toBe(0);
      expect(k2.cache.l1Size).toBe(0);

      // Next resolve is a miss on both — cache has been re-warmed from the store.
      const afterK1 = await k1.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      expect((afterK1.json() as { cache_status: string }).cache_status).toBe("miss");
      const afterK2 = await k2.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      expect((afterK2.json() as { cache_status: string }).cache_status).toBe("miss");
    } finally {
      await k1.close();
      await k2.close();
    }
  });

  it("invalidates only the tenant named in the deploy event", async () => {
    await seedL0Customer();
    const k = await makeKernel();
    try {
      // Warm both tenants.
      await k.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      await k.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: OTHER_TENANT, object_id: OBJECT_ID },
      });
      expect(k.cache.l1Size).toBe(2);

      // Deploy on t_alpha only.
      await publishDeployEvent(TENANT);
      await k.invalidator.drainOnce();

      // t_alpha's entry is gone; t_beta's is still there.
      expect(k.cache.l1Size).toBe(1);

      const alpha = await k.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      expect((alpha.json() as { cache_status: string }).cache_status).toBe("miss");

      const beta = await k.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: OTHER_TENANT, object_id: OBJECT_ID },
      });
      expect((beta.json() as { cache_status: string }).cache_status).toBe("l1_hit");
    } finally {
      await k.close();
    }
  });

  it("cursor advances monotonically — replaying drainOnce after draining is a no-op", async () => {
    await seedL0Customer();
    const k = await makeKernel();
    try {
      await k.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });

      await publishDeployEvent(TENANT);
      expect(await k.invalidator.drainOnce()).toBe(1);
      expect(await k.invalidator.drainOnce()).toBe(0);
      expect(await k.invalidator.drainOnce()).toBe(0);
    } finally {
      await k.close();
    }
  });

  it("ignores non-deploy events (e.g. metadata.change_set_proposed)", async () => {
    await seedL0Customer();
    const k = await makeKernel();
    try {
      await k.app.inject({
        method: "POST",
        url: "/internal/resolve",
        payload: { tenant_id: TENANT, object_id: OBJECT_ID },
      });
      expect(k.cache.l1Size).toBe(1);

      await db
        .insertInto("metadata.meta_outbox")
        .values({
          event_id: randomUUID(),
          event_type: "metadata.change_set_proposed",
          event_version: 1,
          occurred_at: new Date(),
          tenant_id: TENANT,
          actor_id: "u_proposer",
          change_set_id: "cs_proposed",
          dedup_key: `metadata.change_set_proposed:${randomUUID()}`,
          trace: null,
          payload: JSON.stringify({}),
        })
        .execute();

      // The invalidator only consumes deployed events; nothing evicts.
      expect(await k.invalidator.drainOnce()).toBe(0);
      expect(k.cache.l1Size).toBe(1);
    } finally {
      await k.close();
    }
  });
});
