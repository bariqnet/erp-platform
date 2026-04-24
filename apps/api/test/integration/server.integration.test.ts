// TASK-09 · server contract tests against the real Fastify factory.
//
// Spins up a Postgres Testcontainer + applies migrations + builds the
// server with a silent logger. Exercises every plugin via
// fastify.inject() — no real network. Asserts the contract listed in
// the task's Done-when:
//
//   • /healthz, /readyz, /docs/openapi.json work
//   • errors come back as RFC 7807 problem+json
//   • x-request-id round-trips
//   • tenant-context plugin requires x-tenant-id on non-public routes
//   • auth plugin requires a session when `authRequired: true`

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAuth } from "@erp/auth";
import { createMigrator, type Database } from "@erp/db";
import { createLogger } from "@erp/telemetry";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, type ServerHandle } from "../../src/server.js";

import { makeSession, sessionHeaders } from "./_fixtures/session-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../../../../../infra/migrations");

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
  await freshDb();
});

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

async function makeServer(opts: { authRequired?: boolean } = {}): Promise<ServerHandle> {
  return buildServer({
    db,
    logger: createLogger({ service: "erp-api-test", level: "fatal", pretty: false }),
    ...(opts.authRequired !== undefined ? { authRequired: opts.authRequired } : {}),
  });
}

// ── /healthz ────────────────────────────────────────────────────────

describe("/healthz", () => {
  it("returns 200 with the canonical body", async () => {
    const handle = await makeServer();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; service: string; uptime_seconds: number };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("erp-api");
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    } finally {
      await handle.close();
    }
  });

  it("does not require x-tenant-id (public route)", async () => {
    const handle = await makeServer();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    } finally {
      await handle.close();
    }
  });
});

// ── /readyz ─────────────────────────────────────────────────────────

describe("/readyz", () => {
  it("returns 200 ready when the DB is reachable", async () => {
    const handle = await makeServer();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        status: string;
        checks: Record<string, { status: string; latency_ms?: number }>;
      };
      expect(body.status).toBe("ready");
      expect(body.checks.database?.status).toBe("pass");
      expect(body.checks.database?.latency_ms).toBeGreaterThanOrEqual(0);
    } finally {
      await handle.close();
    }
  });
});

// ── /docs/openapi.json ──────────────────────────────────────────────

describe("/docs/openapi.json", () => {
  it("returns the OpenAPI 3.1 spec with /healthz and /readyz registered", async () => {
    const handle = await makeServer();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/docs/openapi.json" });
      expect(res.statusCode).toBe(200);
      const spec = res.json() as {
        openapi: string;
        info: { title: string; version: string };
        paths?: Record<string, Record<string, unknown>>;
      };
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.info.title).toBe("ERP Platform API");
      expect(spec.paths?.["/healthz"]?.get).toBeDefined();
      expect(spec.paths?.["/readyz"]?.get).toBeDefined();
    } finally {
      await handle.close();
    }
  });
});

// ── x-request-id ────────────────────────────────────────────────────

describe("x-request-id", () => {
  it("echoes back a caller-supplied request id", async () => {
    const handle = await makeServer();
    try {
      const res = await handle.app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-request-id": "rq_test_123" },
      });
      expect(res.headers["x-request-id"]).toBe("rq_test_123");
    } finally {
      await handle.close();
    }
  });

  it("generates one when the caller omits it", async () => {
    const handle = await makeServer();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/healthz" });
      const id = res.headers["x-request-id"];
      expect(typeof id).toBe("string");
      expect(String(id).length).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });
});

// ── 404 + error envelope ───────────────────────────────────────────

describe("RFC 7807 errors", () => {
  it("404 unknown route returns problem+json", async () => {
    const handle = await makeServer();
    try {
      const res = await handle.app.inject({ method: "GET", url: "/no-such-route" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      const body = res.json() as { type: string; title: string; status: number; kind?: string };
      expect(body.status).toBe(404);
      expect(body.title).toBe("Not Found");
      expect(body.kind).toBe("not_found");
    } finally {
      await handle.close();
    }
  });
});

// ── tenant-context ─────────────────────────────────────────────────

describe("tenant-context", () => {
  it("refuses non-public routes without x-tenant-id", async () => {
    const handle = await makeServer();
    try {
      // Register a stub route inside the test so we have something
      // tenant-scoped to hit. Real tenant routes land in TASK-10.
      handle.app.get("/v1/_probe", async (req, reply) =>
        reply.send({ tenant: req.appContext.tenantId }),
      );

      const res = await handle.app.inject({ method: "GET", url: "/v1/_probe" });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { kind: string };
      expect(body.kind).toBe("missing_tenant");
    } finally {
      await handle.close();
    }
  });

  it("rejects malformed tenant ids", async () => {
    const handle = await makeServer();
    try {
      handle.app.get("/v1/_probe", async (req, reply) =>
        reply.send({ tenant: req.appContext.tenantId }),
      );
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/_probe",
        headers: { "x-tenant-id": "Bad-Tenant" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { kind: string };
      expect(body.kind).toBe("invalid_tenant");
    } finally {
      await handle.close();
    }
  });

  it("plumbs the tenant id into request.appContext for valid headers", async () => {
    const handle = await makeServer();
    try {
      handle.app.get("/v1/_probe", async (req, reply) =>
        reply.send({ tenant: req.appContext.tenantId }),
      );
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/_probe",
        headers: { "x-tenant-id": "t_alpha" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ tenant: "t_alpha" });
    } finally {
      await handle.close();
    }
  });
});

// ── auth ────────────────────────────────────────────────────────────

describe("auth plugin", () => {
  it("when required, refuses requests without a session cookie", async () => {
    const handle = await makeServer({ authRequired: true });
    try {
      handle.app.get("/v1/_probe2", async (req, reply) =>
        reply.send({ user: req.appContext.userId }),
      );
      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/_probe2",
        headers: { "x-tenant-id": "t_alpha" },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { kind: string };
      expect(body.kind).toBe("unauthenticated");
    } finally {
      await handle.close();
    }
  });

  it("populates user id and roles from a Better Auth session", async () => {
    // Rebuild schema so this test's inserts don't collide with others
    // that ran earlier in the suite.
    await freshDb();
    const handle = await makeServer({ authRequired: true });
    try {
      handle.app.get("/v1/_probe3", async (req, reply) =>
        reply.send({
          user: req.appContext.userId,
          roles: req.appContext.userRoles,
        }),
      );

      const auth = createAuth({ db, isProduction: false });
      const session = await makeSession(db, auth, {
        tenantId: "t_alpha",
        userId: "u_42",
        email: "u42@erp.local",
        roles: ["metadata.write", "metadata.approve"],
      });

      const res = await handle.app.inject({
        method: "GET",
        url: "/v1/_probe3",
        headers: sessionHeaders(session),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        user: "u_42",
        roles: ["metadata.write", "metadata.approve"],
      });
    } finally {
      await handle.close();
    }
  });
});
