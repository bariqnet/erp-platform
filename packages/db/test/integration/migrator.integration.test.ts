// TASK-03 · migrator idempotency integration test.
//
// Proves `pnpm db:migrate` running twice is a no-op — the second run applies
// zero migrations and leaves the schema untouched.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, NO_MIGRATIONS, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigrator } from "../../src/migrator.js";

import type { Database } from "../../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

describe("migrator idempotency", () => {
  let container: StartedTestContainer;
  let db: Kysely<Database>;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "erp",
        POSTGRES_PASSWORD: "erp",
        POSTGRES_DB: "erp_test",
      })
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

  it("first run applies every migration in order", async () => {
    const migrator = createMigrator(db, MIGRATIONS_DIR);
    const result = await migrator.migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results).toBeDefined();
    expect(result.results?.length).toBeGreaterThanOrEqual(1);
    expect(result.results?.every((r) => r.status === "Success")).toBe(true);

    // Sanity: the four RFC §4.1 tables exist.
    const rows = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'metadata' ORDER BY tablename
    `.execute(db);
    expect(rows.rows.map((r) => r.tablename)).toEqual([
      "meta_audit_log",
      "meta_change_set",
      "meta_layer_activation",
      "meta_object",
      "meta_outbox",
      "user_tenant",
    ]);
  });

  it("second run is a no-op", async () => {
    const migrator = createMigrator(db, MIGRATIONS_DIR);
    const result = await migrator.migrateToLatest();
    expect(result.error).toBeUndefined();
    expect(result.results ?? []).toHaveLength(0);
  });

  it("rolls back and re-applies cleanly", async () => {
    const migrator = createMigrator(db, MIGRATIONS_DIR);

    // Roll back to NO_MIGRATIONS so the schema is fully empty regardless
    // of how many migrations have shipped.
    const down = await migrator.migrateTo(NO_MIGRATIONS);
    expect(down.error).toBeUndefined();
    expect(down.results?.length).toBeGreaterThanOrEqual(1);

    // Tables gone after rollback.
    const emptied = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'metadata'
    `.execute(db);
    expect(emptied.rows).toHaveLength(0);

    const reUp = await migrator.migrateToLatest();
    expect(reUp.error).toBeUndefined();
    expect(reUp.results?.length).toBeGreaterThanOrEqual(1);

    // Tables back.
    const rows = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'metadata' ORDER BY tablename
    `.execute(db);
    expect(rows.rows.map((r) => r.tablename)).toEqual([
      "meta_audit_log",
      "meta_change_set",
      "meta_layer_activation",
      "meta_object",
      "meta_outbox",
      "user_tenant",
    ]);
  });
});
