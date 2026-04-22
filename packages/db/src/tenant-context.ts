// Tenant-context helper — sets `app.current_tenant` on a transaction so the
// RLS policies defined in 0001_metadata_schema.sql can evaluate it.
//
// CLAUDE.md §9 and RFC §10.1: every tenant-scoped query runs under a tenant
// context, or doesn't run at all. The `TenantRepository` base class (added
// when the first repository ships) calls `withTenantContext` on every
// method; direct `db.selectFrom(...)` against tenant tables is a bug.
//
// IMPORTANT: Postgres superusers bypass RLS unconditionally, even with
// FORCE ROW LEVEL SECURITY. In dev, the `erp` user created by POSTGRES_USER
// is a superuser. So `withTenantContext` always `SET LOCAL ROLE erp_app`
// first — `erp_app` is NOSUPERUSER NOBYPASSRLS (created by the 0001
// migration), so RLS fires. In production the connecting user IS `erp_app`,
// which means `SET LOCAL ROLE` to the same role is a no-op.

import { sql, type Kysely } from "kysely";

import type { Database } from "./schema.js";

/** Role the app assumes for tenant-scoped work. Created in migration 0001. */
export const APP_ROLE = "erp_app";

/**
 * Run `fn` inside a transaction whose `app.current_tenant` GUC is set to
 * `tenantId` and whose session role is demoted to `erp_app`. Both settings
 * are transaction-local (`SET LOCAL`), so they unwind on commit or abort.
 *
 * Empty-string `tenantId` is rejected — RLS policies treat an empty GUC the
 * same as an unset one, which would expose every tenant's rows.
 */
export async function withTenantContext<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new Error(
      "withTenantContext: tenantId must be a non-empty string. " +
        "Use the vendor-level API for tenant-agnostic operations.",
    );
  }
  return db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL ROLE ${APP_ROLE}`).execute(trx);
    await sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Vendor-level escape hatch — runs `fn` without setting a tenant context.
 * Only the L0 metadata layer, platform-wide audit queries, and the
 * migration runner should use this. Every caller must carry a
 * `// @vendor-repository` or equivalent justification.
 */
export async function withoutTenantContext<T>(
  db: Kysely<Database>,
  fn: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(fn);
}
