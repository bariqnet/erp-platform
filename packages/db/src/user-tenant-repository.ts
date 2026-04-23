// UserTenantRepository — reads the multi-tenant authorization mapping
// from metadata.user_tenant. Used by apps/api's auth plugin to
// discover which tenants a signed-in user belongs to and what roles
// they carry in each.
//
// Tenant-scoped reads (filtering to a specific tenant) go through the
// standard tenant context — the RLS policy on user_tenant matches
// app.current_tenant. Vendor-level reads (listing every tenant a user
// belongs to across the platform, which login does) use runAsVendor
// because the caller doesn't yet know which tenant to pin.

import { type Kysely } from "kysely";

import { type Database } from "./schema.js";
import { TenantRepository } from "./tenant-repository.js";

export interface UserTenantRow {
  readonly user_id: string;
  readonly tenant_id: string;
  readonly roles: readonly string[];
  readonly created_at: string;
}

export interface AddUserTenantInput {
  readonly user_id: string;
  readonly tenant_id: string;
  readonly roles: readonly string[];
}

export class UserTenantRepository extends TenantRepository {
  public constructor(db: Kysely<Database>) {
    super(db);
  }

  /**
   * Auth-plane read: list every tenant a user belongs to. Vendor-role
   * query — the login path calls this before a tenant has been
   * selected, so there's no `app.current_tenant` to scope against.
   */
  async listForUser(userId: string): Promise<readonly UserTenantRow[]> {
    return this.runAsVendor(async (trx) => {
      const rows = await trx
        .selectFrom("metadata.user_tenant")
        .select(["user_id", "tenant_id", "roles", "created_at"])
        .where("user_id", "=", userId)
        .orderBy("created_at", "asc")
        .execute();
      return rows.map((r) => ({
        user_id: r.user_id,
        tenant_id: r.tenant_id,
        roles: r.roles,
        created_at: r.created_at.toISOString(),
      }));
    });
  }

  /**
   * Tenant-plane read: fetch a single (user, tenant) row under the
   * tenant's RLS scope. Returns null when the user doesn't belong to
   * that tenant.
   */
  async getForTenant(tenantId: string, userId: string): Promise<UserTenantRow | null> {
    return this.runAsTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom("metadata.user_tenant")
        .select(["user_id", "tenant_id", "roles", "created_at"])
        .where("tenant_id", "=", tenantId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row
        ? {
            user_id: row.user_id,
            tenant_id: row.tenant_id,
            roles: row.roles,
            created_at: row.created_at.toISOString(),
          }
        : null;
    });
  }

  /**
   * Attach a user to a tenant with a role set. Vendor-level write —
   * the caller is an admin provisioning the mapping, so RLS is
   * bypassed. `on conflict do update` lets this serve as an upsert.
   */
  async add(input: AddUserTenantInput): Promise<UserTenantRow> {
    return this.runAsVendor(async (trx) => {
      const row = await trx
        .insertInto("metadata.user_tenant")
        .values({
          user_id: input.user_id,
          tenant_id: input.tenant_id,
          roles: JSON.stringify(input.roles),
        })
        .onConflict((c) =>
          c.columns(["user_id", "tenant_id"]).doUpdateSet({
            roles: JSON.stringify(input.roles),
          }),
        )
        .returning(["user_id", "tenant_id", "roles", "created_at"])
        .executeTakeFirstOrThrow();
      return {
        user_id: row.user_id,
        tenant_id: row.tenant_id,
        roles: row.roles,
        created_at: row.created_at.toISOString(),
      };
    });
  }

  async remove(tenantId: string, userId: string): Promise<boolean> {
    return this.runAsVendor(async (trx) => {
      const result = await trx
        .deleteFrom("metadata.user_tenant")
        .where("tenant_id", "=", tenantId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    });
  }
}
