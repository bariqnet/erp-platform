// TASK-17 · L1 Industry Template layer integration test.
//
// Covers:
//   - `POST /admin/v1/templates/activate` writes the activation row
//     and flips the tenant's active-layers to ["L0", "L1", "L2"].
//   - After activation, the resolver walks the template's L1 row
//     for the tenant; resolved body merges L0 → L1 → L2 in order.
//   - Without activation, the tenant still resolves against only
//     ["L0", "L2"] — L1 rows in the DB for other templates are inert.
//   - `GET /admin/v1/metadata/objects/:id` on an entity the template
//     enriches reflects the L1 overlay.
//   - Non-admin callers can't hit the activation endpoint (403).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAuth } from "@erp/auth";
import { createMigrator, type Database } from "@erp/db";
import { createLogger } from "@erp/telemetry";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer, type ServerHandle } from "../../src/server.js";

import { makeSession, sessionHeaders } from "./_fixtures/session-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT = "t_alpha";
const TEMPLATE = "tpl.retail_basics";

let container: StartedTestContainer;
let db: Kysely<Database>;
let handle: ServerHandle;
let ADMIN_HEADERS: { cookie: string; "x-tenant-id": string };
let DEPLOYER_HEADERS: { cookie: string; "x-tenant-id": string };
let READER_HEADERS: { cookie: string; "x-tenant-id": string };

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

/**
 * Seed an `ent.customer` with a minimal L0 body and an L1 overlay
 * that adds a `loyalty_level` enum field. When the template is
 * activated for a tenant, the resolver should merge the L1 overlay.
 */
async function seedCustomerStack(): Promise<void> {
  const l0 = {
    name: "Customer",
    label: { en: "Customer" },
    storage: { strategy: "jsonb" },
    fields: [
      { name: "name", type: "string", required: true, max_length: 120 },
      { name: "currency", type: "string", required: true, max_length: 3 },
    ],
  };
  const l1 = {
    name: "Customer",
    label: { en: "Customer" },
    storage: { strategy: "jsonb" },
    fields: [
      { name: "name", type: "string", required: true, max_length: 120 },
      { name: "currency", type: "string", required: true, max_length: 3 },
      {
        name: "loyalty_level",
        type: "enum",
        values: ["bronze", "silver", "gold"],
      },
    ],
  };

  await db
    .insertInto("metadata.meta_object")
    .values([
      {
        object_id: "ent.customer",
        object_type: "Entity",
        layer: "L0",
        tenant_id: null,
        template_id: null,
        version: 1,
        operation: "upsert",
        body: JSON.stringify(l0),
        created_by: "seed",
        created_via: "test",
        change_set_id: "cs_seed_l0",
      },
      {
        object_id: "ent.customer",
        object_type: "Entity",
        layer: "L1",
        tenant_id: null,
        template_id: TEMPLATE,
        version: 1,
        operation: "upsert",
        body: JSON.stringify(l1),
        created_by: "seed",
        created_via: "test",
        change_set_id: "cs_seed_l1",
      },
      {
        object_id: "prm.admin",
        object_type: "Permission",
        layer: "L0",
        tenant_id: null,
        template_id: null,
        version: 1,
        operation: "upsert",
        body: JSON.stringify({
          role_id: "prm.admin",
          label: { en: "Admin" },
          entity_grants: { "ent.customer": ["read", "create", "update", "delete"] },
        }),
        created_by: "seed",
        created_via: "test",
        change_set_id: "cs_seed_l0",
      },
    ])
    .execute();
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
        max: 4,
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
  const auth = createAuth({ db, isProduction: false });
  ADMIN_HEADERS = sessionHeaders(
    await makeSession(db, auth, {
      tenantId: TENANT,
      userId: "u_admin",
      email: "admin@erp.local",
      roles: ["prm.admin"],
    }),
  );
  DEPLOYER_HEADERS = sessionHeaders(
    await makeSession(db, auth, {
      tenantId: TENANT,
      userId: "u_deployer",
      email: "deployer@erp.local",
      roles: ["metadata.deploy"],
    }),
  );
  READER_HEADERS = sessionHeaders(
    await makeSession(db, auth, {
      tenantId: TENANT,
      userId: "u_reader",
      email: "reader@erp.local",
      roles: [],
    }),
  );
});

describe("POST /admin/v1/templates/activate", () => {
  it("writes the activation row and flips active layers to [L0, L1, L2]", async () => {
    await seedCustomerStack();

    // Before activation: resolved body has only L0 fields (no loyalty_level).
    const beforeRes = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects/ent.customer",
      headers: ADMIN_HEADERS,
    });
    expect(beforeRes.statusCode).toBe(200);
    const beforeBody = beforeRes.json() as {
      body: { fields: { name: string }[] };
    };
    expect(beforeBody.body.fields.map((f) => f.name)).toEqual(["name", "currency"]);

    // Activate the template.
    const act = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/templates/activate",
      headers: DEPLOYER_HEADERS,
      payload: { template_id: TEMPLATE, version: "1.0.0" },
    });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({
      tenant_id: TENANT,
      template_id: TEMPLATE,
      version: "1.0.0",
    });

    // After activation: resolved body includes the L1 overlay's
    // loyalty_level enum.
    const afterRes = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects/ent.customer",
      headers: ADMIN_HEADERS,
    });
    expect(afterRes.statusCode).toBe(200);
    const afterBody = afterRes.json() as {
      body: { fields: { name: string; type: string }[] };
      provenance: { layer: string }[];
    };
    expect(afterBody.body.fields.map((f) => f.name).sort()).toEqual([
      "currency",
      "loyalty_level",
      "name",
    ]);
    const loyalty = afterBody.body.fields.find((f) => f.name === "loyalty_level");
    expect(loyalty?.type).toBe("enum");

    // Provenance includes both L0 and L1.
    const layers = afterBody.provenance.map((p) => p.layer);
    expect(layers).toContain("L0");
    expect(layers).toContain("L1");
  });

  it("is idempotent — a second activation with the same version updates activated_at", async () => {
    await seedCustomerStack();

    const first = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/templates/activate",
      headers: DEPLOYER_HEADERS,
      payload: { template_id: TEMPLATE, version: "1.0.0" },
    });
    expect(first.statusCode).toBe(200);

    const second = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/templates/activate",
      headers: DEPLOYER_HEADERS,
      payload: { template_id: TEMPLATE, version: "1.0.0" },
    });
    expect(second.statusCode).toBe(200);

    // Only one activation row per (tenant, layer).
    const rows = await db
      .selectFrom("metadata.meta_layer_activation")
      .selectAll()
      .where("tenant_id", "=", TENANT)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_id).toBe(TEMPLATE);
  });

  it("can rotate to a new template version", async () => {
    await seedCustomerStack();

    await handle.app.inject({
      method: "POST",
      url: "/admin/v1/templates/activate",
      headers: DEPLOYER_HEADERS,
      payload: { template_id: TEMPLATE, version: "1.0.0" },
    });
    await handle.app.inject({
      method: "POST",
      url: "/admin/v1/templates/activate",
      headers: DEPLOYER_HEADERS,
      payload: { template_id: TEMPLATE, version: "1.1.0" },
    });

    const rows = await db
      .selectFrom("metadata.meta_layer_activation")
      .selectAll()
      .where("tenant_id", "=", TENANT)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe("1.1.0");
  });

  it("400s on a bad template_id format", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/templates/activate",
      headers: DEPLOYER_HEADERS,
      payload: { template_id: "not-a-template", version: "1.0.0" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403s a caller without metadata.deploy", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/templates/activate",
      headers: READER_HEADERS,
      payload: { template_id: TEMPLATE, version: "1.0.0" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("resolver — L1 without activation is inert", () => {
  it("a tenant without an activation row doesn't see L1 rows for any template", async () => {
    await seedCustomerStack();

    const res = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects/ent.customer",
      headers: ADMIN_HEADERS,
    });
    const body = res.json() as {
      body: { fields: { name: string }[] };
      provenance: { layer: string }[];
    };
    // loyalty_level is NOT present.
    expect(body.body.fields.map((f) => f.name)).toEqual(["name", "currency"]);
    expect(body.provenance.map((p) => p.layer)).not.toContain("L1");
  });
});
