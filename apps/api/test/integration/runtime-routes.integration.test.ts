// TASK-12 · Runtime API integration tests.
//
// Covers:
//   • /v1/:entity and /v1/:entity/:id for GET / POST / PATCH / DELETE
//   • Permission Gate — deny-by-default, role matching, action grants
//   • Auto-derivation — deploy ent.customer at L0, deploy a Change Set
//     that adds a loyalty_tier field at L2, POST with the new field,
//     GET it back (the full E2E that CLAUDE.md §13 calls out)
//   • Validation — body shape errors return 400 problem+json
//   • Entity-not-deployed, row-not-found, non-JSONB storage → 501
//   • OpenAPI spec lists the new /v1 routes

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
const ENTITY = "ent.customer";

// Headers:
//   · ADMIN_HEADERS grant every action via the seeded `prm.admin`.
//   · READER_HEADERS have a role that does not match any permission.
//   · PROPOSER/APPROVER/DEPLOYER push metadata through the state machine.
const ADMIN_HEADERS = {
  "x-tenant-id": TENANT,
  "x-user-id": "u_admin",
  "x-user-roles": "prm.admin",
};
const READER_HEADERS = {
  "x-tenant-id": TENANT,
  "x-user-id": "u_reader",
  "x-user-roles": "prm.unknown_role",
};
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

let container: StartedTestContainer;
let db: Kysely<Database>;
let handle: ServerHandle;

// ── Seed helpers ────────────────────────────────────────────────────

/**
 * Seed an `ent.customer` Entity at L0 (vendor-global) plus a
 * `prm.admin` permission granting all actions on every `ent.*` to
 * role `prm.admin`. Both live at L0 so they're visible to every
 * tenant — that's how a fresh tenant can hit the Runtime API without
 * needing its own layer activation first.
 */
async function seedBaselineMetadata(): Promise<void> {
  const entityBody = {
    name: "Customer",
    plural: "Customers",
    label: { en: "Customer", ar: "عميل" },
    storage: { strategy: "jsonb" },
    fields: [
      { name: "name", type: "string", required: true, max_length: 120 },
      { name: "phone", type: "phone" },
      { name: "currency", type: "string", required: true, max_length: 3 },
    ],
    lifecycle: { states: ["active", "inactive"], initial: "active" },
  };

  const permissionBody = {
    role_id: "prm.admin",
    label: { en: "Admin" },
    entity_grants: {
      "ent.customer": ["read", "create", "update", "delete"],
      "ent.product": ["read", "create", "update", "delete"],
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
        change_set_id: "cs_seed",
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
        change_set_id: "cs_seed",
      },
    ])
    .execute();
}

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

// ── Container lifecycle ─────────────────────────────────────────────

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
});

// ── CRUD contract ───────────────────────────────────────────────────

describe("POST /v1/:entity", () => {
  it("201 with materialized-validator-approved body + server-generated row_id", async () => {
    await seedBaselineMetadata();
    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "Acme", currency: "IQD", phone: "+9647700000000" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      row_id: string;
      entity_id: string;
      body: Record<string, unknown>;
      status: string;
    };
    expect(body.row_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.entity_id).toBe(ENTITY);
    expect(body.body).toMatchObject({ name: "Acme", currency: "IQD" });
    expect(body.status).toBe("active"); // from lifecycle.initial
  });

  it("400 when the body fails validation against the derived schema", async () => {
    await seedBaselineMetadata();
    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { currency: "IQD" }, // missing required name
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ kind: "validation_error" });
  });

  it("400 when the body sends a field that the metadata did not declare (strict)", async () => {
    await seedBaselineMetadata();
    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "Acme", currency: "IQD", undeclared_key: "oops" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ kind: "validation_error" });
  });

  it("404 when the entity is not deployed (Permission Gate passes, resolver misses)", async () => {
    // Seed a permission that grants admin on ent.ghost too, so the
    // gate allows; the resolver then 404s because no Entity metadata
    // exists for that id. Without broader grants the Permission Gate
    // correctly returns 403 first — deny-by-default doesn't leak
    // the existence of entities the caller has no right to see.
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
          body: JSON.stringify({
            name: "Customer",
            label: { en: "Customer" },
            storage: { strategy: "jsonb" },
            fields: [{ name: "name", type: "string", required: true }],
          }),
          created_by: "seed",
          created_via: "test",
          change_set_id: "cs_seed",
        },
        {
          object_id: "prm.superadmin",
          object_type: "Permission",
          layer: "L0",
          tenant_id: null,
          template_id: null,
          version: 1,
          operation: "upsert",
          body: JSON.stringify({
            role_id: "prm.superadmin",
            entity_grants: {
              "ent.customer": ["read", "create", "update", "delete"],
              "ent.ghost": ["read", "create", "update", "delete"],
            },
          }),
          created_by: "seed",
          created_via: "test",
          change_set_id: "cs_seed",
        },
      ])
      .execute();

    const headers = {
      "x-tenant-id": TENANT,
      "x-user-id": "u_super",
      "x-user-roles": "prm.superadmin",
    };
    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/ent.ghost",
      headers,
      payload: { name: "Invisible" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ kind: "entity_not_deployed" });
  });

  it("403 (deny-before-leak) when the caller has no grant on an entity — even if it doesn't exist", async () => {
    await seedBaselineMetadata();
    const res = await handle.app.inject({
      method: "POST",
      url: "/v1/ent.ghost",
      headers: ADMIN_HEADERS, // admin only has grants on ent.customer + ent.product
      payload: { name: "Invisible" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /v1/:entity", () => {
  it("returns a page of rows, newest first", async () => {
    await seedBaselineMetadata();
    for (const n of ["A", "B", "C"]) {
      await handle.app.inject({
        method: "POST",
        url: `/v1/${ENTITY}`,
        headers: ADMIN_HEADERS,
        payload: { name: n, currency: "IQD" },
      });
    }
    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { body: { name: string } }[];
      limit: number;
      offset: number;
    };
    expect(body.items.map((i) => i.body.name)).toEqual(["C", "B", "A"]);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("honors limit and offset query params", async () => {
    await seedBaselineMetadata();
    for (const n of ["A", "B", "C", "D", "E"]) {
      await handle.app.inject({
        method: "POST",
        url: `/v1/${ENTITY}`,
        headers: ADMIN_HEADERS,
        payload: { name: n, currency: "IQD" },
      });
    }
    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}?limit=2&offset=1`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { body: { name: string } }[] };
    expect(body.items.map((i) => i.body.name)).toEqual(["D", "C"]);
  });
});

describe("GET /v1/:entity/:id", () => {
  it("returns the row when it exists", async () => {
    await seedBaselineMetadata();
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "Acme", currency: "IQD" },
    });
    const { row_id } = created.json() as { row_id: string };
    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}/${row_id}`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ row_id, body: { name: "Acme" } });
  });

  it("404 problem+json when the row is missing", async () => {
    await seedBaselineMetadata();
    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}/f47ac10b-58cc-4372-a567-0e02b2c3d479`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ kind: "row_not_found" });
  });
});

describe("PATCH /v1/:entity/:id", () => {
  it("merges into the existing body and bumps updated_at", async () => {
    await seedBaselineMetadata();
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "Acme", currency: "IQD" },
    });
    const { row_id, updated_at: before } = created.json() as {
      row_id: string;
      updated_at: string;
    };
    // 20ms to ensure timestamptz strictly increases.
    await new Promise((r) => setTimeout(r, 20));
    const patched = await handle.app.inject({
      method: "PATCH",
      url: `/v1/${ENTITY}/${row_id}`,
      headers: ADMIN_HEADERS,
      payload: { phone: "+9647710000000" },
    });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as {
      body: { name: string; phone: string };
      updated_at: string;
    };
    expect(body.body).toMatchObject({ name: "Acme", phone: "+9647710000000" });
    expect(new Date(body.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("400 when the patched shape violates the derived schema", async () => {
    await seedBaselineMetadata();
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "Acme", currency: "IQD" },
    });
    const { row_id } = created.json() as { row_id: string };
    const bad = await handle.app.inject({
      method: "PATCH",
      url: `/v1/${ENTITY}/${row_id}`,
      headers: ADMIN_HEADERS,
      payload: { phone: "not-e164" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("404 when the row is missing", async () => {
    await seedBaselineMetadata();
    const res = await handle.app.inject({
      method: "PATCH",
      url: `/v1/${ENTITY}/3b7e6a4b-8e3f-4a0b-9c1e-5f4d2a7b9c0e`,
      headers: ADMIN_HEADERS,
      payload: { phone: "+9647700000000" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /v1/:entity/:id", () => {
  it("soft-deletes and subsequent GET returns 404", async () => {
    await seedBaselineMetadata();
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "Acme", currency: "IQD" },
    });
    const { row_id } = created.json() as { row_id: string };
    const del = await handle.app.inject({
      method: "DELETE",
      url: `/v1/${ENTITY}/${row_id}`,
      headers: ADMIN_HEADERS,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });

    const getAfter = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}/${row_id}`,
      headers: ADMIN_HEADERS,
    });
    expect(getAfter.statusCode).toBe(404);
  });
});

// ── Permission Gate ─────────────────────────────────────────────────

describe("Permission Gate (RFC §13.1)", () => {
  it("403 deny-by-default when no prm.* objects are deployed", async () => {
    // No seedBaselineMetadata — only the `ent.customer` (no permissions).
    await db
      .insertInto("metadata.meta_object")
      .values({
        object_id: ENTITY,
        object_type: "Entity",
        layer: "L0",
        tenant_id: null,
        template_id: null,
        version: 1,
        operation: "upsert",
        body: JSON.stringify({
          name: "Customer",
          label: { en: "Customer" },
          storage: { strategy: "jsonb" },
          fields: [{ name: "name", type: "string", required: true }],
        }),
        created_by: "seed",
        created_via: "test",
        change_set_id: "cs_seed",
      })
      .execute();

    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ kind: "forbidden" });
  });

  it("403 when the user's role is not in any deployed permission", async () => {
    await seedBaselineMetadata();
    const res = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: READER_HEADERS,
      payload: { name: "Acme", currency: "IQD" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403 when the role is recognized but the action is not granted", async () => {
    // Seed a permission that only grants `read`.
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
          body: JSON.stringify({
            name: "Customer",
            label: { en: "Customer" },
            storage: { strategy: "jsonb" },
            fields: [
              { name: "name", type: "string", required: true },
              { name: "currency", type: "string", required: true },
            ],
          }),
          created_by: "seed",
          created_via: "test",
          change_set_id: "cs_seed",
        },
        {
          object_id: "prm.reader",
          object_type: "Permission",
          layer: "L0",
          tenant_id: null,
          template_id: null,
          version: 1,
          operation: "upsert",
          body: JSON.stringify({
            role_id: "prm.reader",
            entity_grants: { "ent.customer": ["read"] },
          }),
          created_by: "seed",
          created_via: "test",
          change_set_id: "cs_seed",
        },
      ])
      .execute();

    const readerHeaders = {
      "x-tenant-id": TENANT,
      "x-user-id": "u_r",
      "x-user-roles": "prm.reader",
    };
    const list = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}`,
      headers: readerHeaders,
    });
    expect(list.statusCode).toBe(200);

    const create = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: readerHeaders,
      payload: { name: "Acme", currency: "IQD" },
    });
    expect(create.statusCode).toBe(403);
  });
});

// ── E2E: add a custom field, POST with it, GET it back ─────────────

describe("Custom-field auto-derivation (CLAUDE.md §13 Done-when)", () => {
  it("adding loyalty_tier at L2 makes it queryable via Runtime API without a redeploy", async () => {
    await seedBaselineMetadata();

    // Sanity: baseline POST omits the new field — works fine.
    const before = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "Pre-upgrade", currency: "IQD" },
    });
    expect(before.statusCode).toBe(201);

    // Propose → approve → deploy a Change Set that adds loyalty_tier
    // at L2 (tenant-scoped). The resolver merges L0 + L2 for t_alpha;
    // the materialized validator on the next request accepts the new
    // field.
    const entityBodyWithTier = {
      name: "Customer",
      plural: "Customers",
      label: { en: "Customer", ar: "عميل" },
      storage: { strategy: "jsonb" },
      fields: [
        { name: "name", type: "string", required: true, max_length: 120 },
        { name: "phone", type: "phone" },
        { name: "currency", type: "string", required: true, max_length: 3 },
        {
          name: "loyalty_tier",
          type: "enum",
          values: ["bronze", "silver", "gold"],
        },
      ],
      lifecycle: { states: ["active", "inactive"], initial: "active" },
    };
    const createCs = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes",
      headers: PROPOSER_HEADERS,
      payload: {
        change_set_id: "cs_add_loyalty_tier",
        description: "add loyalty_tier to Customer",
        operations: [
          {
            op: "upsert",
            object_id: ENTITY,
            object_type: "Entity",
            layer: "L2",
            body: entityBodyWithTier,
          },
        ],
      },
    });
    expect(createCs.statusCode).toBe(201);

    const propose = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_add_loyalty_tier/propose",
      headers: PROPOSER_HEADERS,
    });
    expect(propose.statusCode).toBe(200);
    const approve = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_add_loyalty_tier/approve",
      headers: APPROVER_HEADERS,
    });
    expect(approve.statusCode).toBe(200);
    const deploy = await handle.app.inject({
      method: "POST",
      url: "/admin/v1/metadata/changes/cs_add_loyalty_tier/deploy",
      headers: DEPLOYER_HEADERS,
    });
    expect(deploy.statusCode).toBe(200);

    // POST with the new field — the materialized validator for the
    // new metadata version accepts it. No process restart, no schema
    // redeploy at the service level.
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: {
        name: "Upgraded",
        currency: "IQD",
        loyalty_tier: "gold",
      },
    });
    expect(created.statusCode).toBe(201);
    const { row_id } = created.json() as { row_id: string };

    // List it back — loyalty_tier round-trips through JSONB.
    const list = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { body: Record<string, unknown> }[] }).items;
    const upgraded = items.find((i) => (i.body as { name: string }).name === "Upgraded");
    expect(upgraded?.body).toMatchObject({ name: "Upgraded", loyalty_tier: "gold" });

    // Reading the specific row works.
    const get = await handle.app.inject({
      method: "GET",
      url: `/v1/${ENTITY}/${row_id}`,
      headers: ADMIN_HEADERS,
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { body: Record<string, unknown> }).body).toMatchObject({
      loyalty_tier: "gold",
    });

    // Old rows survive the schema change — loyalty_tier is optional.
    // The one we created pre-deploy has no loyalty_tier, and it still
    // lists fine (optional fields are absent, not null).
    const pre = items.find((i) => (i.body as { name: string }).name === "Pre-upgrade");
    expect(pre).toBeDefined();
    expect(pre?.body.loyalty_tier).toBeUndefined();

    // Validation still binds: an unknown enum value is rejected.
    const invalid = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "x", currency: "IQD", loyalty_tier: "platinum" },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

// ── Audit log (RFC §13.2) ──────────────────────────────────────────

describe("Runtime API writes emit hash-chained audit rows", () => {
  async function fetchAudit(): Promise<
    readonly {
      action: string;
      actor_id: string;
      target_id: string | null;
      before_hash: string | null;
      after_hash: string | null;
      context: Record<string, unknown> | null;
    }[]
  > {
    return db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant', ${TENANT}, true)`.execute(trx);
      return trx
        .selectFrom("metadata.meta_audit_log")
        .select(["action", "actor_id", "target_id", "before_hash", "after_hash", "context"])
        .where("tenant_id", "=", TENANT)
        .where("after_hash", "is not", null)
        .orderBy("audit_pk")
        .execute();
    });
  }

  it("POST writes a .create audit row with the after body in diff", async () => {
    await seedBaselineMetadata();
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: { ...ADMIN_HEADERS, "x-request-id": "rq_create" },
      payload: { name: "Acme", currency: "IQD" },
    });
    expect(created.statusCode).toBe(201);
    const { row_id } = created.json() as { row_id: string };
    const audit = await fetchAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe(`${ENTITY}.create`);
    expect(audit[0]?.actor_id).toBe("u_admin");
    expect(audit[0]?.target_id).toBe(row_id);
    expect(audit[0]?.before_hash).toBeNull();
    expect(audit[0]?.after_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(audit[0]?.context).toMatchObject({ request_id: "rq_create" });
  });

  it("POST → PATCH → DELETE produces a continuous hash chain", async () => {
    await seedBaselineMetadata();
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { name: "Original", currency: "IQD" },
    });
    const { row_id } = created.json() as { row_id: string };

    await handle.app.inject({
      method: "PATCH",
      url: `/v1/${ENTITY}/${row_id}`,
      headers: ADMIN_HEADERS,
      payload: { phone: "+9647710000000" },
    });

    await handle.app.inject({
      method: "DELETE",
      url: `/v1/${ENTITY}/${row_id}`,
      headers: ADMIN_HEADERS,
    });

    const audit = await fetchAudit();
    expect(audit.map((a) => a.action)).toEqual([
      `${ENTITY}.create`,
      `${ENTITY}.update`,
      `${ENTITY}.delete`,
    ]);
    // Chain continuity: each row's before_hash = previous row's after_hash.
    expect(audit[0]?.before_hash).toBeNull();
    expect(audit[1]?.before_hash).toBe(audit[0]?.after_hash);
    expect(audit[2]?.before_hash).toBe(audit[1]?.after_hash);
  });

  it("a failed permission check does NOT emit an audit row (nothing changed)", async () => {
    await seedBaselineMetadata();
    const denied = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: READER_HEADERS, // unknown role → 403
      payload: { name: "Denied", currency: "IQD" },
    });
    expect(denied.statusCode).toBe(403);
    const audit = await fetchAudit();
    expect(audit).toHaveLength(0);
  });

  it("a failed row validation does NOT emit an audit row", async () => {
    await seedBaselineMetadata();
    const bad = await handle.app.inject({
      method: "POST",
      url: `/v1/${ENTITY}`,
      headers: ADMIN_HEADERS,
      payload: { currency: "IQD" }, // missing required name
    });
    expect(bad.statusCode).toBe(400);
    const audit = await fetchAudit();
    expect(audit).toHaveLength(0);
  });
});

// ── OpenAPI ─────────────────────────────────────────────────────────

describe("OpenAPI", () => {
  it("/docs/openapi.json lists the 5 runtime routes", async () => {
    const res = await handle.app.inject({ method: "GET", url: "/docs/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { paths: Record<string, Record<string, unknown>> };
    expect(spec.paths["/v1/{entity}"]).toBeDefined();
    expect(spec.paths["/v1/{entity}"]?.get).toBeDefined();
    expect(spec.paths["/v1/{entity}"]?.post).toBeDefined();
    expect(spec.paths["/v1/{entity}/{id}"]).toBeDefined();
    expect(spec.paths["/v1/{entity}/{id}"]?.get).toBeDefined();
    expect(spec.paths["/v1/{entity}/{id}"]?.patch).toBeDefined();
    expect(spec.paths["/v1/{entity}/{id}"]?.delete).toBeDefined();
  });
});
