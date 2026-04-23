// ChangeSetRepository — the data-layer side of the RFC §9.3 lifecycle.
//
// The pure state machine + operation schemas live in @erp/change-set;
// this class does the work that needs the database: persisting Change
// Sets, accumulating staged operations, materializing operations into
// meta_object rows on deploy (atomically), and reverting them on
// rollback (O(1) per operation per RFC §11.4).
//
// Every method opens a transaction via TenantRepository.runAsTenant —
// `SET LOCAL ROLE erp_app` and `app.current_tenant` are set, RLS
// policies fire. Writes to meta_audit_log are part of the same
// transaction as the data they audit. EventBus emission is deferred
// to the caller (the bus contract lives in @erp/core; the in-process
// + outbox adapter is TASK-08).

import { randomUUID } from "node:crypto";

import {
  buildChangeSetEvent,
  CHANGE_SET_EVENT_TYPES,
  OperationSchema,
  transition,
  type Action,
  type ChangeSetEventPayload,
  type Operation,
  type State,
  type TransitionActor,
  type TransitionError,
} from "@erp/change-set";
import { Result, type ChangeSetStatus, type DomainEvent, type Result as ResultT } from "@erp/core";
import { sql, type Kysely, type Transaction } from "kysely";

import { TenantRepository } from "./tenant-repository.js";

import type { Database } from "./schema.js";

// ── Inputs / outputs ───────────────────────────────────────────────────

export interface CreateChangeSetParams {
  readonly change_set_id: string;
  readonly description?: string;
  readonly created_by: string;
}

export interface AddOperationsParams {
  readonly change_set_id: string;
  readonly operations: readonly Operation[];
}

export interface TransitionInput {
  readonly change_set_id: string;
  readonly action: Action;
  readonly actor: TransitionActor;
}

export interface ChangeSetRow {
  readonly change_set_id: string;
  readonly tenant_id: string;
  readonly status: ChangeSetStatus;
  readonly description: string | null;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly approved_by: string | null;
  readonly approved_at: Date | null;
  readonly deployed_at: Date | null;
  readonly rolled_back_at: Date | null;
  readonly staged_operations: readonly Operation[];
}

export interface TransitionOutcome {
  readonly from_state: State;
  readonly to_state: State;
  readonly event: DomainEvent<ChangeSetEventPayload> | null;
  readonly operations_applied: number;
}

export type RepoError =
  | { readonly kind: "not_found"; readonly change_set_id: string }
  | {
      readonly kind: "invalid_state_for_operation";
      readonly change_set_id: string;
      readonly current: State;
      readonly required: State;
    }
  | { readonly kind: "transition_error"; readonly cause: TransitionError };

// ── ChangeSetRepository ───────────────────────────────────────────────

export class ChangeSetRepository extends TenantRepository {
  constructor(db: Kysely<Database>) {
    super(db);
  }

  /** Insert a new draft Change Set. */
  async create(tenantId: string, params: CreateChangeSetParams): Promise<void> {
    await this.runAsTenant(tenantId, async (trx) => {
      await trx
        .insertInto("metadata.meta_change_set")
        .values({
          change_set_id: params.change_set_id,
          tenant_id: tenantId,
          status: "draft",
          description: params.description ?? null,
          created_by: params.created_by,
          staged_operations: JSON.stringify([]),
        })
        .execute();

      await this.writeAudit(trx, {
        tenant_id: tenantId,
        actor_id: params.created_by,
        action: "change_set.created",
        change_set_id: params.change_set_id,
        diff: { description: params.description ?? null },
      });
    });
  }

  /** Append operations to a draft Change Set. Replaces, not merges. */
  async addOperations(
    tenantId: string,
    params: AddOperationsParams,
  ): Promise<ResultT<void, RepoError>> {
    return this.runAsTenant(tenantId, async (trx) => {
      const row = await this.loadForUpdate(trx, params.change_set_id);
      if (!row) return Result.err({ kind: "not_found", change_set_id: params.change_set_id });
      if (row.status !== "draft") {
        return Result.err({
          kind: "invalid_state_for_operation",
          change_set_id: params.change_set_id,
          current: row.status,
          required: "draft",
        });
      }
      // Validate every operation against its Zod schema before persisting.
      // Item-by-item parse retains the discriminated Operation type at
      // the consumer side (Zod 4's array-of-discriminatedUnion inference
      // widens to unknown[] at .d.ts boundaries; parsing one-by-one
      // keeps each element narrow).
      const validated: Operation[] = [...row.staged_operations, ...params.operations].map((o) =>
        OperationSchema.parse(o),
      );

      await trx
        .updateTable("metadata.meta_change_set")
        .set({ staged_operations: JSON.stringify(validated) })
        .where("change_set_id", "=", params.change_set_id)
        .execute();

      return Result.ok(undefined);
    });
  }

  /** Read a Change Set without modifying it. */
  async load(tenantId: string, change_set_id: string): Promise<ResultT<ChangeSetRow, RepoError>> {
    return this.runAsTenant(tenantId, async (trx) => {
      const row = await this.loadForUpdate(trx, change_set_id, /* lock */ false);
      if (!row) return Result.err({ kind: "not_found", change_set_id });
      return Result.ok(row);
    });
  }

  /**
   * Move a Change Set through the state machine. For `deploy` and
   * `rollback`, the side-effects (materializing rows, flipping
   * valid_until) happen inside this same transaction. For `propose`,
   * `approve`, and `revert`, only the status column changes.
   */
  async transition(
    tenantId: string,
    input: TransitionInput,
  ): Promise<ResultT<TransitionOutcome, RepoError>> {
    return this.runAsTenant(tenantId, async (trx) => {
      const row = await this.loadForUpdate(trx, input.change_set_id);
      if (!row) return Result.err({ kind: "not_found", change_set_id: input.change_set_id });

      const next = transition(row.status, input.action, input.actor);
      if (Result.isErr(next)) {
        return Result.err({ kind: "transition_error", cause: next.error });
      }

      const fromState = row.status;
      const toState = next.value;
      let opsApplied = 0;

      // Status-only transitions: propose, approve, revert.
      if (input.action === "propose" || input.action === "approve" || input.action === "revert") {
        const setColumns: Record<string, unknown> = { status: toState };
        if (input.action === "approve") {
          setColumns.approved_by = input.actor.actor_id;
          setColumns.approved_at = new Date();
        }
        await trx
          .updateTable("metadata.meta_change_set")
          .set(setColumns)
          .where("change_set_id", "=", input.change_set_id)
          .execute();
      }

      // Atomic deploy.
      if (input.action === "deploy") {
        opsApplied = await this.applyStagedOperations(trx, tenantId, row);
        await trx
          .updateTable("metadata.meta_change_set")
          .set({ status: toState, deployed_at: new Date() })
          .where("change_set_id", "=", input.change_set_id)
          .execute();
      }

      // O(1) rollback per operation.
      if (input.action === "rollback") {
        opsApplied = await this.revertDeployment(trx, input.change_set_id);
        await trx
          .updateTable("metadata.meta_change_set")
          .set({ status: toState, rolled_back_at: new Date() })
          .where("change_set_id", "=", input.change_set_id)
          .execute();
      }

      // Audit entry — same transaction as the side-effects.
      await this.writeAudit(trx, {
        tenant_id: tenantId,
        actor_id: input.actor.actor_id,
        action: `change_set.${input.action}`,
        change_set_id: input.change_set_id,
        diff: { from_state: fromState, to_state: toState, operations_applied: opsApplied },
        context: { roles: input.actor.roles },
      });

      // DomainEvent built (not yet emitted — outbox lands in TASK-08).
      const event = buildEventFor(input.action, {
        change_set_id: input.change_set_id,
        tenant_id: tenantId,
        actor_id: input.actor.actor_id,
        from_state: fromState,
        to_state: toState,
        operation_count: opsApplied,
      });

      return Result.ok({
        from_state: fromState,
        to_state: toState,
        event,
        operations_applied: opsApplied,
      });
    });
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private async loadForUpdate(
    trx: Kysely<Database> | Transaction<Database>,
    change_set_id: string,
    lock = true,
  ): Promise<ChangeSetRow | null> {
    let q = trx
      .selectFrom("metadata.meta_change_set")
      .selectAll()
      .where("change_set_id", "=", change_set_id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) return null;
    // Zod 4's discriminatedUnion-inside-array loses its discriminated
    // inference at consumer boundaries (the d.ts resolves to unknown[]).
    // Parse item-by-item against the single-operation schema so each
    // entry comes out as Operation (the discriminated type).
    const raw: readonly unknown[] = Array.isArray(r.staged_operations) ? r.staged_operations : [];
    const ops: Operation[] = raw.map((o) => OperationSchema.parse(o));
    return {
      ...r,
      staged_operations: ops,
    };
  }

  /**
   * Materialize every staged operation into a meta_object row. For each
   * upsert/tombstone, the prior currently-active row (if any) has its
   * valid_until set to now() AND its superseded_by_change_set_id set to
   * this change set. The row this operation produces lands with
   * valid_until = NULL.
   *
   * Runs inside `trx` — the caller's transaction. If this method throws,
   * the transaction rolls back and meta_object is untouched. That is
   * what makes deploy "all ops commit or none" per TASK-07.
   */
  private async applyStagedOperations(
    trx: Transaction<Database>,
    tenantId: string,
    row: ChangeSetRow,
  ): Promise<number> {
    let count = 0;
    for (const op of row.staged_operations) {
      const supersedes = await trx
        .updateTable("metadata.meta_object")
        .set({
          valid_until: new Date(),
          superseded_by_change_set_id: row.change_set_id,
        })
        .where("object_id", "=", op.object_id)
        .where("layer", "=", op.layer)
        .where(
          "tenant_id",
          op.layer === "L0" || op.layer === "L1" ? "is" : "=",
          op.layer === "L0" || op.layer === "L1" ? null : tenantId,
        )
        .where("valid_until", "is", null)
        .returning(["object_pk", "object_type", "version"])
        .execute();

      const priorVersion = supersedes[0]?.version;
      const newVersion = (priorVersion ?? 0) + 1;

      if (op.op === "upsert") {
        await trx
          .insertInto("metadata.meta_object")
          .values({
            object_id: op.object_id,
            object_type: op.object_type,
            layer: op.layer,
            tenant_id: op.layer === "L0" || op.layer === "L1" ? null : tenantId,
            template_id: null,
            version: newVersion,
            operation: "upsert",
            body: JSON.stringify(op.body),
            created_by: row.created_by ?? "system",
            created_via: "change_set",
            change_set_id: row.change_set_id,
          })
          .execute();
      } else {
        await trx
          .insertInto("metadata.meta_object")
          .values({
            object_id: op.object_id,
            object_type: supersedes[0]?.object_type ?? "Entity",
            layer: op.layer,
            tenant_id: op.layer === "L0" || op.layer === "L1" ? null : tenantId,
            template_id: null,
            version: newVersion,
            operation: "tombstone",
            body: null,
            created_by: row.created_by ?? "system",
            created_via: "change_set",
            change_set_id: row.change_set_id,
          })
          .execute();
      }
      count += 1;
    }
    return count;
  }

  /**
   * Revert this Change Set's deployment. Two `UPDATE`s, each operating
   * on rows the deploy explicitly tagged:
   *
   *   1. Mark every row this Change Set CREATED as superseded — set
   *      its valid_until to now(). It stops contributing to resolution
   *      immediately.
   *   2. Revert every row this Change Set REPLACED — clear its
   *      valid_until and superseded_by_change_set_id. It becomes
   *      currently-active again.
   *
   * Both UPDATEs are bounded by `change_set_id` filters — O(operations
   * applied), independent of total row count per RFC §11.4.
   */
  private async revertDeployment(
    trx: Transaction<Database>,
    change_set_id: string,
  ): Promise<number> {
    const now = new Date();

    const newlyCreated = await trx
      .updateTable("metadata.meta_object")
      .set({ valid_until: now })
      .where("change_set_id", "=", change_set_id)
      .where("valid_until", "is", null)
      .returning(["object_pk"])
      .execute();

    await trx
      .updateTable("metadata.meta_object")
      .set({ valid_until: null, superseded_by_change_set_id: null })
      .where("superseded_by_change_set_id", "=", change_set_id)
      .execute();

    return newlyCreated.length;
  }

  private async writeAudit(
    trx: Transaction<Database>,
    entry: {
      tenant_id: string;
      actor_id: string;
      action: string;
      change_set_id: string;
      diff?: Record<string, unknown>;
      context?: Record<string, unknown>;
    },
  ): Promise<void> {
    await trx
      .insertInto("metadata.meta_audit_log")
      .values({
        tenant_id: entry.tenant_id,
        actor_id: entry.actor_id,
        action: entry.action,
        target_type: "change_set",
        target_id: entry.change_set_id,
        change_set_id: entry.change_set_id,
        diff: entry.diff ? JSON.stringify(entry.diff) : null,
        context: entry.context ? JSON.stringify(entry.context) : null,
      })
      .execute();
  }
}

// ── Event-builder dispatcher ─────────────────────────────────────────

function buildEventFor(
  action: Action,
  base: {
    change_set_id: string;
    tenant_id: string;
    actor_id: string;
    from_state: State;
    to_state: State;
    operation_count: number;
  },
): DomainEvent<ChangeSetEventPayload> | null {
  const eventTypeForAction: Partial<Record<Action, keyof typeof CHANGE_SET_EVENT_TYPES>> = {
    propose: "proposed",
    approve: "approved",
    deploy: "deployed",
    rollback: "rolled_back",
    revert: "reverted",
  };
  const key = eventTypeForAction[action];
  if (!key) return null;
  return buildChangeSetEvent({
    event_id: randomUUID(),
    event_type: CHANGE_SET_EVENT_TYPES[key],
    occurred_at: new Date().toISOString(),
    ...base,
  });
}

// `sql` import is referenced from elsewhere in @erp/db; keep the symbol live.
void sql;
