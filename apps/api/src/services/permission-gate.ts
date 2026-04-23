// PermissionGate — evaluate RFC §13.1's per-operation authorization.
//
// Order per RFC §13.1:
//   1. Role-based entity-level grants   — this task (TASK-12)
//   2. Field-level grants                — deferred
//   3. Record-level predicates           — deferred
//   4. Delegated permissions             — deferred
//   5. Implicit owner-of-record grants   — deferred
//
// Phase 1 contract:
//   - The caller supplies userRoles (from x-user-roles) + entityId + action.
//   - We resolve every `prm.*` metadata object for the tenant via the
//     MetadataStore (MetadataObjectRepository implements it).
//   - A permission matches when its role_id is in the caller's
//     userRoles. `inherits_from` is walked recursively (cycle-safe).
//   - If any matched permission's entity_grants[entityId] contains the
//     action, the operation is allowed.
//   - If no match allows, the operation is denied.
//
// Deny-by-default: a tenant with no `prm.*` objects at all sees every
// request rejected. That's the RFC's intent — callers must explicitly
// grant.
//
// Returns a `Result<Allowed, Denied>` — the route handler maps Denied
// to 403 problem+json.

import {
  PermissionBodySchema,
  Result,
  type GrantAction,
  type MetadataStore,
  type PermissionBody,
  type Result as ResultT,
} from "@erp/core";
import { resolve as resolveMetadata } from "@erp/metadata";

export interface PermissionGateInput {
  readonly tenantId: string;
  readonly userRoles: readonly string[];
  readonly entityId: string;
  readonly action: GrantAction;
}

export interface Allowed {
  readonly ok: true;
}

export interface Denied {
  readonly kind: "forbidden";
  /** Short machine-readable reason, surfaced in the problem+json `detail`. */
  readonly reason: "no_permissions_configured" | "no_matching_role" | "action_not_granted";
}

export class PermissionGate {
  constructor(
    private readonly store: MetadataStore,
    /**
     * How to enumerate the tenant's `prm.*` object ids. Kept as a
     * dependency so tests can pass an in-memory list and production
     * can wire it to MetadataObjectRepository.listObjectIds (added
     * alongside the gate in this task).
     */
    private readonly listPermissionIds: (tenantId: string) => Promise<readonly string[]>,
  ) {}

  async check(input: PermissionGateInput): Promise<ResultT<Allowed, Denied>> {
    const ids = await this.listPermissionIds(input.tenantId);
    if (ids.length === 0) {
      return Result.err({ kind: "forbidden", reason: "no_permissions_configured" });
    }

    // Resolve each `prm.*` for the tenant. We deliberately walk them
    // all — the number of permission objects per tenant is small
    // (hundreds max, RFC §12.2 capacity assumption); caching lands
    // when the PermissionGate's own hot-path profile justifies it.
    const permissions: PermissionBody[] = [];
    for (const id of ids) {
      const r = await resolveMetadata({ tenant_id: input.tenantId, object_id: id }, this.store);
      if (Result.isErr(r)) continue;
      const parsed = PermissionBodySchema.safeParse(r.value.body);
      if (parsed.success) permissions.push(parsed.data);
    }

    // Index by role_id for inheritance traversal.
    const byRole = new Map<string, PermissionBody>();
    for (const p of permissions) byRole.set(p.role_id, p);

    // Walk the user's roles; for each role, check its matching
    // permission plus any inherited ones. Short-circuit on the first
    // grant.
    let matchedAnyRole = false;
    const seen = new Set<string>();
    for (const role of input.userRoles) {
      const start = byRole.get(role);
      if (start === undefined) continue;
      matchedAnyRole = true;

      const stack: PermissionBody[] = [start];
      while (stack.length > 0) {
        const p = stack.pop();
        if (p === undefined || seen.has(p.role_id)) continue;
        seen.add(p.role_id);

        if (grants(p, input.entityId, input.action)) {
          return Result.ok({ ok: true } as const);
        }

        if (p.inherits_from !== undefined) {
          for (const parentRoleId of p.inherits_from) {
            const parent = byRole.get(parentRoleId);
            if (parent !== undefined && !seen.has(parentRoleId)) {
              stack.push(parent);
            }
          }
        }
      }
    }

    if (!matchedAnyRole) {
      return Result.err({ kind: "forbidden", reason: "no_matching_role" });
    }
    return Result.err({ kind: "forbidden", reason: "action_not_granted" });
  }
}

function grants(p: PermissionBody, entityId: string, action: GrantAction): boolean {
  const actions = p.entity_grants?.[entityId];
  return actions !== undefined && actions.includes(action);
}
