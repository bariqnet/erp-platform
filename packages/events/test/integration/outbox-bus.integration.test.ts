// TASK-08 · OutboxBus + OutboxPump integration tests.
//
// Four scenarios from the task's Done-when list:
//   1. Atomicity — publishWithin inside an aborted tx leaves outbox empty;
//      inside a committed tx leaves it populated.
//   2. At-least-once with dedup — publish twice with the same dedup_key →
//      one row.
//   3. Pump delivery — publish → drainOnce dispatches to subscriber →
//      delivered_at flips → second drainOnce is no-op.
//   4. Restart durability — publish via bus A; create a fresh bus B + pump B
//      against the same DB; pump B delivers what bus A wrote.
//   Plus failing-handler retry behavior.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type DomainEvent, type EventHandler } from "@erp/core";
import { createMigrator, type Database } from "@erp/db";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OutboxBus } from "../../src/outbox-bus.js";
import { OutboxPump } from "../../src/pump.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

let container: StartedTestContainer;
let db: Kysely<Database>;

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: "metadata.test_event",
    event_version: 1,
    occurred_at: "2026-04-23T10:00:00.000Z",
    tenant_id: "t_alpha",
    actor_id: "u_1",
    payload: { hello: "world" },
    ...overrides,
  };
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
  await sql`DROP SCHEMA IF EXISTS metadata CASCADE`.execute(db);
  await sql`DROP SCHEMA IF EXISTS ops CASCADE`.execute(db);
  await sql`DROP ROLE IF EXISTS erp_app`.execute(db);
  await sql`DELETE FROM kysely_migration`.execute(db).catch(() => undefined);
  await sql`DELETE FROM kysely_migration_lock`.execute(db).catch(() => undefined);
  const migrator = createMigrator(db, MIGRATIONS_DIR);
  const r = await migrator.migrateToLatest();
  if (r.error) throw r.error;
});

// ── Scenario 1: atomicity ──────────────────────────────────────────

describe("publishWithin is atomic with the caller's transaction", () => {
  it("aborted tx → no outbox row", async () => {
    const bus = new OutboxBus(db);
    const event = makeEvent({ event_type: "test.aborted" });

    await db
      .transaction()
      .execute(async (trx) => {
        await bus.publishWithin(trx, event);
        throw new Error("intentional abort");
      })
      .catch(() => undefined);

    const rows = await db
      .selectFrom("metadata.meta_outbox")
      .selectAll()
      .where("event_id", "=", event.event_id)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("committed tx → exactly one outbox row", async () => {
    const bus = new OutboxBus(db);
    const event = makeEvent({ event_type: "test.committed" });

    await db.transaction().execute(async (trx) => {
      await bus.publishWithin(trx, event);
    });

    const rows = await db
      .selectFrom("metadata.meta_outbox")
      .selectAll()
      .where("event_id", "=", event.event_id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivered_at).toBeNull();
    expect(rows[0]?.attempt_count).toBe(0);
  });
});

// ── Scenario 2: dedup_key ──────────────────────────────────────────

describe("dedup_key collapses retried publishes", () => {
  it("two publishes with the same dedup_key produce one row", async () => {
    const bus = new OutboxBus(db);
    const dedup = "deploy:cs_99";

    await bus.publish(makeEvent({ event_type: "metadata.change_set_deployed", dedup_key: dedup }));
    await bus.publish(makeEvent({ event_type: "metadata.change_set_deployed", dedup_key: dedup }));

    const rows = await db
      .selectFrom("metadata.meta_outbox")
      .selectAll()
      .where("dedup_key", "=", dedup)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

// ── Scenario 3: pump delivery ──────────────────────────────────────

describe("OutboxPump.drainOnce delivers to subscribers and marks rows", () => {
  it("happy path: publish → drainOnce → handler fires → delivered_at set", async () => {
    const bus = new OutboxBus(db);
    const pump = new OutboxPump(db, bus, { batchSize: 10, maxAttempts: 3 });

    const seen: DomainEvent[] = [];
    const handler: EventHandler = (e) => {
      seen.push(e);
    };
    bus.subscribe("metadata.test_event", handler);

    const ev = makeEvent({ event_type: "metadata.test_event" });
    await bus.publish(ev);

    const stats = await pump.drainOnce();
    expect(stats).toEqual({ attempted: 1, delivered: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event_id).toBe(ev.event_id);

    // Second drain is a no-op — delivered_at is set.
    const stats2 = await pump.drainOnce();
    expect(stats2.attempted).toBe(0);

    const row = await db
      .selectFrom("metadata.meta_outbox")
      .selectAll()
      .where("event_id", "=", ev.event_id)
      .executeTakeFirst();
    expect(row?.delivered_at).not.toBeNull();
  });

  it("dispatches every event_type fan-out independently", async () => {
    const bus = new OutboxBus(db);
    const pump = new OutboxPump(db, bus);

    const a: DomainEvent[] = [];
    const b: DomainEvent[] = [];
    bus.subscribe("test.a", (e) => {
      a.push(e);
    });
    bus.subscribe("test.b", (e) => {
      b.push(e);
    });

    await bus.publish(makeEvent({ event_type: "test.a", dedup_key: "a" }));
    await bus.publish(makeEvent({ event_type: "test.a", dedup_key: "a2" }));
    await bus.publish(makeEvent({ event_type: "test.b", dedup_key: "b" }));

    await pump.drainOnce();
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });
});

// ── Scenario 4: restart durability ─────────────────────────────────

describe("events survive a process restart", () => {
  it("a fresh bus+pump delivers events the previous bus published", async () => {
    // "Process A": publish via bus A, then immediately discard it
    // (no subscribers, no pump). The DB row persists.
    const busA = new OutboxBus(db);
    await busA.publish(
      makeEvent({ event_type: "test.persisted", dedup_key: "persisted-1", payload: { run: "A" } }),
    );

    // "Process B" boots: brand-new bus + brand-new pump against the
    // same DB. Subscribers attached AFTER bus A's publish see the event.
    const busB = new OutboxBus(db);
    const pumpB = new OutboxPump(db, busB);
    const seen: DomainEvent[] = [];
    busB.subscribe("test.persisted", (e) => {
      seen.push(e);
    });

    const stats = await pumpB.drainOnce();
    expect(stats.delivered).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toEqual({ run: "A" });
  });
});

// ── Failing handler / retry ────────────────────────────────────────

describe("failing handler retries up to maxAttempts", () => {
  it("each failed delivery increments attempt_count; row is re-tried until max", async () => {
    const bus = new OutboxBus(db);
    const pump = new OutboxPump(db, bus, { maxAttempts: 3 });

    let attempts = 0;
    bus.subscribe("test.failing", () => {
      attempts += 1;
      throw new Error("boom");
    });

    await bus.publish(makeEvent({ event_type: "test.failing" }));

    // Three drains, all failed, each increments attempt_count.
    for (let i = 0; i < 3; i += 1) {
      const stats = await pump.drainOnce();
      expect(stats.failed).toBe(1);
    }
    expect(attempts).toBe(3);

    // Fourth drain skips the row (attempt_count >= maxAttempts).
    const stats = await pump.drainOnce();
    expect(stats.attempted).toBe(0);

    // Surfaces in the dead-letter list.
    const dead = await pump.deadLettered();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.last_error).toContain("boom");
  });
});
