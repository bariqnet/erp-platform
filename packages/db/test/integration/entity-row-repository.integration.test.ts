// TASK-12 · EntityRowRepository integration tests.
//
// Exercises the Runtime-API-backing repository end-to-end against a
// real Postgres (Testcontainers). Covers create / get / list / patch
// / soft-delete, the RLS policy, and the default row_id generation.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EntityRowRepository } from "../../src/entity-row-repository.js";
import { createMigrator } from "../../src/migrator.js";
import { withTenantContext } from "../../src/tenant-context.js";

import type { Database } from "../../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT_A = "t_alpha";
const TENANT_B = "t_beta";
const ENTITY = "ent.customer";

let container: StartedTestContainer;
let db: Kysely<Database>;
let repo: EntityRowRepository;

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
        max: 4,
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
  repo = new EntityRowRepository(db);
});

describe("create + get", () => {
  it("inserts with a server-generated UUID row_id and reads it back", async () => {
    const created = await repo.create(TENANT_A, {
      entity_id: ENTITY,
      body: { name: "Acme", credit_limit_fils: 1_000_000, currency: "IQD" },
      status: "active",
      created_by: "u_1",
    });
    expect(created.row_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.body).toMatchObject({ name: "Acme", currency: "IQD" });
    expect(created.status).toBe("active");

    const fetched = await repo.get(TENANT_A, ENTITY, created.row_id);
    expect(fetched).not.toBeNull();
    expect(fetched?.body).toMatchObject({ name: "Acme" });
  });

  it("honors a caller-supplied row_id", async () => {
    const row_id = "11111111-1111-1111-1111-111111111111";
    const created = await repo.create(TENANT_A, {
      entity_id: ENTITY,
      body: { name: "Beta" },
      row_id,
    });
    expect(created.row_id).toBe(row_id);
  });

  it("returns null for get when the row is absent", async () => {
    const fetched = await repo.get(TENANT_A, ENTITY, "00000000-0000-0000-0000-000000000000");
    expect(fetched).toBeNull();
  });
});

describe("list", () => {
  it("returns most-recent first and honors limit/offset", async () => {
    for (let i = 0; i < 5; i += 1) {
      await repo.create(TENANT_A, { entity_id: ENTITY, body: { n: i } });
    }
    const page1 = await repo.list(TENANT_A, ENTITY, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);
    expect((page1[0]?.body as { n: number }).n).toBe(4);
    expect((page1[1]?.body as { n: number }).n).toBe(3);

    const page2 = await repo.list(TENANT_A, ENTITY, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);
    expect((page2[0]?.body as { n: number }).n).toBe(2);
  });

  it("excludes soft-deleted rows", async () => {
    const keep = await repo.create(TENANT_A, { entity_id: ENTITY, body: { keep: true } });
    const drop = await repo.create(TENANT_A, { entity_id: ENTITY, body: { drop: true } });
    await repo.softDelete(TENANT_A, ENTITY, drop.row_id, "u_1");

    const rows = await repo.list(TENANT_A, ENTITY);
    expect(rows.map((r) => r.row_id)).toEqual([keep.row_id]);
  });

  it("caps limit at 200", async () => {
    const rows = await repo.list(TENANT_A, ENTITY, { limit: 10_000 });
    expect(rows.length).toBeLessThanOrEqual(200);
  });
});

describe("patch", () => {
  it("merges caller-provided fields and bumps updated_at", async () => {
    const created = await repo.create(TENANT_A, {
      entity_id: ENTITY,
      body: { name: "Original", phone: "+9647700000000" },
      status: "draft",
    });
    // Wait 20ms so updated_at > created_at by at least a millisecond.
    await new Promise((r) => setTimeout(r, 20));
    const patched = await repo.patch(TENANT_A, ENTITY, created.row_id, {
      body: { name: "Updated", phone: "+9647700000000", loyalty_tier: "gold" },
      status: "active",
      updated_by: "u_2",
    });
    expect(patched).not.toBeNull();
    expect(patched?.body).toMatchObject({ name: "Updated", loyalty_tier: "gold" });
    expect(patched?.status).toBe("active");
    expect(patched?.updated_by).toBe("u_2");
    expect(new Date(patched!.updated_at).getTime()).toBeGreaterThan(
      new Date(created.updated_at).getTime(),
    );
  });

  it("returns null when patching a non-existent row", async () => {
    const patched = await repo.patch(TENANT_A, ENTITY, "00000000-0000-0000-0000-000000000000", {
      body: { x: 1 },
    });
    expect(patched).toBeNull();
  });
});

describe("softDelete", () => {
  it("marks the row deleted and subsequent get returns null", async () => {
    const row = await repo.create(TENANT_A, { entity_id: ENTITY, body: {} });
    const ok = await repo.softDelete(TENANT_A, ENTITY, row.row_id, "u_deleter");
    expect(ok).toBe(true);
    expect(await repo.get(TENANT_A, ENTITY, row.row_id)).toBeNull();
  });

  it("returns false when no row matched", async () => {
    const ok = await repo.softDelete(
      TENANT_A,
      ENTITY,
      "00000000-0000-0000-0000-000000000000",
      null,
    );
    expect(ok).toBe(false);
  });

  it("a second softDelete on an already-deleted row is a no-op", async () => {
    const row = await repo.create(TENANT_A, { entity_id: ENTITY, body: {} });
    expect(await repo.softDelete(TENANT_A, ENTITY, row.row_id, null)).toBe(true);
    expect(await repo.softDelete(TENANT_A, ENTITY, row.row_id, null)).toBe(false);
  });
});

describe("tenant isolation (RLS)", () => {
  it("a row created under tenant A is not visible to tenant B", async () => {
    const rowA = await repo.create(TENANT_A, {
      entity_id: ENTITY,
      body: { name: "A's customer" },
    });
    expect(await repo.get(TENANT_B, ENTITY, rowA.row_id)).toBeNull();
    expect((await repo.list(TENANT_B, ENTITY)).map((r) => r.row_id)).toEqual([]);
  });

  it("a row inserted without tenant context is refused by RLS", async () => {
    // Attempt an INSERT outside a tenant context — the WITH CHECK clause
    // on the RLS policy rejects it because current_setting returns NULL.
    await expect(
      withTenantContext(db, "", async (trx) =>
        trx
          .insertInto("ops.entity_row")
          .values({
            tenant_id: TENANT_A,
            entity_id: ENTITY,
            body: JSON.stringify({}),
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });
});
