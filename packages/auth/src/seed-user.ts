// seedUser — idempotent provisioning of a demo/pilot user.
//
// scripts/seed.ts uses this to create the demo user that the
// console's login form accepts (TASK-10.1b.2). Any future
// provisioning script (tenant-admin bootstrap, tenant-invite email
// accept) should also use this rather than poking auth.user + auth.
// account directly — Better Auth owns the password hashing, id
// format, and account-providerId conventions.
//
// Idempotency: if a user with the given email already exists, returns
// the existing user's id without trying to re-sign-up. The caller
// provides the password; on re-run the password is NOT reset
// (would invalidate sessions mid-pilot).

import { UserTenantRepository, type Database } from "@erp/db";
import { type Kysely } from "kysely";

import { type AuthInstance } from "./create-auth.js";

export interface SeedUserInput {
  readonly auth: AuthInstance;
  readonly db: Kysely<Database>;
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

export interface SeedUserResult {
  readonly userId: string;
  readonly created: boolean;
}

export async function seedUser(input: SeedUserInput): Promise<SeedUserResult> {
  const { auth, db, email, password, name, tenantId, roles } = input;

  // Check by email. Better Auth's `auth.user.email` column is UNIQUE.
  const existing = await db
    .selectFrom("auth.user")
    .select(["id"])
    .where("email", "=", email)
    .executeTakeFirst();

  let userId: string;
  let created: boolean;

  if (existing === undefined) {
    // auth.api.signUpEmail creates auth.user + auth.account rows.
    // We pass the password through — BA hashes it via scrypt under
    // the library's own recipe (constant-time, safe against
    // rainbow-table lookups).
    const res = await auth.api.signUpEmail({
      body: { email, password, name },
    });
    userId = res.user.id;
    created = true;
  } else {
    userId = existing.id;
    created = false;
  }

  // Attach to the tenant with the requested roles. The repo's
  // add() upserts, so repeating is safe.
  const repo = new UserTenantRepository(db);
  await repo.add({
    user_id: userId,
    tenant_id: tenantId,
    roles,
  });

  return { userId, created };
}
