// RuntimeEntityService — business logic behind the auto-derived
// Runtime API endpoints (RFC §9.2).
//
// One flow applies to every (entity, action) tuple:
//
//   1. PermissionGate.check — the caller's role must grant the action
//      on the entity (RFC §13.1 level 1). Denial → 403 problem+json.
//   2. resolve() the entity's metadata through the injected
//      MetadataStore. Miss → 404 `entity_not_deployed`.
//   3. materialize() the resolved body (cache by
//      (tenant, entity_id, version); RFC §5.3 version-keyed LRU).
//      Only `storage.strategy = "jsonb"` is supported in Phase 1
//      (CLAUDE.md §6). Native-column storage returns 501.
//   4. Validate the caller's body against the materialized Zod
//      schema. ZodError → 400 validation_error (converted by the
//      errors plugin).
//   5. Repository call (list | get | create | patch | softDelete) on
//      EntityRowRepository. Missing row → 404 row_not_found.
//
// Returns Result<Output, RuntimeError>; the route handler does
// Result.match → HTTP response. Business logic never throws for
// expected failures.

import { Result, type GrantAction, type MetadataStore, type Result as ResultT } from "@erp/core";
import { withTenantContext, type Database } from "@erp/db";
import { materialize } from "@erp/kernel-runtime";
import { resolve as resolveMetadata } from "@erp/metadata";

import type { Denied, PermissionGate } from "./permission-gate.js";
import type {
  AuditRepository,
  EntityRow,
  EntityRowRepository,
  ListEntityRowsParams,
  MetadataObjectRepository,
} from "@erp/db";
import type { MaterializedEntity, MaterializedEntityCache } from "@erp/kernel-runtime";
import type { Kysely } from "kysely";

// ── I/O types ────────────────────────────────────────────────────────

export interface CallerContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly userRoles: readonly string[];
  /** Optional request-scoped trace identifiers, carried into audit rows. */
  readonly requestId?: string;
  readonly traceId?: string;
}

export interface ListInput extends CallerContext {
  readonly entityId: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface GetInput extends CallerContext {
  readonly entityId: string;
  readonly rowId: string;
}

export interface CreateInput extends CallerContext {
  readonly entityId: string;
  readonly body: Record<string, unknown>;
}

export interface PatchInput extends CallerContext {
  readonly entityId: string;
  readonly rowId: string;
  readonly body: Record<string, unknown>;
}

export interface DeleteInput extends CallerContext {
  readonly entityId: string;
  readonly rowId: string;
}

export interface ListOutput {
  readonly items: readonly EntityRow[];
  readonly limit: number;
  readonly offset: number;
}

// ── Errors ───────────────────────────────────────────────────────────

export type RuntimeError =
  | Denied
  | { readonly kind: "entity_not_deployed"; readonly entity_id: string }
  | {
      readonly kind: "unsupported_storage_strategy";
      readonly entity_id: string;
      readonly strategy: string;
    }
  | {
      readonly kind: "validation_error";
      readonly issues: readonly { path: string; message: string }[];
    }
  | { readonly kind: "row_not_found"; readonly entity_id: string; readonly row_id: string };

// ── Service ──────────────────────────────────────────────────────────

export class RuntimeEntityService {
  constructor(
    // Reserved for future work (e.g. listActiveObjectIds + custom
    // entity enumeration for RFC §9.2's /v1 index endpoint). Kept in
    // the signature so callers don't need to rewire when that lands.
    _metadataRepo: MetadataObjectRepository,
    private readonly rowRepo: EntityRowRepository,
    private readonly auditRepo: AuditRepository,
    private readonly store: MetadataStore,
    private readonly gate: PermissionGate,
    private readonly cache: MaterializedEntityCache,
    private readonly db: Kysely<Database>,
  ) {
    void _metadataRepo;
  }

  async list(input: ListInput): Promise<ResultT<ListOutput, RuntimeError>> {
    const gate = await this.assertAllowed(input, input.entityId, "read");
    if (Result.isErr(gate)) return gate;
    const mat = await this.resolveMat(input.tenantId, input.entityId);
    if (Result.isErr(mat)) return mat;

    const listParams: ListEntityRowsParams = {
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    };
    const items = await this.rowRepo.list(input.tenantId, input.entityId, listParams);
    return Result.ok({
      items,
      limit: Math.min(input.limit ?? 50, 200),
      offset: Math.max(input.offset ?? 0, 0),
    });
  }

  async get(input: GetInput): Promise<ResultT<EntityRow, RuntimeError>> {
    const gate = await this.assertAllowed(input, input.entityId, "read");
    if (Result.isErr(gate)) return gate;
    const mat = await this.resolveMat(input.tenantId, input.entityId);
    if (Result.isErr(mat)) return mat;

    const row = await this.rowRepo.get(input.tenantId, input.entityId, input.rowId);
    if (row === null) {
      return Result.err({
        kind: "row_not_found",
        entity_id: input.entityId,
        row_id: input.rowId,
      });
    }
    return Result.ok(row);
  }

  async create(input: CreateInput): Promise<ResultT<EntityRow, RuntimeError>> {
    const gate = await this.assertAllowed(input, input.entityId, "create");
    if (Result.isErr(gate)) return gate;
    const matResult = await this.resolveMat(input.tenantId, input.entityId);
    if (Result.isErr(matResult)) return matResult;
    const mat = matResult.value;

    const parsed = mat.createValidator.safeParse(input.body);
    if (!parsed.success) {
      return Result.err({
        kind: "validation_error",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const status = mat.entity.lifecycle?.initial ?? null;
    // One transaction: the row INSERT and the hash-chained audit row
    // commit or roll back together. RFC §13.2: audit is atomic with
    // the data it describes.
    const created = await withTenantContext(this.db, input.tenantId, async (trx) => {
      const row = await this.rowRepo.createInTx(trx, input.tenantId, {
        entity_id: input.entityId,
        body: parsed.data,
        status,
        created_by: input.userId,
      });
      const context = auditContextOf(input);
      await this.auditRepo.appendInTx(trx, {
        tenant_id: input.tenantId,
        actor_id: input.userId,
        action: `${input.entityId}.create`,
        target_type: "entity_row",
        target_id: row.row_id,
        diff: { after: row.body },
        ...(context !== undefined ? { context } : {}),
      });
      return row;
    });
    return Result.ok(created);
  }

  async patch(input: PatchInput): Promise<ResultT<EntityRow, RuntimeError>> {
    const gate = await this.assertAllowed(input, input.entityId, "update");
    if (Result.isErr(gate)) return gate;
    const matResult = await this.resolveMat(input.tenantId, input.entityId);
    if (Result.isErr(matResult)) return matResult;
    const mat = matResult.value;

    const parsed = mat.patchValidator.safeParse(input.body);
    if (!parsed.success) {
      return Result.err({
        kind: "validation_error",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    // Merge into existing body so PATCH truly patches (replacing only
    // the keys the caller sent). The repository layer stores the merged
    // body wholesale — that's fine for JSONB and matches RFC semantics.
    // One transaction: get + patch + audit append all commit together.
    return withTenantContext(this.db, input.tenantId, async (trx) => {
      const existing = await trx
        .selectFrom("ops.entity_row")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("entity_id", "=", input.entityId)
        .where("row_id", "=", input.rowId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (existing === undefined) {
        return Result.err({
          kind: "row_not_found",
          entity_id: input.entityId,
          row_id: input.rowId,
        });
      }

      const mergedBody: Record<string, unknown> = {
        ...(existing.body as Record<string, unknown>),
        ...parsed.data,
      };
      const patched = await this.rowRepo.patchInTx(
        trx,
        input.tenantId,
        input.entityId,
        input.rowId,
        { body: mergedBody, updated_by: input.userId },
      );
      if (patched === null) {
        return Result.err({
          kind: "row_not_found",
          entity_id: input.entityId,
          row_id: input.rowId,
        });
      }
      const context = auditContextOf(input);
      await this.auditRepo.appendInTx(trx, {
        tenant_id: input.tenantId,
        actor_id: input.userId,
        action: `${input.entityId}.update`,
        target_type: "entity_row",
        target_id: patched.row_id,
        diff: {
          before: existing.body,
          after: patched.body,
          changed: Object.keys(parsed.data),
        },
        ...(context !== undefined ? { context } : {}),
      });
      return Result.ok(patched);
    });
  }

  async delete(input: DeleteInput): Promise<ResultT<{ readonly deleted: boolean }, RuntimeError>> {
    const gate = await this.assertAllowed(input, input.entityId, "delete");
    if (Result.isErr(gate)) return gate;
    // Resolve so an unknown entity returns 404 rather than a silent no-op.
    const mat = await this.resolveMat(input.tenantId, input.entityId);
    if (Result.isErr(mat)) return mat;

    return withTenantContext(this.db, input.tenantId, async (trx) => {
      const existing = await trx
        .selectFrom("ops.entity_row")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("entity_id", "=", input.entityId)
        .where("row_id", "=", input.rowId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (existing === undefined) {
        return Result.err({
          kind: "row_not_found",
          entity_id: input.entityId,
          row_id: input.rowId,
        });
      }

      const ok = await this.rowRepo.softDeleteInTx(
        trx,
        input.tenantId,
        input.entityId,
        input.rowId,
        input.userId,
      );
      if (!ok) {
        return Result.err({
          kind: "row_not_found",
          entity_id: input.entityId,
          row_id: input.rowId,
        });
      }
      const context = auditContextOf(input);
      await this.auditRepo.appendInTx(trx, {
        tenant_id: input.tenantId,
        actor_id: input.userId,
        action: `${input.entityId}.delete`,
        target_type: "entity_row",
        target_id: input.rowId,
        diff: { before: existing.body },
        ...(context !== undefined ? { context } : {}),
      });
      return Result.ok({ deleted: true });
    });
  }

  // ── helpers ────────────────────────────────────────────────────────

  private async assertAllowed(
    ctx: CallerContext,
    entityId: string,
    action: GrantAction,
  ): Promise<ResultT<true, RuntimeError>> {
    const r = await this.gate.check({
      tenantId: ctx.tenantId,
      userRoles: ctx.userRoles,
      entityId,
      action,
    });
    if (Result.isErr(r)) return Result.err(r.error);
    return Result.ok(true);
  }

  private async resolveMat(
    tenantId: string,
    entityId: string,
  ): Promise<ResultT<MaterializedEntity, RuntimeError>> {
    const resolved = await resolveMetadata(
      { tenant_id: tenantId, object_id: entityId },
      this.store,
    );
    if (Result.isErr(resolved)) {
      return Result.err({ kind: "entity_not_deployed", entity_id: entityId });
    }
    // Version-keyed cache: encode the *full* provenance stack, not
    // just the highest version. Reason: when a tenant adds an L2
    // override, the L2 row is v1 too — and so is the L0 — so
    // `max(version)` doesn't change. The number of provenance entries
    // and/or their layer labels do. Hashing the whole stack is the
    // cheap correct thing (CLAUDE.md §7 #6: cache keys are version-
    // keyed; new version = new key).
    const versionKey = provenanceVersionKey(resolved.value.provenance);
    const cached = this.cache.get(tenantId, entityId, versionKey);
    if (cached !== undefined) {
      const stratCheck = assertSupportedStrategy(cached);
      if (stratCheck !== null) return Result.err(stratCheck);
      return Result.ok(cached);
    }

    const mat = materialize(resolved.value);
    const stratCheck = assertSupportedStrategy(mat);
    if (stratCheck !== null) return Result.err(stratCheck);
    this.cache.set(tenantId, entityId, versionKey, mat);
    return Result.ok(mat);
  }
}

function auditContextOf(input: CallerContext): Record<string, unknown> | undefined {
  const ctx: Record<string, unknown> = {};
  if (input.requestId !== undefined && input.requestId !== "") ctx.request_id = input.requestId;
  if (input.traceId !== undefined && input.traceId !== "") ctx.trace_id = input.traceId;
  return Object.keys(ctx).length === 0 ? undefined : ctx;
}

function provenanceVersionKey(provenance: readonly { layer: string; version: number }[]): number {
  // Stable hash over layer+version pairs. djb2-style; the cache is
  // local + small so a cryptographic hash would be overkill. Two
  // distinct provenance lists produce distinct keys; identical lists
  // always produce the same key (determinism — RFC §3.6).
  let h = 5381;
  for (const p of provenance) {
    const token = `${p.layer}:${p.version}`;
    for (let i = 0; i < token.length; i += 1) {
      h = ((h << 5) + h + token.charCodeAt(i)) | 0;
    }
  }
  // MaterializedEntityCache keys its third slot as a number; use the
  // unsigned 32-bit hash.
  return h >>> 0;
}

function assertSupportedStrategy(mat: MaterializedEntity): RuntimeError | null {
  const strat = mat.entity.storage.strategy;
  if (strat === "jsonb" || strat === "hybrid") return null;
  return {
    kind: "unsupported_storage_strategy",
    entity_id: `ent.${mat.entity.name.toLowerCase()}`,
    strategy: strat,
  };
}
