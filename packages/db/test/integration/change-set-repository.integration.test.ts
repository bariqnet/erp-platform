// TASK-07 · ChangeSetRepository integration tests.
//
// Three scenarios from the task's Done-when list:
//   1. approve-then-deploy   (state walk + meta_object materialization)
//   2. deploy-then-rollback  (O(1) revert via superseded_by_change_set_id)
//   3. failed deploy leaves system consistent (CHECK constraint forces
//      mid-transaction abort; assert no rows landed)
//
// Plus audit-trail assertions and the state-machine-error mapping.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Result } from "@erp/core";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChangeSetRepository } from "../../src/change-set-repository.js";
import { createMigrator } from "../../src/migrator.js";
import { withTenantContext } from "../../src/tenant-context.js";

import type { Database } from "../../src/schema.js";
import type { TransitionActor } from "@erp/change-set";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT = "t_alpha";

const PROPOSER: TransitionActor = {
  actor_id: "u_proposer",
  roles: ["metadata.write"],
  draft_author_id: "u_proposer",
};
const APPROVER: TransitionActor = { actor_id: "u_approver", roles: ["metadata.approve"] };
const DEPLOYER: TransitionActor = { actor_id: "u_deployer", roles: ["metadata.deploy"] };

let container: StartedTestContainer;
let db: Kysely<Database>;
let repo: ChangeSetRepository;

async function freshDb(): Promise<void> {
  // Drop and re-apply migrations between scenarios so each test owns a
  // pristine schema. Faster than booting a new container for each test.
  await sql`DROP SCHEMA IF EXISTS metadata CASCADE`.execute(db);
  await sql`DROP ROLE IF EXISTS erp_app`.execute(db);
  await sql`DELETE FROM kysely_migration`.execute(db).catch(() => undefined);
  await sql`DELETE FROM kysely_migration_lock`.execute(db).catch(() => undefined);

  const migrator = createMigrator(db, MIGRATIONS_DIR);
  const result = await migrator.migrateToLatest();
  if (result.error) throw result.error;
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

  repo = new ChangeSetRepository(db);
});

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

beforeEach(async () => {
  await freshDb();
});

// ── Scenario 1: approve-then-deploy ─────────────────────────────────

describe("approve → deploy materializes operations into meta_object", () => {
  it("walks draft → proposed → approved → deployed and writes one row per op", async () => {
    const cs = "cs_a1";
    await repo.create(TENANT, {
      change_set_id: cs,
      created_by: PROPOSER.actor_id,
      description: "add Customer entity",
    });

    const addOps = await repo.addOperations(TENANT, {
      change_set_id: cs,
      operations: [
        {
          op: "upsert",
          object_id: "ent.customer",
          object_type: "Entity",
          layer: "L2",
          body: { name: "Customer", label: { en: "Customer" } },
        },
        {
          op: "upsert",
          object_id: "ent.invoice",
          object_type: "Entity",
          layer: "L2",
          body: { name: "Invoice", label: { en: "Invoice" } },
        },
      ],
    });
    expect(Result.isOk(addOps)).toBe(true);

    const propose = await repo.transition(TENANT, {
      change_set_id: cs,
      action: "propose",
      actor: PROPOSER,
    });
    expect(propose.ok && propose.value.to_state).toBe("proposed");
    expect(propose.ok && propose.value.event?.event_type).toBe("metadata.change_set_proposed");

    const approve = await repo.transition(TENANT, {
      change_set_id: cs,
      action: "approve",
      actor: APPROVER,
    });
    expect(approve.ok && approve.value.to_state).toBe("approved");

    const deploy = await repo.transition(TENANT, {
      change_set_id: cs,
      action: "deploy",
      actor: DEPLOYER,
    });
    expect(deploy.ok).toBe(true);
    if (deploy.ok) {
      expect(deploy.value.to_state).toBe("deployed");
      expect(deploy.value.operations_applied).toBe(2);
      expect(deploy.value.event?.event_type).toBe("metadata.change_set_deployed");
    }

    // Two new active rows in meta_object.
    const rows = await withTenantContext(db, TENANT, async (trx) =>
      trx
        .selectFrom("metadata.meta_object")
        .selectAll()
        .where("change_set_id", "=", cs)
        .orderBy("object_id")
        .execute(),
    );
    expect(rows.map((r) => r.object_id)).toEqual(["ent.customer", "ent.invoice"]);
    expect(rows.every((r) => r.valid_until === null)).toBe(true);
    expect(rows.every((r) => r.version === 1)).toBe(true);

    // Audit log entries for created + propose + approve + deploy.
    const audit = await withTenantContext(db, TENANT, async (trx) =>
      trx
        .selectFrom("metadata.meta_audit_log")
        .selectAll()
        .where("change_set_id", "=", cs)
        .orderBy("audit_pk")
        .execute(),
    );
    expect(audit.map((a) => a.action)).toEqual([
      "change_set.created",
      "change_set.propose",
      "change_set.approve",
      "change_set.deploy",
    ]);
  });
});

// ── Scenario 2: deploy-then-rollback ────────────────────────────────

describe("deploy → rollback reverts via superseded_by_change_set_id", () => {
  it("re-activates prior rows and supersedes the rows the deploy created", async () => {
    // First Change Set: deploy version 1.
    await repo.create(TENANT, { change_set_id: "cs_v1", created_by: PROPOSER.actor_id });
    await repo.addOperations(TENANT, {
      change_set_id: "cs_v1",
      operations: [
        {
          op: "upsert",
          object_id: "ent.customer",
          object_type: "Entity",
          layer: "L2",
          body: { name: "Customer", label: { en: "v1" } },
        },
      ],
    });
    await repo.transition(TENANT, { change_set_id: "cs_v1", action: "propose", actor: PROPOSER });
    await repo.transition(TENANT, { change_set_id: "cs_v1", action: "approve", actor: APPROVER });
    await repo.transition(TENANT, { change_set_id: "cs_v1", action: "deploy", actor: DEPLOYER });

    // Second Change Set: deploy version 2 (which supersedes v1).
    await repo.create(TENANT, { change_set_id: "cs_v2", created_by: PROPOSER.actor_id });
    await repo.addOperations(TENANT, {
      change_set_id: "cs_v2",
      operations: [
        {
          op: "upsert",
          object_id: "ent.customer",
          object_type: "Entity",
          layer: "L2",
          body: { name: "Customer", label: { en: "v2" } },
        },
      ],
    });
    await repo.transition(TENANT, { change_set_id: "cs_v2", action: "propose", actor: PROPOSER });
    await repo.transition(TENANT, { change_set_id: "cs_v2", action: "approve", actor: APPROVER });
    await repo.transition(TENANT, { change_set_id: "cs_v2", action: "deploy", actor: DEPLOYER });

    // Active row before rollback: cs_v2's version 2.
    const before = await withTenantContext(db, TENANT, async (trx) =>
      trx
        .selectFrom("metadata.meta_object")
        .selectAll()
        .where("object_id", "=", "ent.customer")
        .where("valid_until", "is", null)
        .execute(),
    );
    expect(before).toHaveLength(1);
    expect(before[0]?.change_set_id).toBe("cs_v2");
    expect(before[0]?.version).toBe(2);

    // Roll back cs_v2.
    const rollback = await repo.transition(TENANT, {
      change_set_id: "cs_v2",
      action: "rollback",
      actor: DEPLOYER,
    });
    expect(rollback.ok && rollback.value.to_state).toBe("rolled_back");

    // After rollback: v1 is active again, v2 is superseded.
    const after = await withTenantContext(db, TENANT, async (trx) =>
      trx
        .selectFrom("metadata.meta_object")
        .selectAll()
        .where("object_id", "=", "ent.customer")
        .where("valid_until", "is", null)
        .execute(),
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.change_set_id).toBe("cs_v1");
    expect(after[0]?.version).toBe(1);

    // The cs_v2 row exists but is superseded.
    const superseded = await withTenantContext(db, TENANT, async (trx) =>
      trx
        .selectFrom("metadata.meta_object")
        .selectAll()
        .where("change_set_id", "=", "cs_v2")
        .execute(),
    );
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.valid_until).not.toBeNull();
  });
});

// ── Scenario 3: failed deploy leaves system consistent ─────────────

describe("failed deploy leaves system consistent", () => {
  it("a CHECK violation mid-deploy rolls back every operation in the batch", async () => {
    // Add a CHECK constraint that rejects bodies with `{ magic: "fail" }`.
    // The first operation's body passes; the second triggers it; the
    // transaction must roll back, leaving NO rows from this Change Set.
    await sql`
      ALTER TABLE metadata.meta_object
      ADD CONSTRAINT chk_no_magic_fail CHECK (body->>'magic' IS DISTINCT FROM 'fail')
    `.execute(db);

    const cs = "cs_partial";
    await repo.create(TENANT, { change_set_id: cs, created_by: PROPOSER.actor_id });
    await repo.addOperations(TENANT, {
      change_set_id: cs,
      operations: [
        {
          op: "upsert",
          object_id: "ent.alpha",
          object_type: "Entity",
          layer: "L2",
          body: { name: "Alpha" },
        },
        {
          op: "upsert",
          object_id: "ent.bravo",
          object_type: "Entity",
          layer: "L2",
          body: { name: "Bravo", magic: "fail" },
        },
      ],
    });
    await repo.transition(TENANT, { change_set_id: cs, action: "propose", actor: PROPOSER });
    await repo.transition(TENANT, { change_set_id: cs, action: "approve", actor: APPROVER });

    await expect(
      repo.transition(TENANT, { change_set_id: cs, action: "deploy", actor: DEPLOYER }),
    ).rejects.toThrow(/chk_no_magic_fail/);

    // Atomicity: NO meta_object rows from this Change Set landed.
    const rows = await withTenantContext(db, TENANT, async (trx) =>
      trx.selectFrom("metadata.meta_object").selectAll().where("change_set_id", "=", cs).execute(),
    );
    expect(rows).toHaveLength(0);

    // The Change Set itself is still in `approved` — the deploy column flip
    // was inside the same aborted transaction as the inserts.
    const csRow = await withTenantContext(db, TENANT, async (trx) =>
      trx
        .selectFrom("metadata.meta_change_set")
        .selectAll()
        .where("change_set_id", "=", cs)
        .executeTakeFirst(),
    );
    expect(csRow?.status).toBe("approved");
    expect(csRow?.deployed_at).toBeNull();

    // The aborted transaction also rolled back the audit entry — exactly
    // three audit rows exist (created, propose, approve) and no fourth
    // for the failed deploy.
    const audit = await withTenantContext(db, TENANT, async (trx) =>
      trx
        .selectFrom("metadata.meta_audit_log")
        .selectAll()
        .where("change_set_id", "=", cs)
        .orderBy("audit_pk")
        .execute(),
    );
    expect(audit.map((a) => a.action)).toEqual([
      "change_set.created",
      "change_set.propose",
      "change_set.approve",
    ]);
  });
});

// ── State-machine errors surface as RepoError ───────────────────────

describe("state-machine error mapping", () => {
  it("transition_error is returned when the actor lacks the role", async () => {
    const cs = "cs_role";
    await repo.create(TENANT, { change_set_id: cs, created_by: PROPOSER.actor_id });

    const r = await repo.transition(TENANT, {
      change_set_id: cs,
      action: "approve",
      actor: { actor_id: "u_x", roles: [] },
    });
    expect(Result.isErr(r)).toBe(true);
    if (Result.isErr(r)) {
      expect(r.error.kind).toBe("transition_error");
    }
  });

  it("not_found on a missing change_set_id", async () => {
    const r = await repo.transition(TENANT, {
      change_set_id: "cs_missing",
      action: "propose",
      actor: PROPOSER,
    });
    expect(Result.isErr(r)).toBe(true);
    if (Result.isErr(r)) expect(r.error.kind).toBe("not_found");
  });
});
