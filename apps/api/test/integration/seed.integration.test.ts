// TASK-13 · reference-tenant seed integration tests.
//
// Runs scripts/seed.ts's runSeed() against a fresh Postgres and proves:
//   1. First pass inserts the expected metadata + 50 rows per entity.
//   2. Second pass is a no-op at every layer (idempotent).
//   3. The Runtime API serves the seeded rows through `/v1/ent.customer`
//      etc, reflecting the layered metadata (the L2 loyalty_tier
//      override on Customer shows up on seeded rows).
//
// The script itself lives under scripts/ (outside any package's
// tsconfig), so we import it via the repo-root relative path. Vitest
// uses vite's transformer and doesn't need the file to be in a
// package's `include`.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMigrator, type Database } from "@erp/db";
import { createLogger } from "@erp/telemetry";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runSeed } from "../../../../scripts/seed.js";
import { buildServer, type ServerHandle } from "../../src/server.js";
// Repo-root relative — scripts/seed.ts lives outside apps/api.
// eslint-disable-next-line import/no-relative-parent-imports

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT = "t_demo_retail";

let container: StartedTestContainer;
let db: Kysely<Database>;
let handle: ServerHandle;

async function freshDb(): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS metadata CASCADE`.execute(db);
  await sql`DROP SCHEMA IF EXISTS ops CASCADE`.execute(db);
  await sql`DROP SCHEMA IF EXISTS auth CASCADE`.execute(db);
  await sql`DROP ROLE IF EXISTS erp_app`.execute(db);
  await sql`DELETE FROM kysely_migration`.execute(db).catch(() => undefined);
  await sql`DELETE FROM kysely_migration_lock`.execute(db).catch(() => undefined);
  const m = createMigrator(db, MIGRATIONS_DIR);
  const r = await m.migrateToLatest();
  if (r.error) throw r.error;
}

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
  await handle?.close();
  await db?.destroy();
  await container?.stop();
});

beforeEach(async () => {
  if (handle) await handle.close();
  await freshDb();
  handle = await buildServer({
    db,
    logger: createLogger({ service: "erp-api-test", level: "fatal", pretty: false }),
    authRequired: true,
  });
});

// A silent logger the seed can use without polluting test output.
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

// ── First-pass population ──────────────────────────────────────────

describe("runSeed — first pass populates the reference tenant", () => {
  it("inserts 5 vendor objects + 1 tenant object + 50 rows × 3 entities", async () => {
    const stats = await runSeed(db, silentLogger);
    expect(stats).toEqual({
      vendorObjectsInserted: 5,
      vendorObjectsSkipped: false,
      tenantObjectsInserted: 1,
      tenantObjectsSkipped: false,
      customersInserted: 50,
      productsInserted: 50,
      invoicesInserted: 50,
    });

    const meta = await db
      .selectFrom("metadata.meta_object")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(meta.count)).toBe(6); // 5 L0 + 1 L2

    const rows = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${TENANT}, true)`.execute(trx);
      const c = await trx
        .selectFrom("ops.entity_row")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("tenant_id", "=", TENANT)
        .where("entity_id", "=", "ent.customer")
        .executeTakeFirstOrThrow();
      const p = await trx
        .selectFrom("ops.entity_row")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("tenant_id", "=", TENANT)
        .where("entity_id", "=", "ent.product")
        .executeTakeFirstOrThrow();
      const inv = await trx
        .selectFrom("ops.entity_row")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("tenant_id", "=", TENANT)
        .where("entity_id", "=", "ent.invoice")
        .executeTakeFirstOrThrow();
      return { c: Number(c.n), p: Number(p.n), i: Number(inv.n) };
    });
    expect(rows).toEqual({ c: 50, p: 50, i: 50 });
  });
});

// ── Idempotency ────────────────────────────────────────────────────

describe("runSeed — second pass is a no-op", () => {
  it("skips every phase and changes nothing", async () => {
    await runSeed(db, silentLogger);
    const second = await runSeed(db, silentLogger);
    expect(second).toEqual({
      vendorObjectsInserted: 0,
      vendorObjectsSkipped: true,
      tenantObjectsInserted: 0,
      tenantObjectsSkipped: true,
      customersInserted: 0,
      productsInserted: 0,
      invoicesInserted: 0,
    });

    // Row counts unchanged.
    const rows = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${TENANT}, true)`.execute(trx);
      const c = await trx
        .selectFrom("ops.entity_row")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("tenant_id", "=", TENANT)
        .where("entity_id", "=", "ent.customer")
        .executeTakeFirstOrThrow();
      return Number(c.n);
    });
    expect(rows).toBe(50);
  });

  it("partial completion still recovers — rerunning fills missing layers", async () => {
    // Simulate a run that got through vendor L0 but crashed before L2
    // or rows. We manually insert the vendor change_set + objects, then
    // call runSeed and assert it completes the remaining phases.
    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', 'vendor_seed', true)`.execute(trx);
      await trx
        .insertInto("metadata.meta_change_set")
        .values({
          change_set_id: "cs_seed_platform_v1",
          tenant_id: "vendor_seed",
          status: "deployed",
          description: "manual",
          created_by: "test",
          deployed_at: new Date(),
        })
        .execute();
      for (const objectId of ["ent.customer", "ent.product", "ent.invoice"]) {
        await trx
          .insertInto("metadata.meta_object")
          .values({
            object_id: objectId,
            object_type: "Entity",
            layer: "L0",
            tenant_id: null,
            template_id: null,
            version: 1,
            operation: "upsert",
            body: JSON.stringify({
              name: "X",
              label: { en: "X" },
              storage: { strategy: "jsonb" },
              fields: [{ name: "name", type: "string", required: true }],
            }),
            created_by: "test",
            created_via: "test",
            change_set_id: "cs_seed_platform_v1",
          })
          .execute();
      }
    });

    const stats = await runSeed(db, silentLogger);
    expect(stats.vendorObjectsSkipped).toBe(true);
    expect(stats.tenantObjectsSkipped).toBe(false);
    expect(stats.tenantObjectsInserted).toBe(1);
    // Row counts may not all be 50 (the partial vendor seed's entities
    // had only `name`), but at least the seed completed without error.
  });
});

// ── End-to-end through the Runtime API ─────────────────────────────

describe("Runtime API serves the seeded metadata + rows", () => {
  const ADMIN_HEADERS = {
    "x-tenant-id": TENANT,
    "x-user-id": "u_admin",
    "x-user-roles": "prm.admin",
  };

  it("GET /v1/ent.customer returns the first 50 seeded rows, loyalty_tier included", async () => {
    await runSeed(db, silentLogger);
    const res = await handle.app.inject({
      method: "GET",
      url: "/v1/ent.customer?limit=200",
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { body: Record<string, unknown>; status: string }[];
    };
    expect(body.items).toHaveLength(50);
    // Every seeded row carries loyalty_tier (proven by the L2 overlay).
    for (const item of body.items) {
      expect(item.body).toHaveProperty("loyalty_tier");
    }
  });

  it("POST /v1/ent.customer accepts the L2-augmented shape", async () => {
    await runSeed(db, silentLogger);
    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/ent.customer",
      headers: ADMIN_HEADERS,
      payload: {
        name: "Post-seed Customer",
        currency: "IQD",
        loyalty_tier: "platinum",
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { body: Record<string, unknown>; status: string };
    expect(created.body).toMatchObject({
      name: "Post-seed Customer",
      loyalty_tier: "platinum",
    });
    expect(created.status).toBe("active"); // lifecycle.initial
  });

  it("GET /v1/ent.product returns 50 rows with Arabic + English labels", async () => {
    await runSeed(db, silentLogger);
    const res = await handle.app.inject({
      method: "GET",
      url: "/v1/ent.product?limit=200",
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { body: { name: { en: string; ar: string } } }[];
    };
    expect(body.items).toHaveLength(50);
    for (const item of body.items) {
      expect(item.body.name).toHaveProperty("en");
      expect(item.body.name).toHaveProperty("ar");
      expect(typeof item.body.name.en).toBe("string");
      expect(typeof item.body.name.ar).toBe("string");
    }
  });

  it("GET /v1/ent.invoice returns 50 rows, every one referencing a seeded customer", async () => {
    await runSeed(db, silentLogger);
    const customers = await handle.app.inject({
      method: "GET",
      url: "/v1/ent.customer?limit=200",
      headers: ADMIN_HEADERS,
    });
    const customerIds = new Set(
      (customers.json() as { items: { row_id: string }[] }).items.map((i) => i.row_id),
    );

    const res = await handle.app.inject({
      method: "GET",
      url: "/v1/ent.invoice?limit=200",
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: { body: { customer_id: string } }[] }).items;
    expect(items).toHaveLength(50);
    for (const item of items) {
      expect(customerIds.has(item.body.customer_id)).toBe(true);
    }
  });

  it("prm.viewer can read but not create", async () => {
    await runSeed(db, silentLogger);
    const viewerHeaders = {
      "x-tenant-id": TENANT,
      "x-user-id": "u_viewer",
      "x-user-roles": "prm.viewer",
    };
    const read = await handle.app.inject({
      method: "GET",
      url: "/v1/ent.customer",
      headers: viewerHeaders,
    });
    expect(read.statusCode).toBe(200);

    const write = await handle.app.inject({
      method: "POST",
      url: "/v1/ent.customer",
      headers: viewerHeaders,
      payload: { name: "Denied", currency: "IQD", loyalty_tier: "gold" },
    });
    expect(write.statusCode).toBe(403);
  });
});
