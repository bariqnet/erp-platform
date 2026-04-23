// TenantRepository — base class every tenant-scoped repository extends.
//
// CLAUDE.md §7 non-negotiable #4 and §9: every tenant-scoped query runs
// under a `TenantContext`. `withTenantContext` sets the session role to
// `erp_app` and the `app.current_tenant` GUC; RLS policies on
// meta_change_set / meta_object / meta_audit_log use that GUC to block
// cross-tenant reads and writes.
//
// scripts/verify.ts invariant #1 scans every class whose name ends in
// "Repository" and requires it to extend this class (or carry an
// explicit `// @vendor-repository` opt-out). The invariant is the reason
// this file is deliberately small — the safety guarantee lives in the
// lint pass, not in a complex runtime.

import { type Kysely, type Transaction } from "kysely";

import { withTenantContext, withoutTenantContext } from "./tenant-context.js";

import type { Database } from "./schema.js";

export abstract class TenantRepository {
  protected constructor(protected readonly db: Kysely<Database>) {}

  /**
   * Run `fn` inside a transaction that has the `erp_app` role assumed
   * and `app.current_tenant` set to `tenantId`. Use this for every
   * method that touches tenant-scoped tables.
   */
  protected runAsTenant<T>(
    tenantId: string,
    fn: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return withTenantContext(this.db, tenantId, fn);
  }

  /**
   * Escape hatch for vendor-level reads (L0/L1 metadata, platform audit
   * queries). Callers MUST carry a `// @vendor-repository` comment or
   * equivalent justification — scripts/verify.ts invariant #1 enforces
   * the convention at the class level.
   */
  protected runAsVendor<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return withoutTenantContext(this.db, fn);
  }
}
