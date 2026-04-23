// TASK-10 · Admin API contract tests for all 9 RFC §9.1 endpoints.
//
// Spins up Postgres + applies migrations + builds the server. Each
// scenario walks the role-gated routes via fastify.inject() — no
// real network. Auth uses the dev-mode `x-user-id` / `x-user-roles`
// headers (Better Auth integration is deferred — needs Zod 4 ADR;
// see CHANGELOG TASK-10 entry).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMigrator, type Database } from "@erp/db";
import { createLogger } from "@erp/telemetry";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer, type ServerHandle } from "../../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT = "t_alpha";

const PROPOSER_HEADERS = {
  "x-tenant-id": TENANT,
  "x-user-id": "u_proposer",
  "x-user-roles": "metadata.write",
};
const APPROVER_HEADERS = {
  "x-tenant-id": TENANT,
  "x-user-id": "u_approver",
  "x-user-roles": "metadata.approve",
};
const DEPLOYER_HEADERS = {
  "x-tenant-id": TENANT,
  "x-user-id": "u_deployer",
  "x-user-roles": "metadata.deploy",
};
const READER_HEADERS = {
  "x-tenant-id": TENANT,
  "x-user-id": "u_reader",
  "x-user-roles": "",
};

let container: StartedTestContainer;
let db: Kysely<Database>;
let handle: ServerHandle;

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
  await sql`DROP SCHEMA IF EXISTS metadata CASCADE`.execute(db);
  await sql`DROP SCHEMA IF EXISTS ops CASCADE`.execute(db);
  await sql`DROP ROLE IF EXISTS erp_app`.execute(db);
  await sql`DELETE FROM kysely_migration`.execute(db).catch(() => undefined);
  await sql`DELETE FROM kysely_migration_lock`.execute(db).catch(() => undefined);
  const m = createMigrator(db, MIGRATIONS_DIR);
  const r = await m.migrateToLatest();
  if (r.error) throw r.error;
  handle = await buildServer({
    db,
    logger: createLogger({ service: "erp-api-test", level: "fatal", pretty: false }),
    authRequired: true,
  });
});

// ── Read-side routes ────────────────────────────────────────────────

describe("GET /admin/v1/metadata/objects", () => {
  it("returns an empty page when nothing is deployed", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects",
      headers: READER_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; limit: number; offset: number };
    expect(body.items).toEqual([]);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("requires x-tenant-id", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects",
      headers: { "x-user-id": "u", "x-user-roles": "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ kind: "missing_tenant" });
  });
});

describe("GET /admin/v1/metadata/objects/{id}", () => {
  it("404 when no layer contributes a body", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects/ent.absent",
      headers: READER_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });
});

describe("GET /admin/v1/metadata/objects/{id}/history", () => {
  it("returns an empty list when the object has no history", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects/ent.absent/history",
      headers: READER_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });
});

// ── Write-side routes (the Change Set lifecycle) ───────────────────

describe("POST /admin/v1/metadata/changes — happy path", () => {
  it("creates a draft Change Set with operations and returns 201", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes",
      headers: PROPOSER_HEADERS,
      payload: {
        change_set_id: "cs_create_1",
        description: "add Customer",
        operations: [
          {
            op: "upsert",
            object_id: "ent.customer",
            object_type: "Entity",
            layer: "L2",
            body: { name: "Customer", label: { en: "Customer" } },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { status: string; operation_count: number };
    expect(body.status).toBe("draft");
    expect(body.operation_count).toBe(1);
  });

  it("403 when the caller lacks metadata.write", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes",
      headers: READER_HEADERS,
      payload: {
        change_set_id: "cs_no_role",
        operations: [],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ kind: "forbidden" });
  });

  it("400 when the body fails Zod validation", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes",
      headers: PROPOSER_HEADERS,
      payload: { description: "no id" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ kind: "validation_error" });
  });

  it("409 when a Change Set with this id already exists", async () => {
    const create = async (): Promise<{ statusCode: number }> =>
      handle.app.inject({
        method: "POST",
        url: "/admin/v1/metadata/changes",
        headers: PROPOSER_HEADERS,
        payload: { change_set_id: "cs_dupe", operations: [] },
      });
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(409);
  });
});

describe("POST /admin/v1/metadata/changes/{id}/simulate", () => {
  it("returns the staged-operations summary without applying", async () => {
    const create = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes",
      headers: PROPOSER_HEADERS,
      payload: {
        change_set_id: "cs_sim",
        operations: [
          {
            op: "upsert",
            object_id: "ent.customer",
            object_type: "Entity",
            layer: "L2",
            body: { name: "Customer" },
          },
          {
            op: "tombstone",
            object_id: "ent.legacy",
            layer: "L2",
            reason: "retired",
          },
        ],
      },
    });
    expect(create.statusCode).toBe(201);

    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_sim/simulate",
      headers: PROPOSER_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      operation_count: number;
      affected_objects: { object_id: string; op: string }[];
    };
    expect(body.operation_count).toBe(2);
    expect(body.affected_objects.map((a) => a.object_id).sort()).toEqual([
      "ent.customer",
      "ent.legacy",
    ]);
  });
});

describe("Lifecycle — propose → approve → deploy → rollback", () => {
  beforeEach(async () => {
    const r = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes",
      headers: PROPOSER_HEADERS,
      payload: {
        change_set_id: "cs_life",
        operations: [
          {
            op: "upsert",
            object_id: "ent.customer",
            object_type: "Entity",
            layer: "L2",
            body: { name: "Customer", label: { en: "Customer" } },
          },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it("propose moves draft → proposed and returns the transition envelope", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/propose",
      headers: PROPOSER_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { from_state: string; to_state: string; event_id: string | null };
    expect(body.from_state).toBe("draft");
    expect(body.to_state).toBe("proposed");
    expect(body.event_id).not.toBeNull();
  });

  it("approve requires metadata.approve role", async () => {
    await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/propose",
      headers: PROPOSER_HEADERS,
    });

    const wrong = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/approve",
      headers: PROPOSER_HEADERS,
    });
    expect(wrong.statusCode).toBe(403);

    const right = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/approve",
      headers: APPROVER_HEADERS,
    });
    expect(right.statusCode).toBe(200);
    expect(right.json()).toMatchObject({ from_state: "proposed", to_state: "approved" });
  });

  it("deploy materializes the operation and returns the envelope; subsequent get returns the resolved object", async () => {
    await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/propose",
      headers: PROPOSER_HEADERS,
    });
    await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/approve",
      headers: APPROVER_HEADERS,
    });

    const deploy = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/deploy",
      headers: DEPLOYER_HEADERS,
    });
    expect(deploy.statusCode).toBe(200);
    expect(deploy.json()).toMatchObject({
      to_state: "deployed",
      operations_applied: 1,
    });

    // The resolver-backed GET now returns the body.
    const get = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects/ent.customer",
      headers: READER_HEADERS,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      object_id: "ent.customer",
      body: { name: "Customer", label: { en: "Customer" } },
    });
  });

  it("rollback returns deployed → rolled_back; the object is no longer resolved", async () => {
    await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/propose",
      headers: PROPOSER_HEADERS,
    });
    await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/approve",
      headers: APPROVER_HEADERS,
    });
    await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/deploy",
      headers: DEPLOYER_HEADERS,
    });

    const roll = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/rollback",
      headers: DEPLOYER_HEADERS,
    });
    expect(roll.statusCode).toBe(200);
    expect(roll.json()).toMatchObject({ from_state: "deployed", to_state: "rolled_back" });

    const get = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects/ent.customer",
      headers: READER_HEADERS,
    });
    expect(get.statusCode).toBe(404);
  });

  it("approve from draft is rejected as invalid_transition (409)", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_life/approve",
      headers: APPROVER_HEADERS,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ kind: "invalid_transition" });
  });

  it("any transition on an unknown change_set is 404", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_missing/propose",
      headers: PROPOSER_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ kind: "not_found" });
  });
});

// ── /docs/openapi.json includes every admin route ─────────────────

describe("OpenAPI registry — every admin route registered", () => {
  it("/docs/openapi.json lists all 9 admin routes", async () => {
    const res = await handle.app.inject({ method: "GET", url: "/docs/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { paths: Record<string, Record<string, unknown>> };
    const paths = Object.keys(spec.paths);
    for (const expected of [
      "/admin/v1/metadata/objects",
      "/admin/v1/metadata/objects/{id}",
      "/admin/v1/metadata/objects/{id}/history",
      "/admin/v1/metadata/changes",
      "/admin/v1/metadata/changes/{id}/simulate",
      "/admin/v1/metadata/changes/{id}/propose",
      "/admin/v1/metadata/changes/{id}/approve",
      "/admin/v1/metadata/changes/{id}/deploy",
      "/admin/v1/metadata/changes/{id}/rollback",
    ]) {
      expect(paths).toContain(expected);
    }
  });
});
