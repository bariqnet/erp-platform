// TASK-14.1 · audit-chain backfill integration tests.
//
// Exercises `scripts/backfill-audit-chain.ts`'s runBackfill() against
// a real Postgres (Testcontainers) with a seeded ChangeSet lifecycle
// that produces un-chained TASK-07-era audit rows, then:
//
//   1. Asserts those rows exist with before/after_hash = NULL
//      (pre-backfill state, the pre-TASK-14.1 world).
//   2. Runs runBackfill().
//   3. Asserts every row now carries a populated before_hash +
//      after_hash.
//   4. Asserts verifyChain() returns null (continuous chain).
//   5. Re-runs the backfill — assert idempotency (rowsRewritten: 0).
//
// The test uses ChangeSetRepository's pre-backfill audit semantics
// indirectly: since TASK-14.1 rewires writeAudit() to delegate to
// AuditRepository.appendInTx (which chains), fresh audit rows written
// TODAY are already chained. To simulate the legacy un-chained state
// the backfill is designed to fix, the test inserts un-chained rows
// directly via `meta_audit_log`.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuditRepository, createMigrator, type AuditRow, type Database } from "@erp/db";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Repo-root relative — scripts/ lives outside apps/api (same pattern
// the seed integration test uses).
// eslint-disable-next-line import/no-relative-parent-imports
import { runBackfill } from "../../../../scripts/backfill-audit-chain";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT_A = "t_alpha";
const TENANT_B = "t_beta";

let container: StartedTestContainer;
let db: Kysely<Database>;

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
 * Insert a row directly into meta_audit_log with NULL hashes,
 * simulating the pre-TASK-14.1 un-chained shape ChangeSetRepository
 * used to write before it switched to AuditRepository.appendInTx.
 */
async function insertLegacyAuditRow(input: {
  tenant_id: string | null;
  actor_id: string;
  action: string;
  target_id?: string;
  diff?: Record<string, unknown>;
}): Promise<void> {
  await db
    .insertInto("metadata.meta_audit_log")
    .values({
      tenant_id: input.tenant_id,
      actor_id: input.actor_id,
      action: input.action,
      target_type: "change_set",
      target_id: input.target_id ?? null,
      change_set_id: input.target_id ?? null,
      before_hash: null,
      after_hash: null,
      diff: input.diff !== undefined ? JSON.stringify(input.diff) : null,
      context: null,
    })
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

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

async function readAllAuditRows(tenantId: string | null): Promise<readonly AuditRow[]> {
  const rows = await db
    .selectFrom("metadata.meta_audit_log")
    .selectAll()
    .where((eb) =>
      tenantId === null ? eb("tenant_id", "is", null) : eb("tenant_id", "=", tenantId),
    )
    .orderBy("audit_pk")
    .execute();
  return rows.map((row) => ({
    audit_pk: row.audit_pk,
    tenant_id: row.tenant_id,
    actor_id: row.actor_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    change_set_id: row.change_set_id,
    before_hash: row.before_hash,
    after_hash: row.after_hash ?? "",
    diff: row.diff,
    context: row.context,
    created_at: row.created_at.toISOString(),
  }));
}

// ── Pre-backfill state ─────────────────────────────────────────────

describe("audit-chain backfill", () => {
  it("pre-state: legacy rows have NULL hashes", async () => {
    await insertLegacyAuditRow({
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "change_set.created",
      target_id: "cs_001",
      diff: { description: "first change" },
    });
    await insertLegacyAuditRow({
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "change_set.propose",
      target_id: "cs_001",
    });

    const rows = await readAllAuditRows(TENANT_A);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.before_hash).toBeNull();
      // after_hash is "" because our reader coerces null → "" for the
      // shared AuditRow type. The actual DB column is NULL.
      expect(row.after_hash).toBe("");
    }
  });
});

// ── The backfill itself ────────────────────────────────────────────

describe("runBackfill", () => {
  it("populates before/after hashes and unifies the chain", async () => {
    // Seed three legacy rows for tenant A.
    for (const [action, cs] of [
      ["change_set.created", "cs_a_1"],
      ["change_set.propose", "cs_a_1"],
      ["change_set.approve", "cs_a_1"],
    ] as const) {
      await insertLegacyAuditRow({
        tenant_id: TENANT_A,
        actor_id: "u_admin",
        action,
        target_id: cs,
      });
    }
    // And two for tenant B, to prove chains stay per-tenant.
    for (const action of ["change_set.created", "change_set.propose"]) {
      await insertLegacyAuditRow({
        tenant_id: TENANT_B,
        actor_id: "u_admin",
        action,
        target_id: "cs_b_1",
      });
    }

    const stats = await runBackfill(db, silentLogger, [TENANT_A, TENANT_B]);
    expect(stats).toMatchObject({
      tenantsProcessed: 2,
      rowsVisited: 5,
      rowsRewritten: 5,
      chainsAlreadyValid: 0,
    });

    // Tenant A chain: 3 rows, before_hash forms a valid chain.
    const rowsA = await readAllAuditRows(TENANT_A);
    expect(rowsA).toHaveLength(3);
    expect(rowsA[0]?.before_hash).toBeNull();
    expect(rowsA[0]?.after_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rowsA[1]?.before_hash).toBe(rowsA[0]?.after_hash);
    expect(rowsA[2]?.before_hash).toBe(rowsA[1]?.after_hash);

    // Tenant B chain is independent — its first row's before_hash is
    // null, not chained onto tenant A.
    const rowsB = await readAllAuditRows(TENANT_B);
    expect(rowsB).toHaveLength(2);
    expect(rowsB[0]?.before_hash).toBeNull();
    expect(rowsB[1]?.before_hash).toBe(rowsB[0]?.after_hash);
    // Cross-tenant isolation: tenant B's first after_hash differs
    // from tenant A's (different tenant_id in the canonical payload).
    expect(rowsA[0]?.after_hash).not.toBe(rowsB[0]?.after_hash);

    // verifyChain reports both tenants intact.
    const repo = new AuditRepository(db);
    expect(await repo.verifyChain(TENANT_A)).toBeNull();
    expect(await repo.verifyChain(TENANT_B)).toBeNull();
  });

  it("is idempotent — second run rewrites nothing", async () => {
    await insertLegacyAuditRow({
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "change_set.created",
      target_id: "cs_only",
    });
    await insertLegacyAuditRow({
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "change_set.deploy",
      target_id: "cs_only",
    });

    const first = await runBackfill(db, silentLogger, [TENANT_A]);
    expect(first.rowsRewritten).toBe(2);

    const second = await runBackfill(db, silentLogger, [TENANT_A]);
    expect(second.rowsRewritten).toBe(0);
    expect(second.chainsAlreadyValid).toBe(1);
  });

  it("covers vendor-level rows (tenant_id = NULL) as their own chain", async () => {
    await insertLegacyAuditRow({
      tenant_id: null,
      actor_id: "system",
      action: "platform.bootstrap",
    });
    await insertLegacyAuditRow({
      tenant_id: null,
      actor_id: "system",
      action: "platform.rotate_key",
    });
    // Also a tenant row to confirm the vendor chain is independent.
    await insertLegacyAuditRow({
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "change_set.created",
      target_id: "cs_1",
    });

    const stats = await runBackfill(db, silentLogger, [null, TENANT_A]);
    expect(stats.tenantsProcessed).toBe(2);
    expect(stats.rowsRewritten).toBe(3);

    const vendorRows = await readAllAuditRows(null);
    expect(vendorRows).toHaveLength(2);
    expect(vendorRows[0]?.before_hash).toBeNull();
    expect(vendorRows[1]?.before_hash).toBe(vendorRows[0]?.after_hash);

    const repo = new AuditRepository(db);
    expect(await repo.verifyChain(null)).toBeNull();
    expect(await repo.verifyChain(TENANT_A)).toBeNull();

    // The tenant chain should NOT chain onto the vendor chain — different
    // first-row before_hash values.
    const tenantRows = await readAllAuditRows(TENANT_A);
    expect(tenantRows[0]?.before_hash).toBeNull();
  });

  it("partial state: some rows hashed, later rows not — rebuilds cleanly", async () => {
    // Simulate a scenario where the schema landed but only some rows
    // were retroactively chained (partial backfill, aborted midway).
    // Then a new un-chained row was written by the legacy code path.
    const repo = new AuditRepository(db);

    // Two properly chained rows via the repo.
    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${TENANT_A}, true)`.execute(trx);
      await repo.appendInTx(trx, {
        tenant_id: TENANT_A,
        actor_id: "u_1",
        action: "change_set.created",
        target_id: "cs_1",
      });
    });
    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${TENANT_A}, true)`.execute(trx);
      await repo.appendInTx(trx, {
        tenant_id: TENANT_A,
        actor_id: "u_1",
        action: "change_set.propose",
        target_id: "cs_1",
      });
    });

    // A legacy row (NULL hash) written after the chained ones.
    await insertLegacyAuditRow({
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "change_set.approve",
      target_id: "cs_1",
    });

    const pre = await readAllAuditRows(TENANT_A);
    expect(pre).toHaveLength(3);
    expect(pre[2]?.before_hash).toBeNull();
    expect(pre[2]?.after_hash).toBe(""); // stored NULL

    const stats = await runBackfill(db, silentLogger, [TENANT_A]);
    // The two already-correct rows don't get rewritten; only the
    // third does. We keep before/after on the first two intact.
    expect(stats.rowsVisited).toBe(3);
    expect(stats.rowsRewritten).toBe(1);

    const post = await readAllAuditRows(TENANT_A);
    expect(post[2]?.before_hash).toBe(post[1]?.after_hash);
    expect(await repo.verifyChain(TENANT_A)).toBeNull();
  });
});

// ── Dry-run mode ───────────────────────────────────────────────────

describe("runBackfill dry-run (env DRY_RUN)", () => {
  it("the default runBackfill (without --dry) still writes", async () => {
    // The script's --dry flag is a CLI-layer concern; runBackfill()
    // itself writes unless DRY_RUN is toggled by the module-level
    // flag. This test documents that default-on write behavior so a
    // future refactor that moves the flag into the function signature
    // doesn't silently change observable behavior.
    await insertLegacyAuditRow({
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "change_set.created",
      target_id: "cs_1",
    });
    const stats = await runBackfill(db, silentLogger, [TENANT_A]);
    expect(stats.rowsRewritten).toBe(1);
    const rows = await readAllAuditRows(TENANT_A);
    expect(rows[0]?.after_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
