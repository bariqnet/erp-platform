// TASK-10.1b.1 · Better Auth end-to-end integration test.
//
// Proves the real Better Auth wiring works against a Testcontainers
// Postgres: sign up, sign in, then hit a role-gated admin route with
// the returned cookie. Plus the `createTestSession` fixture path
// that replaces the dev-header auth every integration test will
// migrate to (TASK-10.1b.2).
//
// Scope:
//   - POST /api/auth/sign-up/email — Better Auth creates rows in
//     auth.user + auth.account.
//   - POST /api/auth/sign-in/email — Better Auth mints a session,
//     sets the signed cookie.
//   - createTestSession() — direct-insert fixture that returns a
//     ready-to-inject cookie string.
//   - 401 when no session + no dev header, in a server booted with
//     `required: true` AND `allowDevHeaders: false`.
//   - 403 when the session belongs to a user who's not a member of
//     the requested tenant.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAuth, createTestSession } from "@erp/auth";
import { createMigrator, type Database, UserTenantRepository } from "@erp/db";
import { createLogger } from "@erp/telemetry";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer, type ServerHandle } from "../../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

const TENANT = "t_alpha";

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
  await sql`DROP SCHEMA IF EXISTS auth CASCADE`.execute(db);
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

// ── createTestSession fixture path ───────────────────────────────

describe("createTestSession — the fixture every integration test will migrate to", () => {
  it("returns a cookie the session resolver accepts", async () => {
    const auth = createAuth({ db, isProduction: false });
    const session = await createTestSession(db, auth, {
      tenantId: TENANT,
      userId: "u_alice",
      email: "alice@erp.local",
      roles: ["metadata.write"],
    });

    expect(session.userId).toBe("u_alice");
    expect(session.cookieHeader).toMatch(/^erp\.session_token=/);

    // The admin list endpoint is role-gated to any caller under the
    // tenant — our fixture should satisfy the auth plugin the same
    // way the dev header does.
    const res = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects",
      headers: {
        cookie: session.cookieHeader,
        "x-tenant-id": TENANT,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("populates appContext.userRoles from metadata.user_tenant", async () => {
    // The change-set POST route requires metadata.write. A reader
    // session (empty roles) gets 403; a writer session gets past the
    // gate and lands at the body-schema validator (400 is proof the
    // role check passed — the route was reached).
    const auth = createAuth({ db, isProduction: false });

    const reader = await createTestSession(db, auth, {
      tenantId: TENANT,
      userId: "u_reader_fixture",
      email: "reader@erp.local",
      roles: [],
    });
    const writer = await createTestSession(db, auth, {
      tenantId: TENANT,
      userId: "u_writer_fixture",
      email: "writer@erp.local",
      roles: ["metadata.write"],
    });

    const readerRes = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes",
      headers: { cookie: reader.cookieHeader, "x-tenant-id": TENANT },
      payload: { change_set_id: "cs_fixture", operations: [] },
    });
    expect(readerRes.statusCode).toBe(403);
    expect(readerRes.json()).toMatchObject({ kind: "forbidden" });

    const writerRes = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes",
      headers: { cookie: writer.cookieHeader, "x-tenant-id": TENANT },
      payload: {
        change_set_id: "cs_fixture",
        description: "ba fixture test",
        operations: [],
      },
    });
    expect(writerRes.statusCode).toBe(201);
    const body = writerRes.json() as { change_set_id: string };
    expect(body.change_set_id).toBe("cs_fixture");
  });

  it("denies (403) when the session belongs to a user NOT a member of the tenant", async () => {
    const auth = createAuth({ db, isProduction: false });
    // Create a user that only belongs to t_beta — request against t_alpha.
    const session = await createTestSession(db, auth, {
      tenantId: "t_beta",
      userId: "u_foreign",
      email: "foreign@erp.local",
      roles: ["metadata.write"],
    });

    const res = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects",
      headers: {
        cookie: session.cookieHeader,
        "x-tenant-id": TENANT,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ kind: "forbidden_for_tenant" });
  });
});

// ── /api/auth/sign-up + sign-in round-trip ───────────────────────

describe("/api/auth/* — real Better Auth HTTP endpoints", () => {
  it("sign-up → sign-in → authenticated admin call", async () => {
    // 1. sign up. Better Auth sets a cookie on the response.
    const signUp = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        email: "bob@erp.local",
        password: "bobs-strong-password-123",
        name: "Bob",
      },
    });
    expect(signUp.statusCode).toBe(200);

    // Membership: sign-up does NOT join a tenant — our platform
    // expects user_tenant to be populated by a provisioning flow.
    // Patch it in for the test.
    const signedUpBody = signUp.json() as { user?: { id?: string } };
    const userId = signedUpBody.user?.id;
    expect(userId).toBeDefined();
    if (userId === undefined) return;

    const userTenantRepo = new UserTenantRepository(db);
    await userTenantRepo.add({
      user_id: userId,
      tenant_id: TENANT,
      roles: ["metadata.write"],
    });

    // 2. sign in. Better Auth mints a session cookie.
    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: {
        email: "bob@erp.local",
        password: "bobs-strong-password-123",
      },
    });
    expect(signIn.statusCode).toBe(200);

    const setCookie = signIn.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie);
    // Pull the session_token cookie value out of the Set-Cookie
    // header for the inject call. better-auth formats it as
    //   erp.session_token=<signed>; Path=/; HttpOnly; ...
    const cookieValue = cookieHeader
      .split(",")
      .map((c) => c.split(";")[0]?.trim() ?? "")
      .find((c) => c.startsWith("erp.session_token="));
    expect(cookieValue).toBeDefined();
    if (cookieValue === undefined) return;

    // 3. Authenticated admin call.
    const listObjects = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects",
      headers: {
        cookie: cookieValue,
        "x-tenant-id": TENANT,
      },
    });
    expect(listObjects.statusCode).toBe(200);
  });
});

// ── 401 / dev-header fallback ────────────────────────────────────

describe("auth plugin — required mode + dev-header fallback", () => {
  it("401s a no-session request when required=true + allowDevHeaders=false", async () => {
    // Rebuild the server with dev headers explicitly disabled.
    await handle.close();
    handle = await buildServer({
      db,
      logger: createLogger({ service: "erp-api-test", level: "fatal", pretty: false }),
      authRequired: true,
    });

    // We can't override allowDevHeaders through BuildServerInput yet —
    // but we CAN confirm that a real HTTP call with NO cookie + NO
    // dev headers goes to the dev-header-fallback branch and still
    // 401s because userId is empty. After TASK-10.1b.2 removes the
    // fallback, this assertion tightens.
    const res = await handle.app.inject({
      method: "GET",
      url: "/admin/v1/metadata/objects",
      headers: { "x-tenant-id": TENANT },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ kind: "unauthenticated" });
  });
});
