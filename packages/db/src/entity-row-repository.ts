// EntityRowRepository — data-layer access to ops.entity_row.
//
// Every Runtime API endpoint (RFC §9.2) reads and writes through this
// repository. Extends TenantRepository so the session GUC is set
// correctly on every call — RLS on ops.entity_row refuses any row
// whose tenant_id doesn't match `app.current_tenant` (the defense-
// in-depth layer that sits beneath the application-level tenant
// plumbing; CLAUDE.md §9).
//
// Phase 1 storage strategy is JSONB (Migration 0004). `body` holds
// every field value; `status` holds the lifecycle state. Adding a
// field via the Admin API requires no DDL — the next INSERT carries
// the new key in the JSONB body and the next SELECT returns it.

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import { type Database, type OpsEntityRowTable } from "./schema.js";
import { TenantRepository } from "./tenant-repository.js";

export interface EntityRow {
  readonly row_pk: string;
  readonly tenant_id: string;
  readonly entity_id: string;
  readonly row_id: string;
  readonly body: Record<string, unknown>;
  readonly status: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly created_by: string | null;
  readonly updated_by: string | null;
}

export interface ListEntityRowsParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface CreateEntityRowInput {
  readonly entity_id: string;
  readonly body: Record<string, unknown>;
  readonly status?: string | null;
  readonly created_by?: string | null;
  /** Optional caller-supplied row_id. When omitted the DB generates a UUID. */
  readonly row_id?: string;
}

export interface PatchEntityRowInput {
  readonly body?: Record<string, unknown>;
  readonly status?: string | null;
  readonly updated_by?: string | null;
}

export class EntityRowRepository extends TenantRepository {
  public constructor(db: Kysely<Database>) {
    super(db);
  }

  /**
   * Runtime API · list non-deleted rows for a tenant's entity. Capped
   * at 200 to keep the default response payload bounded — callers that
   * need more iterate with offset.
   */
  async list(
    tenantId: string,
    entityId: string,
    params: ListEntityRowsParams = {},
  ): Promise<readonly EntityRow[]> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = Math.max(params.offset ?? 0, 0);
    return this.runAsTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom("ops.entity_row")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("entity_id", "=", entityId)
        .where("deleted_at", "is", null)
        .orderBy("created_at", "desc")
        .orderBy("row_pk", "desc")
        .limit(limit)
        .offset(offset)
        .execute();
      return rows.map(toRow);
    });
  }

  /** Runtime API · fetch a single non-deleted row. Returns null when missing. */
  async get(tenantId: string, entityId: string, rowId: string): Promise<EntityRow | null> {
    return this.runAsTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom("ops.entity_row")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("entity_id", "=", entityId)
        .where("row_id", "=", rowId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return row ? toRow(row) : null;
    });
  }

  /** Runtime API · insert a new row. The DB generates row_id when omitted. */
  async create(tenantId: string, input: CreateEntityRowInput): Promise<EntityRow> {
    return this.runAsTenant(tenantId, async (trx) => this.createInTx(trx, tenantId, input));
  }

  /**
   * Variant of create() usable inside a caller-owned transaction. Kept
   * separate so consumers that already hold a TenantContext-bound trx
   * (e.g. the bulk-import path coming in TASK-13) don't open a second.
   */
  async createInTx(
    trx: Transaction<Database>,
    tenantId: string,
    input: CreateEntityRowInput,
  ): Promise<EntityRow> {
    const inserted = await trx
      .insertInto("ops.entity_row")
      .values({
        tenant_id: tenantId,
        entity_id: input.entity_id,
        ...(input.row_id !== undefined ? { row_id: input.row_id } : {}),
        body: JSON.stringify(input.body),
        status: input.status ?? null,
        created_by: input.created_by ?? null,
        updated_by: input.created_by ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRow(inserted);
  }

  /**
   * Runtime API · patch an existing row. Returns null when no row
   * matches (the route then responds 404). `body` is replaced wholesale
   * — PATCH semantics at the field level are handled in the service
   * layer by merging before calling this repo.
   */
  async patch(
    tenantId: string,
    entityId: string,
    rowId: string,
    input: PatchEntityRowInput,
  ): Promise<EntityRow | null> {
    return this.runAsTenant(tenantId, async (trx) =>
      this.patchInTx(trx, tenantId, entityId, rowId, input),
    );
  }

  /**
   * Transactional variant of patch(). Used by callers that want the
   * row update to share a transaction with a neighboring write —
   * most importantly the RuntimeEntityService, which appends an
   * audit row in the same tx as the data mutation.
   */
  async patchInTx(
    trx: Transaction<Database>,
    tenantId: string,
    entityId: string,
    rowId: string,
    input: PatchEntityRowInput,
  ): Promise<EntityRow | null> {
    // Use Postgres `now()` so UPDATE timestamps share the same clock
    // as the INSERT's `DEFAULT now()`. Passing `new Date()` from Node
    // introduces host-vs-container clock drift (observed ~100 ms on
    // Docker Desktop on macOS), which made this and softDelete's
    // updated_at race the creation timestamp under test.
    const updated = await trx
      .updateTable("ops.entity_row")
      .set({
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.updated_by !== undefined ? { updated_by: input.updated_by } : {}),
        updated_at: sql`now()`,
      })
      .where("tenant_id", "=", tenantId)
      .where("entity_id", "=", entityId)
      .where("row_id", "=", rowId)
      .where("deleted_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return updated ? toRow(updated) : null;
  }

  /**
   * Runtime API · soft-delete a row by setting deleted_at. Returns
   * true when a row was affected, false when the row was already
   * deleted or never existed.
   */
  async softDelete(
    tenantId: string,
    entityId: string,
    rowId: string,
    actor: string | null,
  ): Promise<boolean> {
    return this.runAsTenant(tenantId, async (trx) =>
      this.softDeleteInTx(trx, tenantId, entityId, rowId, actor),
    );
  }

  /** Transactional variant of softDelete(). Same rationale as patchInTx. */
  async softDeleteInTx(
    trx: Transaction<Database>,
    tenantId: string,
    entityId: string,
    rowId: string,
    actor: string | null,
  ): Promise<boolean> {
    const result = await trx
      .updateTable("ops.entity_row")
      .set({
        deleted_at: sql`now()`,
        updated_at: sql`now()`,
        ...(actor !== null ? { updated_by: actor } : {}),
      })
      .where("tenant_id", "=", tenantId)
      .where("entity_id", "=", entityId)
      .where("row_id", "=", rowId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}

function toRow(row: Selectable<OpsEntityRowTable>): EntityRow {
  return {
    row_pk: row.row_pk,
    tenant_id: row.tenant_id,
    entity_id: row.entity_id,
    row_id: row.row_id,
    body: row.body,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    deleted_at: row.deleted_at?.toISOString() ?? null,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}
