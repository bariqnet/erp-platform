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

import { randomUUID } from "node:crypto";

import {
  Result,
  findLifecycleTransition,
  type DomainEvent,
  type GrantAction,
  type LifecycleTransition,
  type MetadataStore,
  type Result as ResultT,
} from "@erp/core";
import { withTenantContext } from "@erp/db";
import { materialize } from "@erp/kernel-runtime";
import { resolve as resolveMetadata } from "@erp/metadata";

import type { Denied, PermissionGate } from "./permission-gate.js";
import type {
  AuditRepository,
  Database,
  EntityRow,
  EntityRowRepository,
  ListEntityRowsParams,
  MetadataObjectRepository,
} from "@erp/db";
import type { OutboxBus } from "@erp/events";
import type { MaterializedEntity, MaterializedEntityCache } from "@erp/kernel-runtime";
import type { Kysely, Transaction } from "kysely";

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

/**
 * TASK-15 · POST /v1/:entity/:id/actions/:action input. The service
 * resolves the transition by `action` name, verifies the row is in
 * the required `from` state, applies the new `status`, writes an
 * audit row, and publishes a `runtime.<entity_id>.<action>` event
 * atomically with the row update.
 */
export interface InvokeActionInput extends CallerContext {
  readonly entityId: string;
  readonly rowId: string;
  readonly action: string;
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
  | { readonly kind: "row_not_found"; readonly entity_id: string; readonly row_id: string }
  | {
      /**
       * TASK-15 — the caller attempted to change `status` to a value
       * not reachable from the current state via a declared
       * transition. The route maps this to HTTP 409.
       */
      readonly kind: "invalid_transition";
      readonly entity_id: string;
      readonly row_id: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      /**
       * TASK-15 — the caller POSTed to /actions/:action for an action
       * not declared on the entity's lifecycle, or declared but not
       * legal from the row's current state.
       */
      readonly kind: "unknown_action";
      readonly entity_id: string;
      readonly row_id: string;
      readonly action: string;
      readonly current_state: string | null;
    };

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
    /**
     * TASK-15 — outbox bus for runtime events. Absent in server.ts's
     * legacy test wirings; the action endpoint and transition
     * PATCHes skip event emission when this is undefined. Production
     * always wires it.
     */
    private readonly bus?: OutboxBus,
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

    // TASK-15 · `status` is a row-level column (not a declared
    // Field), so we strip it out of the body before the materialized
    // field validator runs. The lifecycle check below consumes the
    // stripped value. Any other unknown key still trips the strict
    // validator.
    const rawBody = { ...input.body };
    const statusFromCaller: unknown = rawBody.status;
    const callerTouchedStatus = Object.prototype.hasOwnProperty.call(rawBody, "status");
    delete rawBody.status;

    const parsed = mat.patchValidator.safeParse(rawBody);
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

      // TASK-15 — enforce lifecycle transitions. Three cases:
      //   (a) the PATCH body includes `status` and it differs from
      //       the row's current status — must match a declared
      //       transition; otherwise 409 invalid_transition.
      //   (b) the PATCH body includes `status` equal to the current
      //       state — allowed (no-op on status; body may carry other
      //       field updates).
      //   (c) the PATCH doesn't touch status — no transition check.
      let statusAfter: string | null = existing.status;
      let transition: LifecycleTransition | null = null;
      if (callerTouchedStatus) {
        if (typeof statusFromCaller !== "string") {
          return Result.err({
            kind: "invalid_transition",
            entity_id: input.entityId,
            row_id: input.rowId,
            from: existing.status ?? "",
            to: String(statusFromCaller ?? ""),
          });
        }
        if (statusFromCaller !== existing.status) {
          const lc = mat.entity.lifecycle;
          const currentState = existing.status ?? "";
          if (lc === undefined) {
            // No lifecycle declared — any status change is allowed.
            statusAfter = statusFromCaller;
          } else {
            const match = findLifecycleTransition(lc, currentState, { toState: statusFromCaller });
            if (match === null) {
              return Result.err({
                kind: "invalid_transition",
                entity_id: input.entityId,
                row_id: input.rowId,
                from: currentState,
                to: statusFromCaller,
              });
            }
            statusAfter = statusFromCaller;
            transition = match;
          }
        }
      }

      const patched = await this.rowRepo.patchInTx(
        trx,
        input.tenantId,
        input.entityId,
        input.rowId,
        {
          body: mergedBody,
          updated_by: input.userId,
          ...(statusAfter !== existing.status ? { status: statusAfter } : {}),
        },
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

      // When a PATCH completed a legal transition, emit the same
      // runtime event the /actions endpoint produces — downstream
      // workflow listeners don't care which surface triggered the
      // transition.
      if (transition !== null && transition.action !== undefined) {
        await this.emitRuntimeEventInTx(trx, input, transition);
      }
      return Result.ok(patched);
    });
  }

  /**
   * TASK-15 · named-action endpoint handler.
   *
   * Looks up the action on the entity's lifecycle transitions,
   * verifies the row is in the expected `from` state, applies the
   * `to` state (status column update), writes an audit row, and
   * publishes a `runtime.<entity_id>.<action>` event — all inside a
   * single transaction so partial failures can't leak.
   *
   * The permission action is "update" (not a bespoke "invoke" action
   * for now) — lifecycle transitions are a write, so a caller with
   * update on the entity can drive them. Field-level action guards
   * are a Phase-2 follow-up (TASK-22).
   */
  async invokeAction(input: InvokeActionInput): Promise<ResultT<EntityRow, RuntimeError>> {
    const gate = await this.assertAllowed(input, input.entityId, "update");
    if (Result.isErr(gate)) return gate;
    const matResult = await this.resolveMat(input.tenantId, input.entityId);
    if (Result.isErr(matResult)) return matResult;
    const mat = matResult.value;

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

      const lc = mat.entity.lifecycle;
      if (lc === undefined) {
        return Result.err({
          kind: "unknown_action",
          entity_id: input.entityId,
          row_id: input.rowId,
          action: input.action,
          current_state: existing.status,
        });
      }

      const currentState = existing.status ?? "";
      const transition = findLifecycleTransition(lc, currentState, {
        action: input.action,
      });
      if (transition === null) {
        return Result.err({
          kind: "unknown_action",
          entity_id: input.entityId,
          row_id: input.rowId,
          action: input.action,
          current_state: existing.status,
        });
      }

      const patched = await this.rowRepo.patchInTx(
        trx,
        input.tenantId,
        input.entityId,
        input.rowId,
        {
          status: transition.to,
          updated_by: input.userId,
        },
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
        action: `${input.entityId}.${input.action}`,
        target_type: "entity_row",
        target_id: patched.row_id,
        diff: {
          before: { status: existing.status },
          after: { status: patched.status },
        },
        ...(context !== undefined ? { context } : {}),
      });

      await this.emitRuntimeEventInTx(trx, input, transition);
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

  /**
   * TASK-15 · emit `runtime.<entity_id>.<action>` on the outbox
   * inside the caller's transaction. Atomic with the row update +
   * audit row; if the INSERT fails, the whole action rolls back.
   *
   * No-ops when the service was constructed without a bus (legacy
   * unit-test wiring). The entity_id is normalized to lowercase + a
   * single dot separator to match the DomainEvent regex
   * `<segment>.<segment>[.<segment>…]`.
   */
  private async emitRuntimeEventInTx(
    trx: Transaction<Database>,
    input: CallerContext & { readonly entityId: string; readonly rowId: string },
    transition: LifecycleTransition,
  ): Promise<void> {
    if (this.bus === undefined) return;
    if (transition.action === undefined) return; // No action = no event.

    // ent.customer → runtime.ent_customer.activate (segments must be
    // lowercase alnum+underscore per DomainEvent regex).
    const entitySlug = input.entityId.replace(/\./g, "_").toLowerCase();
    const eventType = `runtime.${entitySlug}.${transition.action.toLowerCase()}`;

    const event: DomainEvent<{
      entity_id: string;
      row_id: string;
      action: string;
      from: string;
      to: string;
    }> = {
      event_id: randomUUID(),
      event_type: eventType,
      event_version: 1,
      occurred_at: new Date().toISOString(),
      tenant_id: input.tenantId,
      actor_id: input.userId,
      ...(input.requestId !== undefined &&
      input.requestId !== "" &&
      input.traceId !== undefined &&
      input.traceId !== ""
        ? {
            trace: {
              trace_id: input.traceId,
              span_id: input.requestId.replace(/-/g, "").slice(0, 16),
              trace_flags: "01",
            },
          }
        : {}),
      payload: {
        entity_id: input.entityId,
        row_id: input.rowId,
        action: transition.action,
        from: transition.from,
        to: transition.to,
      },
    };

    await this.bus.publishWithin(trx, event);
  }

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
