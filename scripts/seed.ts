/**
 * scripts/seed.ts — reference-tenant seeder for `t_demo_retail` (TASK-13).
 *
 * Three phases, each idempotent:
 *
 *   1. Vendor metadata (L0). A `cs_seed_platform_v1` marker row in
 *      meta_change_set signals "already done". On rerun, the phase
 *      short-circuits and leaves every L0 row untouched.
 *
 *   2. Tenant metadata (L2) for t_demo_retail: Customer gets a
 *      `loyalty_tier` enum added at the tenant layer. A
 *      `cs_seed_demo_retail_v1` marker row signals "already done".
 *      Also inserts the L0/L2 layer activations.
 *
 *   3. Demo rows — 50 Customers, 50 Products, 50 Invoices. Row ids
 *      are deterministic uuidv5-shaped hashes so ON CONFLICT DO
 *      NOTHING collapses duplicates at the UNIQUE(tenant, entity,
 *      row_id). A second run logs "already seeded" and inserts zero
 *      rows.
 *
 * Runs against the DATABASE_URL. Assumes migrations are already
 * applied — run `pnpm db:migrate` first.
 *
 * Usage:
 *   pnpm db:seed
 *   pnpm db:seed -- --force-rows  # re-insert row fixtures (still
 *                                   idempotent via deterministic ids)
 */

import { createAuth, seedUser } from "@erp/auth";
import { createDatabase, type Database } from "@erp/db";
import { createLogger } from "@erp/telemetry";
import { sql, type Kysely } from "kysely";

import {
  ADMIN_PERMISSION_L0,
  CUSTOMER_ENTITY_L0,
  CUSTOMER_ENTITY_L2_WITH_LOYALTY,
  INVOICE_ENTITY_L0,
  OBJECT_IDS,
  PRODUCT_ENTITY_L0,
  TENANT_CHANGE_SET_ID,
  TENANT_ID,
  VENDOR_CHANGE_SET_ID,
  VIEWER_PERMISSION_L0,
  generateCustomers,
  generateInvoices,
  generateProducts,
} from "./seed/fixtures.js";

// ── Types ──────────────────────────────────────────────────────────

interface VendorMetaInsert {
  readonly object_id: string;
  readonly object_type: "Entity" | "Permission";
  readonly body: Record<string, unknown>;
}

interface SeedStats {
  readonly vendorObjectsInserted: number;
  readonly vendorObjectsSkipped: boolean;
  readonly tenantObjectsInserted: number;
  readonly tenantObjectsSkipped: boolean;
  readonly customersInserted: number;
  readonly productsInserted: number;
  readonly invoicesInserted: number;
  readonly demoUserCreated: boolean;
}

export const DEMO_USER = {
  email: "demo@erp.local",
  password: "erp-demo-pass-2026!",
  name: "Demo User",
  tenantId: "t_demo_retail",
  roles: ["prm.admin"] as readonly string[],
} as const;

// ── Entrypoint ─────────────────────────────────────────────────────
// Top-level reads DATABASE_URL lazily inside main() so this module can
// be imported by tests without triggering process.exit.

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    // eslint-disable-next-line no-console
    console.error(
      "db-seed: DATABASE_URL is required. Copy .env.example to .env and fill it in, " +
        "or export the variable before running.",
    );
    process.exit(2);
  }

  const logger = createLogger({ service: "db-seed", pretty: true });
  const db = createDatabase({
    connectionString: databaseUrl,
    applicationName: "db-seed",
    max: 4,
  });

  try {
    const stats = await runSeed(db, logger);
    logger.info(stats, "db-seed: done");
  } finally {
    await db.destroy();
  }
}

// ── Core runner (exported for tests) ───────────────────────────────

export async function runSeed(
  db: Kysely<Database>,
  logger: {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    warn: (obj: Record<string, unknown>, msg?: string) => void;
  },
): Promise<SeedStats> {
  const vendor = await seedVendorMetadata(db, logger);
  const tenant = await seedTenantMetadata(db, logger);
  const rows = await seedRows(db, logger);
  const demo = await seedDemoUser(db, logger);

  return {
    vendorObjectsInserted: vendor.inserted,
    vendorObjectsSkipped: vendor.skipped,
    tenantObjectsInserted: tenant.inserted,
    tenantObjectsSkipped: tenant.skipped,
    customersInserted: rows.customers,
    productsInserted: rows.products,
    invoicesInserted: rows.invoices,
    demoUserCreated: demo.created,
  };
}

// ── Phase 4 · demo Better Auth user ────────────────────────────────
// Provisions a demo user the console login form (TASK-10.1b.2)
// accepts. The user joins t_demo_retail with prm.admin so it
// immediately has grants on all seeded entities. Idempotent — a
// second `pnpm db:seed` returns `created: false` and leaves the
// existing password untouched.

async function seedDemoUser(
  db: Kysely<Database>,
  logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">,
): Promise<{ created: boolean }> {
  const auth = createAuth({ db, isProduction: false });
  const result = await seedUser({
    auth,
    db,
    email: DEMO_USER.email,
    password: DEMO_USER.password,
    name: DEMO_USER.name,
    tenantId: DEMO_USER.tenantId,
    roles: DEMO_USER.roles,
  });
  logger.info(
    {
      email: DEMO_USER.email,
      tenant: DEMO_USER.tenantId,
      user_id: result.userId,
      created: result.created,
    },
    result.created
      ? "db-seed: demo user provisioned"
      : "db-seed: demo user already exists — skipping",
  );
  return { created: result.created };
}

// ── Phase 1 · vendor metadata (L0) ─────────────────────────────────

async function seedVendorMetadata(
  db: Kysely<Database>,
  logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">,
): Promise<{ inserted: number; skipped: boolean }> {
  const existing = await db
    .selectFrom("metadata.meta_change_set")
    .select("change_set_id")
    .where("change_set_id", "=", VENDOR_CHANGE_SET_ID)
    .executeTakeFirst();
  if (existing !== undefined) {
    logger.info(
      { change_set_id: VENDOR_CHANGE_SET_ID },
      "vendor L0 seed: already present — skipping",
    );
    return { inserted: 0, skipped: true };
  }

  const objects: VendorMetaInsert[] = [
    { object_id: OBJECT_IDS.customer, object_type: "Entity", body: CUSTOMER_ENTITY_L0 },
    { object_id: OBJECT_IDS.product, object_type: "Entity", body: PRODUCT_ENTITY_L0 },
    { object_id: OBJECT_IDS.invoice, object_type: "Entity", body: INVOICE_ENTITY_L0 },
    { object_id: OBJECT_IDS.admin, object_type: "Permission", body: ADMIN_PERMISSION_L0 },
    { object_id: OBJECT_IDS.viewer, object_type: "Permission", body: VIEWER_PERMISSION_L0 },
  ];

  // Vendor L0 rows are tenant_id=NULL, so RLS doesn't apply when we
  // insert them as the pool's default role (the `erp` superuser in
  // dev, the pool's app role in prod — both bypass policy on NULL-
  // tenant rows per metadata.meta_object's RLS policy).
  await db.transaction().execute(async (trx) => {
    // The marker change_set first — tenant_id can be any valid id for
    // meta_change_set's RLS `tenant_id = current_setting(...)` check.
    // We set the GUC explicitly so the INSERT passes.
    await sql`SELECT set_config('app.current_tenant', 'vendor_seed', true)`.execute(trx);
    await trx
      .insertInto("metadata.meta_change_set")
      .values({
        change_set_id: VENDOR_CHANGE_SET_ID,
        tenant_id: "vendor_seed",
        status: "deployed",
        description:
          "Seeded vendor metadata: ent.customer, ent.product, ent.invoice, prm.admin, prm.viewer",
        created_by: "scripts/seed.ts",
        approved_by: "scripts/seed.ts",
        approved_at: new Date(),
        deployed_at: new Date(),
      })
      .execute();

    for (const obj of objects) {
      await trx
        .insertInto("metadata.meta_object")
        .values({
          object_id: obj.object_id,
          object_type: obj.object_type,
          layer: "L0",
          tenant_id: null,
          template_id: null,
          version: 1,
          operation: "upsert",
          body: JSON.stringify(obj.body),
          created_by: "scripts/seed.ts",
          created_via: "db-seed",
          change_set_id: VENDOR_CHANGE_SET_ID,
        })
        .execute();
    }
  });

  logger.info(
    { change_set_id: VENDOR_CHANGE_SET_ID, count: objects.length },
    "vendor L0 seed: inserted",
  );
  return { inserted: objects.length, skipped: false };
}

// ── Phase 2 · tenant metadata (L2) ─────────────────────────────────

async function seedTenantMetadata(
  db: Kysely<Database>,
  logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">,
): Promise<{ inserted: number; skipped: boolean }> {
  const existing = await db
    .selectFrom("metadata.meta_change_set")
    .select("change_set_id")
    .where("change_set_id", "=", TENANT_CHANGE_SET_ID)
    .executeTakeFirst();
  if (existing !== undefined) {
    logger.info(
      { change_set_id: TENANT_CHANGE_SET_ID },
      "tenant L2 seed: already present — skipping",
    );
    return { inserted: 0, skipped: true };
  }

  await db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_tenant', ${TENANT_ID}, true)`.execute(trx);

    // L0/L2 layer activations so the resolver walks them for this
    // tenant. Default active layers are ["L0", "L2"] in the current
    // MetadataObjectRepository, so these rows are redundant today —
    // but they document the tenant's posture in meta_layer_activation
    // for when a future release reads from the DB instead of
    // hardcoding the default.
    await trx
      .insertInto("metadata.meta_layer_activation")
      .values([
        {
          tenant_id: TENANT_ID,
          layer: "L0",
          source_id: "platform",
          version: "0.0.0-phase1",
          activated_by: "scripts/seed.ts",
        },
        {
          tenant_id: TENANT_ID,
          layer: "L2",
          source_id: TENANT_ID,
          version: "0.0.0-phase1",
          activated_by: "scripts/seed.ts",
        },
      ])
      .onConflict((c) => c.columns(["tenant_id", "layer"]).doNothing())
      .execute();

    await trx
      .insertInto("metadata.meta_change_set")
      .values({
        change_set_id: TENANT_CHANGE_SET_ID,
        tenant_id: TENANT_ID,
        status: "deployed",
        description: "Seeded L2 overlay: loyalty_tier added to Customer",
        created_by: "scripts/seed.ts",
        approved_by: "scripts/seed.ts",
        approved_at: new Date(),
        deployed_at: new Date(),
      })
      .execute();

    await trx
      .insertInto("metadata.meta_object")
      .values({
        object_id: OBJECT_IDS.customer,
        object_type: "Entity",
        layer: "L2",
        tenant_id: TENANT_ID,
        template_id: null,
        version: 1,
        operation: "upsert",
        body: JSON.stringify(CUSTOMER_ENTITY_L2_WITH_LOYALTY),
        created_by: "scripts/seed.ts",
        created_via: "db-seed",
        change_set_id: TENANT_CHANGE_SET_ID,
      })
      .execute();
  });

  logger.info(
    { tenant_id: TENANT_ID, change_set_id: TENANT_CHANGE_SET_ID },
    "tenant L2 seed: inserted",
  );
  return { inserted: 1, skipped: false };
}

// ── Phase 3 · demo rows ────────────────────────────────────────────

interface RowSeedOutcome {
  readonly customers: number;
  readonly products: number;
  readonly invoices: number;
}

async function seedRows(
  db: Kysely<Database>,
  logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">,
): Promise<RowSeedOutcome> {
  const customers = await seedOneEntity(db, logger, OBJECT_IDS.customer, generateCustomers(50));
  const products = await seedOneEntity(db, logger, OBJECT_IDS.product, generateProducts(50));

  // Invoices need customer row_ids to reference. Pull the 50 we just
  // inserted (or the ones already there from a prior run). We SET
  // the tenant GUC so RLS lets the SELECT through.
  const customerRowIds = await db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_tenant', ${TENANT_ID}, true)`.execute(trx);
    const rs = await trx
      .selectFrom("ops.entity_row")
      .select("row_id")
      .where("tenant_id", "=", TENANT_ID)
      .where("entity_id", "=", OBJECT_IDS.customer)
      .where("deleted_at", "is", null)
      .orderBy("row_pk")
      .limit(50)
      .execute();
    return rs.map((r) => r.row_id);
  });

  const invoices = await seedOneEntity(
    db,
    logger,
    OBJECT_IDS.invoice,
    generateInvoices(50, customerRowIds),
  );

  return { customers, products, invoices };
}

async function seedOneEntity(
  db: Kysely<Database>,
  logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">,
  entityId: string,
  rows: readonly { row_id: string; body: Record<string, unknown>; status: string }[],
): Promise<number> {
  // Idempotency: if we already have >= rows.length non-deleted rows
  // for this (tenant, entity), skip. The seed script isn't meant to
  // top-up; a `--reset` workflow would truncate first.
  // ops.entity_row has FORCE ROW LEVEL SECURITY, so the count must
  // run with the tenant GUC set or the RLS policy drops every row.
  const existing = await db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_tenant', ${TENANT_ID}, true)`.execute(trx);
    const row = await trx
      .selectFrom("ops.entity_row")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("tenant_id", "=", TENANT_ID)
      .where("entity_id", "=", entityId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  });
  if (existing >= rows.length) {
    logger.info(
      { tenant_id: TENANT_ID, entity_id: entityId, existing },
      "rows: already at or above target — skipping",
    );
    return 0;
  }

  // Insert inside one transaction so a mid-batch failure rolls back.
  // INSERT ... ON CONFLICT DO NOTHING on the
  // (tenant_id, entity_id, row_id) UNIQUE collapses rerun duplicates
  // if deterministic row_ids collide with existing ones.
  let inserted = 0;
  await db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_tenant', ${TENANT_ID}, true)`.execute(trx);
    for (const row of rows) {
      const r = await trx
        .insertInto("ops.entity_row")
        .values({
          tenant_id: TENANT_ID,
          entity_id: entityId,
          row_id: row.row_id,
          body: JSON.stringify(row.body),
          status: row.status,
          created_by: "scripts/seed.ts",
          updated_by: "scripts/seed.ts",
        })
        .onConflict((c) => c.columns(["tenant_id", "entity_id", "row_id"]).doNothing())
        .executeTakeFirst();
      if (Number(r.numInsertedOrUpdatedRows ?? 0n) > 0) inserted += 1;
    }
  });
  logger.info(
    { tenant_id: TENANT_ID, entity_id: entityId, inserted, attempted: rows.length },
    "rows: inserted",
  );
  return inserted;
}

// ── CLI hook ───────────────────────────────────────────────────────

// Run main() only when invoked as a script (not when imported by a test).
const invokedAsScript = Boolean(
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")),
);
if (invokedAsScript) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("db-seed: unexpected error", err);
    process.exit(2);
  });
}
