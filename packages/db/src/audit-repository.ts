// AuditRepository — hash-chained append-only audit log (RFC §13.2).
//
// Every row carries `after_hash = sha256(before_hash ?? '' || canonical(payload))`.
// Subsequent rows carry `before_hash = previous_row.after_hash`. A
// missing link or a modified row breaks the chain — tamper detection
// is an offline sweep that recomputes and compares, implemented
// alongside the audit-reader role in a later task.
//
// Per-tenant chain. Rows with `tenant_id IS NULL` (vendor-level) chain
// as their own sequence, independent of any tenant.
//
// Concurrency: appends under the same tenant serialize via a
// transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`).
// Without it, two concurrent appends could read the same "last
// hash" and both use it as `before_hash` — the chain would fork.
// The advisory lock is released when the transaction commits or
// aborts, so no cleanup is needed.
//
// All methods take a caller-supplied Transaction so the audit write
// is atomic with the data write it describes. Standalone `append()`
// isn't exposed — a caller that calls it outside a transaction
// would create an audit-data consistency gap we don't want.

import { createHash } from "node:crypto";

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import { type Database, type MetaAuditLogTable } from "./schema.js";
import { TenantRepository } from "./tenant-repository.js";

// ── Types ────────────────────────────────────────────────────────────

export interface AppendAuditInput {
  /** Tenant this row belongs to; null for vendor-level entries. */
  readonly tenant_id: string | null;
  readonly actor_id: string;
  /** Dotted verb, e.g. "ent.customer.create", "change_set.deploy". */
  readonly action: string;
  readonly target_type?: string;
  readonly target_id?: string;
  readonly change_set_id?: string;
  /** Structured before/after or free-form diff. Canonicalized for hashing. */
  readonly diff?: Record<string, unknown>;
  /** Request-level context (request_id, trace_id, ip, …). */
  readonly context?: Record<string, unknown>;
}

export interface AuditRow {
  readonly audit_pk: string;
  readonly tenant_id: string | null;
  readonly actor_id: string;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly change_set_id: string | null;
  readonly before_hash: string | null;
  readonly after_hash: string;
  readonly diff: Record<string, unknown> | null;
  readonly context: Record<string, unknown> | null;
  readonly created_at: string;
}

// ── Hashing ─────────────────────────────────────────────────────────

/**
 * Canonicalize a JSON value so the hash is stable across platforms
 * and re-serialization round-trips. Keys are sorted; undefined/null
 * distinctions collapse (we only serialize non-null values).
 *
 * Exported so tamper-detection sweeps (a later task) can recompute
 * hashes offline and compare against stored `after_hash` values.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalize(v)}`);
    }
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(String(value));
}

/**
 * Hash an audit row's content given the prior row's `after_hash`.
 * Exported for offline tamper-detection sweeps.
 */
export function computeAfterHash(
  beforeHash: string | null,
  payload: Omit<AppendAuditInput, "diff" | "context"> & {
    readonly diff: Record<string, unknown> | null;
    readonly context: Record<string, unknown> | null;
    readonly created_at: string;
  },
): string {
  const canonical = canonicalize({
    tenant_id: payload.tenant_id,
    actor_id: payload.actor_id,
    action: payload.action,
    target_type: payload.target_type ?? null,
    target_id: payload.target_id ?? null,
    change_set_id: payload.change_set_id ?? null,
    diff: payload.diff,
    context: payload.context,
    created_at: payload.created_at,
  });
  return createHash("sha256")
    .update((beforeHash ?? "") + "|" + canonical)
    .digest("hex");
}

// ── Repository ──────────────────────────────────────────────────────

export class AuditRepository extends TenantRepository {
  public constructor(db: Kysely<Database>) {
    super(db);
  }

  /**
   * Append one hash-chained row inside the caller's transaction. The
   * transaction must already have `app.current_tenant` set to the
   * correct tenant (or NULL for vendor-level entries) — RLS on
   * meta_audit_log enforces this at the DB layer.
   *
   * Returns the inserted row with every field (including audit_pk +
   * computed hashes) populated.
   */
  async appendInTx(trx: Transaction<Database>, input: AppendAuditInput): Promise<AuditRow> {
    // Serialize audit appends per tenant. `pg_advisory_xact_lock`
    // takes a bigint; we derive one from a stable hash of the tenant
    // id. NULL-tenant appends share a single lock (bigint 0) which
    // is fine — vendor-level writes are rare.
    const lockKey = advisoryLockKey(input.tenant_id);
    await sql`SELECT pg_advisory_xact_lock(${lockKey})`.execute(trx);

    const beforeHash = await this.readLastHashInTx(trx, input.tenant_id);
    const createdAt = new Date();
    const diff = input.diff ?? null;
    const context = input.context ?? null;
    const afterHash = computeAfterHash(beforeHash, {
      tenant_id: input.tenant_id,
      actor_id: input.actor_id,
      action: input.action,
      ...(input.target_type !== undefined ? { target_type: input.target_type } : {}),
      ...(input.target_id !== undefined ? { target_id: input.target_id } : {}),
      ...(input.change_set_id !== undefined ? { change_set_id: input.change_set_id } : {}),
      diff,
      context,
      created_at: createdAt.toISOString(),
    });

    const inserted = await trx
      .insertInto("metadata.meta_audit_log")
      .values({
        tenant_id: input.tenant_id,
        actor_id: input.actor_id,
        action: input.action,
        target_type: input.target_type ?? null,
        target_id: input.target_id ?? null,
        change_set_id: input.change_set_id ?? null,
        before_hash: beforeHash,
        after_hash: afterHash,
        diff: diff ? JSON.stringify(diff) : null,
        context: context ? JSON.stringify(context) : null,
        created_at: createdAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toRow(inserted);
  }

  /** Read the most-recent row's `after_hash` for this tenant. */
  async readLastHashInTx(
    trx: Transaction<Database>,
    tenantId: string | null,
  ): Promise<string | null> {
    let query = trx
      .selectFrom("metadata.meta_audit_log")
      .select("after_hash")
      .where("after_hash", "is not", null)
      .orderBy("audit_pk", "desc")
      .limit(1);
    query =
      tenantId === null
        ? query.where("tenant_id", "is", null)
        : query.where("tenant_id", "=", tenantId);
    const row = await query.executeTakeFirst();
    return row?.after_hash ?? null;
  }

  /**
   * Verify a contiguous slice of the chain. Reads every audit row for
   * the tenant and recomputes each `after_hash` from the previous
   * one. Returns the first break (as `{ audit_pk, reason }`) or
   * `null` when the chain is intact. Used by the tamper-detection
   * sweep.
   */
  async verifyChain(tenantId: string | null): Promise<{ audit_pk: string; reason: string } | null> {
    const rows = await this.runAsVendor(async (trx) => {
      let query = trx.selectFrom("metadata.meta_audit_log").selectAll().orderBy("audit_pk");
      query =
        tenantId === null
          ? query.where("tenant_id", "is", null)
          : query.where("tenant_id", "=", tenantId);
      return query.execute();
    });

    let expectedBefore: string | null = null;
    for (const row of rows) {
      if (row.before_hash !== expectedBefore) {
        return {
          audit_pk: row.audit_pk,
          reason: `before_hash mismatch: stored=${row.before_hash ?? "null"}, expected=${expectedBefore ?? "null"}`,
        };
      }
      const recomputed = computeAfterHash(row.before_hash, {
        tenant_id: row.tenant_id,
        actor_id: row.actor_id,
        action: row.action,
        ...(row.target_type !== null ? { target_type: row.target_type } : {}),
        ...(row.target_id !== null ? { target_id: row.target_id } : {}),
        ...(row.change_set_id !== null ? { change_set_id: row.change_set_id } : {}),
        diff: row.diff,
        context: row.context,
        created_at: row.created_at.toISOString(),
      });
      if (row.after_hash !== recomputed) {
        return {
          audit_pk: row.audit_pk,
          reason: `after_hash mismatch: stored=${row.after_hash ?? "null"}, recomputed=${recomputed}`,
        };
      }
      expectedBefore = row.after_hash;
    }
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Derive a bigint lock key from the tenant id. Collisions across
 * tenants just cause serialized writes — correctness is preserved;
 * throughput would only matter if two tenants happened to collide
 * AND both were writing audit rows concurrently at high rate.
 * SHA256's top 64 bits are fine for this.
 */
function advisoryLockKey(tenantId: string | null): bigint {
  if (tenantId === null) return 0n;
  const digest = createHash("sha256").update(tenantId).digest();
  // Take the top 64 bits as a signed bigint (pg_advisory_xact_lock's
  // single-arg form expects bigint; any 64-bit value works).
  let n = 0n;
  for (let i = 0; i < 8; i += 1) {
    n = (n << 8n) | BigInt(digest[i] ?? 0);
  }
  // Convert to signed bigint in the int8 range.
  const signed = n > 0x7fffffffffffffffn ? n - 0x10000000000000000n : n;
  return signed;
}

function toRow(row: Selectable<MetaAuditLogTable>): AuditRow {
  if (row.after_hash === null) {
    throw new Error("AuditRepository.toRow: after_hash is null — chain broken at insert time");
  }
  return {
    audit_pk: row.audit_pk,
    tenant_id: row.tenant_id,
    actor_id: row.actor_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    change_set_id: row.change_set_id,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
    diff: row.diff,
    context: row.context,
    created_at: row.created_at.toISOString(),
  };
}
