// TASK-03 · Row-level security integration test.
//
// Proves the policies defined in 0001_metadata_schema.sql actually block
// cross-tenant reads and writes when the session's `app.current_tenant`
// differs from the row's `tenant_id`. Each describe owns a fresh Postgres
// container; no state leaks between them.
//
// We exercise the production API — `withTenantContext` — which does two
// things: SET LOCAL ROLE erp_app (non-superuser, so RLS fires) and
// set_config('app.current_tenant', ...). That matches exactly how a
// production app would connect.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigrator } from "../../src/migrator.js";
import { withTenantContext } from "../../src/tenant-context.js";

import type { Database } from "../../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT_A = "t_alpha";
const TENANT_B = "t_bravo";

async function startPostgres(): Promise<StartedTestContainer> {
  return new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "erp",
      POSTGRES_PASSWORD: "erp",
      POSTGRES_DB: "erp_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
}

function makeDb(container: StartedTestContainer): Kysely<Database> {
  return new Kysely<Database>({
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
}

describe("RLS — meta_change_set is strictly tenant-scoped", () => {
  let container: StartedTestContainer;
  let db: Kysely<Database>;

  beforeAll(async () => {
    container = await startPostgres();
    db = makeDb(container);
    const migrator = createMigrator(db, MIGRATIONS_DIR);
    const result = await migrator.migrateToLatest();
    expect(result.error).toBeUndefined();
  });

  afterAll(async () => {
    await db?.destroy();
    await container?.stop();
  });

  it("lets a tenant read its own Change Set", async () => {
    await withTenantContext(db, TENANT_A, async (trx) => {
      await trx
        .insertInto("metadata.meta_change_set")
        .values({
          change_set_id: "cs_a1",
          tenant_id: TENANT_A,
          status: "draft",
          description: "alpha draft",
        })
        .execute();
      const rows = await trx
        .selectFrom("metadata.meta_change_set")
        .selectAll()
        .where("change_set_id", "=", "cs_a1")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenant_id).toBe(TENANT_A);
    });
  });

  it("blocks a different tenant from seeing the first tenant's Change Set", async () => {
    const rows = await withTenantContext(db, TENANT_B, async (trx) =>
      trx
        .selectFrom("metadata.meta_change_set")
        .selectAll()
        .where("change_set_id", "=", "cs_a1")
        .execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it("blocks a different tenant from INSERTing under tenant A's id", async () => {
    // WITH CHECK ensures you cannot write a row whose tenant_id doesn't match
    // your GUC — defense against "write to another tenant" bugs.
    await expect(
      withTenantContext(db, TENANT_B, async (trx) => {
        await trx
          .insertInto("metadata.meta_change_set")
          .values({
            change_set_id: "cs_cross_tenant",
            tenant_id: TENANT_A, // forged
            status: "draft",
            description: "should fail",
          })
          .execute();
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("blocks reads when the connecting role is erp_app with no tenant set", async () => {
    // We emulate an unset GUC explicitly — set_config to empty, which
    // current_setting('app.current_tenant', true) returns as ''. The policy
    // compares tenant_id = '' (which never matches a real tenant), so zero
    // rows are visible.
    const rows = await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE erp_app`.execute(trx);
      await sql`SELECT set_config('app.current_tenant', '', true)`.execute(trx);
      return trx.selectFrom("metadata.meta_change_set").selectAll().execute();
    });
    expect(rows).toHaveLength(0);
  });
});

describe("RLS — meta_object lets L0/L1 through regardless of tenant", () => {
  let container: StartedTestContainer;
  let db: Kysely<Database>;

  beforeAll(async () => {
    container = await startPostgres();
    db = makeDb(container);
    const migrator = createMigrator(db, MIGRATIONS_DIR);
    const result = await migrator.migrateToLatest();
    expect(result.error).toBeUndefined();

    // Seed an L0 row — vendor-level write runs as the erp superuser (no
    // tenant context, no role demotion). That simulates a platform release
    // loading baseline metadata.
    await db
      .insertInto("metadata.meta_object")
      .values({
        object_id: "ent.customer",
        object_type: "Entity",
        layer: "L0",
        tenant_id: null,
        template_id: null,
        version: 1,
        body: { name: "Customer" },
        created_by: "system",
        created_via: "migration",
        change_set_id: "cs_seed",
      })
      .execute();

    // Seed an L2 row under tenant A using the production API.
    await withTenantContext(db, TENANT_A, async (trx) => {
      await trx
        .insertInto("metadata.meta_object")
        .values({
          object_id: "ent.customer",
          object_type: "Entity",
          layer: "L2",
          tenant_id: TENANT_A,
          version: 1,
          body: { label_override: { en: "Alpha Customer" } },
          created_by: "u_a",
          created_via: "configuration_studio",
          change_set_id: "cs_a_layout",
        })
        .execute();
    });
  });

  afterAll(async () => {
    await db?.destroy();
    await container?.stop();
  });

  it("tenant A sees both the L0 (NULL tenant_id) and its own L2 rows", async () => {
    const rows = await withTenantContext(db, TENANT_A, async (trx) =>
      trx
        .selectFrom("metadata.meta_object")
        .selectAll()
        .where("object_id", "=", "ent.customer")
        .orderBy("layer")
        .execute(),
    );
    expect(rows.map((r) => r.layer)).toEqual(["L0", "L2"]);
  });

  it("tenant B sees only the L0 row", async () => {
    const rows = await withTenantContext(db, TENANT_B, async (trx) =>
      trx
        .selectFrom("metadata.meta_object")
        .selectAll()
        .where("object_id", "=", "ent.customer")
        .execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe("L0");
    expect(rows[0]?.tenant_id).toBeNull();
  });
});
