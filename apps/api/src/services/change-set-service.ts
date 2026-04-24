// ChangeSetService — business logic wrapper around ChangeSetRepository
// for the six RFC §9.1 write-side endpoints. Returns Result<T, E>; the
// route maps to HTTP via Result.match.

import { type Operations, type TransitionActor } from "@erp/change-set";
import { Result, type Layer, type Result as ResultT } from "@erp/core";
import {
  type ChangeSetRepoError,
  type ChangeSetRepository,
  type ChangeSetRow,
  type TransitionOutcome,
} from "@erp/db";

export type ServiceError =
  | ChangeSetRepoError
  | { readonly kind: "already_exists"; readonly change_set_id: string };

export interface CreateInput {
  readonly tenantId: string;
  readonly change_set_id: string;
  readonly description?: string;
  readonly created_by: string;
  readonly operations?: Operations;
}

export interface TransitionInput {
  readonly tenantId: string;
  readonly change_set_id: string;
  readonly actor: TransitionActor;
}

export interface SimulateOutput {
  readonly change_set_id: string;
  readonly operation_count: number;
  readonly affected_objects: readonly {
    readonly object_id: string;
    readonly layer: Layer;
    readonly op: "upsert" | "tombstone";
  }[];
  readonly notes: readonly string[];
}

export class ChangeSetService {
  constructor(private readonly repo: ChangeSetRepository) {}

  async create(input: CreateInput): Promise<ResultT<ChangeSetRow, ServiceError>> {
    try {
      await this.repo.create(input.tenantId, {
        change_set_id: input.change_set_id,
        created_by: input.created_by,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    } catch (err: unknown) {
      // Postgres UNIQUE violation on the primary key.
      if (isUniqueViolation(err)) {
        return Result.err({ kind: "already_exists", change_set_id: input.change_set_id });
      }
      throw err;
    }

    if (input.operations !== undefined && input.operations.length > 0) {
      const r = await this.repo.addOperations(input.tenantId, {
        change_set_id: input.change_set_id,
        operations: input.operations,
      });
      if (Result.isErr(r)) return Result.err(r.error);
    }

    const loaded = await this.repo.load(input.tenantId, input.change_set_id);
    if (Result.isErr(loaded)) return Result.err(loaded.error);
    return Result.ok(loaded.value);
  }

  async load(
    tenantId: string,
    change_set_id: string,
  ): Promise<ResultT<ChangeSetRow, ServiceError>> {
    return this.repo.load(tenantId, change_set_id);
  }

  /**
   * TASK-21 · list change sets for the tenant, newest first.
   * Optional status filter for the Config Studio's "Draft /
   * Proposed / Deployed" tabs.
   */
  async list(
    tenantId: string,
    params: {
      readonly status?: ChangeSetRow["status"];
      readonly limit?: number;
      readonly offset?: number;
    },
  ): Promise<readonly ChangeSetRow[]> {
    return this.repo.list(tenantId, params);
  }

  async transition(
    input: TransitionInput,
    action: "propose" | "approve" | "deploy" | "rollback" | "revert",
  ): Promise<ResultT<TransitionOutcome, ServiceError>> {
    return this.repo.transition(input.tenantId, {
      change_set_id: input.change_set_id,
      action,
      actor: input.actor,
    });
  }

  /**
   * Simulate — load the staged operations and report what would
   * happen on deploy. Phase 1 returns the operation summary; the
   * Impact Analyzer (RFC §6.4) is a future-task expansion.
   */
  async simulate(
    tenantId: string,
    change_set_id: string,
  ): Promise<ResultT<SimulateOutput, ServiceError>> {
    const loaded = await this.repo.load(tenantId, change_set_id);
    if (Result.isErr(loaded)) return Result.err(loaded.error);

    const ops = loaded.value.staged_operations;
    return Result.ok({
      change_set_id,
      operation_count: ops.length,
      affected_objects: ops.map((o) => ({
        object_id: o.object_id,
        layer: o.layer,
        op: o.op,
      })),
      notes: [
        `Would deploy ${ops.length} operation(s) at status='deployed'.`,
        "Impact Analyzer (RFC §6.4) — not yet implemented; deferred.",
      ],
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505";
}
