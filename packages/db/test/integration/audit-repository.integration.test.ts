// AuditRepository integration tests — hash-chained append, per-tenant
// chains, verifyChain tamper detection.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuditRepository, canonicalize, computeAfterHash } from "../../src/audit-repository.js";
import { createMigrator } from "../../src/migrator.js";
import { withTenantContext, withoutTenantContext } from "../../src/tenant-context.js";

import type { Database } from "../../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT_A = "t_alpha";
const TENANT_B = "t_beta";

let container: StartedTestContainer;
let db: Kysely<Database>;
let repo: AuditRepository;

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
  repo = new AuditRepository(db);
});

// ── canonicalize ────────────────────────────────────────────────────

describe("canonicalize", () => {
  it("sorts object keys for stable hashing", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("elides undefined values but preserves null", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
  });

  it("handles nested objects and arrays deterministically", () => {
    const l = { x: [{ b: 1, a: 2 }, { c: 3 }], y: { k: null } };
    const r = { y: { k: null }, x: [{ a: 2, b: 1 }, { c: 3 }] };
    expect(canonicalize(l)).toBe(canonicalize(r));
  });
});

// ── computeAfterHash ────────────────────────────────────────────────

describe("computeAfterHash", () => {
  it("produces deterministic output given the same inputs", () => {
    const payload = {
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "ent.customer.create",
      target_type: "entity_row",
      target_id: "row-1",
      diff: null,
      context: null,
      created_at: "2026-04-23T10:00:00.000Z",
    };
    expect(computeAfterHash(null, payload)).toBe(computeAfterHash(null, payload));
  });

  it("produces a different hash when before_hash changes", () => {
    const payload = {
      tenant_id: TENANT_A,
      actor_id: "u_1",
      action: "x",
      diff: null,
      context: null,
      created_at: "2026-04-23T10:00:00.000Z",
    };
    const a = computeAfterHash(null, payload);
    const b = computeAfterHash("deadbeef", payload);
    expect(a).not.toBe(b);
  });
});

// ── appendInTx ──────────────────────────────────────────────────────

describe("appendInTx", () => {
  it("first append for a tenant has before_hash = null and a computed after_hash", async () => {
    const appended = await withTenantContext(db, TENANT_A, async (trx) =>
      repo.appendInTx(trx, {
        tenant_id: TENANT_A,
        actor_id: "u_1",
        action: "ent.customer.create",
        target_type: "entity_row",
        target_id: "row-1",
        diff: { after: { name: "Acme" } },
      }),
    );
    expect(appended.before_hash).toBeNull();
    expect(appended.after_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(appended.tenant_id).toBe(TENANT_A);
    expect(appended.action).toBe("ent.customer.create");
  });

  it("subsequent appends chain each row to the previous after_hash", async () => {
    const a = await withTenantContext(db, TENANT_A, async (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u_1", action: "a" }),
    );
    const b = await withTenantContext(db, TENANT_A, async (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u_1", action: "b" }),
    );
    const c = await withTenantContext(db, TENANT_A, async (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u_1", action: "c" }),
    );
    expect(b.before_hash).toBe(a.after_hash);
    expect(c.before_hash).toBe(b.after_hash);
  });

  it("per-tenant chains are independent", async () => {
    const a1 = await withTenantContext(db, TENANT_A, async (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u", action: "a1" }),
    );
    const b1 = await withTenantContext(db, TENANT_B, async (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_B, actor_id: "u", action: "b1" }),
    );
    // b1 is the first write for tenant B — its before_hash is null,
    // NOT a1.after_hash. That proves the chains don't cross.
    expect(b1.before_hash).toBeNull();
    expect(a1.before_hash).toBeNull();
    expect(a1.after_hash).not.toBe(b1.after_hash); // different tenant ids → different payload → different hash

    const a2 = await withTenantContext(db, TENANT_A, async (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u", action: "a2" }),
    );
    expect(a2.before_hash).toBe(a1.after_hash);
  });

  it("vendor-level entries (tenant_id=null) chain separately from tenant entries", async () => {
    const v1 = await withoutTenantContext(db, async (trx) =>
      repo.appendInTx(trx, { tenant_id: null, actor_id: "system", action: "v1" }),
    );
    const v2 = await withoutTenantContext(db, async (trx) =>
      repo.appendInTx(trx, { tenant_id: null, actor_id: "system", action: "v2" }),
    );
    expect(v1.before_hash).toBeNull();
    expect(v2.before_hash).toBe(v1.after_hash);
  });

  it("rolls back the audit row when the outer transaction aborts", async () => {
    const existing = await withTenantContext(db, TENANT_A, async (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u", action: "ok" }),
    );

    await expect(
      withTenantContext(db, TENANT_A, async (trx) => {
        await repo.appendInTx(trx, {
          tenant_id: TENANT_A,
          actor_id: "u",
          action: "rolled-back",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);

    // The aborted row never landed. The chain head is still the
    // successful first append.
    const lastHash = await withTenantContext(db, TENANT_A, (trx) =>
      repo.readLastHashInTx(trx, TENANT_A),
    );
    expect(lastHash).toBe(existing.after_hash);
  });
});

// ── verifyChain ─────────────────────────────────────────────────────

describe("verifyChain", () => {
  it("returns null for a tenant with no audit rows", async () => {
    expect(await repo.verifyChain(TENANT_A)).toBeNull();
  });

  it("returns null for a valid chain of several writes", async () => {
    for (const i of [1, 2, 3, 4, 5]) {
      await withTenantContext(db, TENANT_A, (trx) =>
        repo.appendInTx(trx, {
          tenant_id: TENANT_A,
          actor_id: "u",
          action: `action-${i}`,
          diff: { i },
        }),
      );
    }
    expect(await repo.verifyChain(TENANT_A)).toBeNull();
  });

  it("detects a tampered diff by recomputing the stored after_hash", async () => {
    const first = await withTenantContext(db, TENANT_A, (trx) =>
      repo.appendInTx(trx, {
        tenant_id: TENANT_A,
        actor_id: "u",
        action: "original",
        diff: { value: 1 },
      }),
    );
    // Tamper: overwrite diff directly bypassing the repo.
    await withTenantContext(db, TENANT_A, async (trx) => {
      await trx
        .updateTable("metadata.meta_audit_log")
        .set({ diff: JSON.stringify({ value: 999 }) })
        .where("audit_pk", "=", first.audit_pk)
        .execute();
    });

    const breakage = await repo.verifyChain(TENANT_A);
    expect(breakage).not.toBeNull();
    expect(breakage?.audit_pk).toBe(first.audit_pk);
    expect(breakage?.reason).toMatch(/after_hash mismatch/);
  });

  it("detects a removed middle row by noticing the before_hash break", async () => {
    const a = await withTenantContext(db, TENANT_A, (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u", action: "a" }),
    );
    const b = await withTenantContext(db, TENANT_A, (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u", action: "b" }),
    );
    const c = await withTenantContext(db, TENANT_A, (trx) =>
      repo.appendInTx(trx, { tenant_id: TENANT_A, actor_id: "u", action: "c" }),
    );
    // Remove row b. c's before_hash now points to b.after_hash (stale).
    await withTenantContext(db, TENANT_A, async (trx) => {
      await trx.deleteFrom("metadata.meta_audit_log").where("audit_pk", "=", b.audit_pk).execute();
    });

    const breakage = await repo.verifyChain(TENANT_A);
    expect(breakage).not.toBeNull();
    expect(breakage?.audit_pk).toBe(c.audit_pk);
    expect(breakage?.reason).toMatch(/before_hash mismatch/);
    expect(a).toBeDefined();
  });
});
