// TASK-15 · lifecycle transition guards + actions endpoint.
//
// Covers:
//   - PATCH with a status change that doesn't match a declared
//     transition returns 409 invalid_transition.
//   - PATCH with a legal transition succeeds and writes the new
//     status.
//   - PATCH with body changes that don't touch status is unaffected.
//   - POST /v1/:entity/:id/actions/:action transitions the row via
//     the declared action name.
//   - Invoking an action that's legal but with the row in the wrong
//     state returns 404 unknown_action.
//   - Both paths emit a `runtime.<entity_id>.<action>` outbox event
//     atomic with the row update.

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
const ENTITY = "ent.ticket";

let container: StartedTestContainer;
let db: Kysely<Database>;
let handle: ServerHandle;
let ADMIN_HEADERS: { cookie: string; "x-tenant-id": string };

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
 * Seeds an `ent.ticket` Entity at L0 with a 4-state lifecycle and
 * three transitions — the canonical shape for testing the guard
 * logic. Also seeds a prm.admin Permission that grants every action
 * on `ent.ticket` so the Permission Gate doesn't get in the way.
 */
async function seedTicketEntity(): Promise<void> {
  const entityBody = {
    name: "Ticket",
    label: { en: "Ticket" },
    storage: { strategy: "jsonb" },
    fields: [
      { name: "title", type: "string", required: true, max_length: 120 },
      { name: "priority", type: "integer" },
    ],
    lifecycle: {
      states: ["open", "in_progress", "resolved", "reopened"],
      initial: "open",
      transitions: [
        { from: "open", to: "in_progress", action: "start" },
        { from: "in_progress", to: "resolved", action: "resolve" },
        { from: "resolved", to: "reopened", action: "reopen" },
        { from: "reopened", to: "in_progress", action: "start" },
      ],
    },
  };
  const permissionBody = {
    role_id: "prm.admin",
    label: { en: "Admin" },
    entity_grants: {
      "ent.ticket": ["read", "create", "update", "delete"],
    },
  };

  await db
    .insertInto("metadata.meta_object")
    .values([
      {
        object_id: ENTITY,
        object_type: "Entity",
        layer: "L0",
        tenant_id: null,
        template_id: null,
        version: 1,
        operation: "upsert",
        body: JSON.stringify(entityBody),
        created_by: "seed",
        created_via: "test",
        change_set_id: "cs_ticket_seed",
      },
      {
        object_id: "prm.admin",
        object_type: "Permission",
        layer: "L0",
        tenant_id: null,
        template_id: null,
        version: 1,
        operation: "upsert",
        body: JSON.stringify(permissionBody),
        created_by: "seed",
        created_via: "test",
        change_set_id: "cs_ticket_seed",
      },
    ])
    .execute();
}

async function createTicket(title = "Broken widget"): Promise<string> {
  const res = await handle.app.inject({
    method: "POST",
    url: `/v1/${ENTITY}`,
    headers: ADMIN_HEADERS,
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { row_id: string }).row_id;
}

async function countOutboxEvents(eventTypePrefix: string): Promise<number> {
  const row = await db
    .selectFrom("metadata.meta_outbox")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("event_type", "like", `${eventTypePrefix}%`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
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
});

// ── PATCH with status changes ────────────────────────────────────────

describe("PATCH /v1/:entity/:id with status change", () => {
  it("rejects an illegal transition with 409 invalid_transition", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    // open → resolved isn't declared; must 409.
    const res = await handle.app.inject({
      method: "PATCH",
      url: `/v1/${ENTITY}/${rowId}`,
      headers: ADMIN_HEADERS,
      payload: { status: "resolved" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      kind: "invalid_transition",
    });

    // The row's status stays `open`.
    const after = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}/${rowId}`,
      headers: ADMIN_HEADERS,
    });
    expect((after.json() as { status: string }).status).toBe("open");
  });

  it("accepts a declared transition and emits a runtime event", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    const before = await countOutboxEvents("runtime.ent_ticket.");

    const res = await handle.app.inject({
      method: "PATCH",
      url: `/v1/${ENTITY}/${rowId}`,
      headers: ADMIN_HEADERS,
      payload: { status: "in_progress" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("in_progress");

    const after = await countOutboxEvents("runtime.ent_ticket.start");
    expect(after).toBe(before + 1);
  });

  it("allows PATCH body changes that don't touch status", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    const res = await handle.app.inject({
      method: "PATCH",
      url: `/v1/${ENTITY}/${rowId}`,
      headers: ADMIN_HEADERS,
      payload: { priority: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { body: { priority: number }; status: string };
    expect(body.body.priority).toBe(1);
    expect(body.status).toBe("open"); // unchanged
  });

  it("accepts status equal to current state as a no-op", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    const res = await handle.app.inject({
      method: "PATCH",
      url: `/v1/${ENTITY}/${rowId}`,
      headers: ADMIN_HEADERS,
      payload: { status: "open" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("open");
  });
});

// ── POST actions endpoint ────────────────────────────────────────────

describe("POST /v1/:entity/:id/actions/:action", () => {
  it("applies the transition + writes the new status", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}/${rowId}/actions/start`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("in_progress");
  });

  it("chains transitions: start → resolve → reopen → start", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    for (const [action, expected] of [
      ["start", "in_progress"],
      ["resolve", "resolved"],
      ["reopen", "reopened"],
      ["start", "in_progress"],
    ] as const) {
      const res = await handle.app.inject({
        method: "POST",
        url: `/v1/${ENTITY}/${rowId}/actions/${action}`,
        headers: ADMIN_HEADERS,
      });
      expect(res.statusCode, `after ${action}`).toBe(200);
      expect((res.json() as { status: string }).status).toBe(expected);
    }
  });

  it("404s an action not legal from the current state", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    // `resolve` is declared but only legal from in_progress — row is open.
    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}/${rowId}/actions/resolve`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ kind: "unknown_action" });
  });

  it("404s an action name that isn't declared at all", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}/${rowId}/actions/vaporize`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ kind: "unknown_action" });
  });

  it("400s an action name that fails the route-level shape check", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}/${rowId}/actions/BadCase`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(400);
  });

  it("emits a runtime.ent_ticket.start outbox event on successful action", async () => {
    await seedTicketEntity();
    const rowId = await createTicket();

    const before = await countOutboxEvents("runtime.ent_ticket.start");
    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}/${rowId}/actions/start`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const after = await countOutboxEvents("runtime.ent_ticket.start");
    expect(after).toBe(before + 1);

    // Sanity: the outbox row carries the expected payload shape.
    const row = await db
      .selectFrom("metadata.meta_outbox")
      .selectAll()
      .where("event_type", "=", "runtime.ent_ticket.start")
      .orderBy("outbox_pk", "desc")
      .executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe(TENANT);
    const payload = row.payload as {
      entity_id: string;
      row_id: string;
      action: string;
      from: string;
      to: string;
    };
    expect(payload.entity_id).toBe(ENTITY);
    expect(payload.row_id).toBe(rowId);
    expect(payload.action).toBe("start");
    expect(payload.from).toBe("open");
    expect(payload.to).toBe("in_progress");
  });

  it("404s when the row doesn't exist", async () => {
    await seedTicketEntity();
    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}/00000000-0000-4000-8000-000000000000/actions/start`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ kind: "row_not_found" });
  });
});
