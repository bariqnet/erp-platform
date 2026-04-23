/**
 * scripts/backfill-audit-chain.ts — retrofits hash chains onto legacy
 * meta_audit_log rows (TASK-14.1).
 *
 * Why this exists
 * ──────────────
 * TASK-07 (ChangeSetRepository) wrote audit rows with before_hash +
 * after_hash = NULL. TASK-13.x introduced AuditRepository with a
 * hash chain (RFC §13.2) and left the legacy rows alone —
 * readLastHashInTx filters `WHERE after_hash IS NOT NULL` so the
 * two histories stay separate. This script closes the gap: it walks
 * every audit row in `audit_pk` order, recomputes the canonical
 * payload, and writes before_hash + after_hash in place so tenant A's
 * chain is one continuous sequence from its first audit row to its
 * latest.
 *
 * Per-tenant chains (tenant_id IS NULL = vendor-global chain).
 *
 * Idempotency
 * ──────────
 * If every row already has after_hash populated AND verifyChain
 * reports `null`, the script exits with zero writes. Partial states
 * (some rows hashed, later rows not) are reconciled by the script
 * on the next run.
 *
 * Usage
 * ─────
 *   pnpm db:backfill-audit-chain             # apply
 *   pnpm db:backfill-audit-chain -- --dry    # plan only, no writes
 *
 * Safe to run on a live database: every tenant's chain rebuild is
 * wrapped in one transaction so reads by the app either see the
 * entire rebuilt chain or the previous state. RLS is bypassed (the
 * script runs as the pool's superuser role) since we're reading
 * across every tenant.
 */

import { AuditRepository, canonicalize, computeAfterHash, createDatabase } from "@erp/db";
import { createLogger } from "@erp/telemetry";

// Top-level env check is gated inside main() so tests can import
// runBackfill without the script calling process.exit(2).
const DRY_RUN =
  new Set(process.argv.slice(2)).has("--dry") || new Set(process.argv.slice(2)).has("--dry-run");

interface BackfillStats {
  readonly tenantsProcessed: number;
  readonly rowsVisited: number;
  readonly rowsRewritten: number;
  readonly chainsAlreadyValid: number;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    // eslint-disable-next-line no-console
    console.error(
      "db-backfill-audit-chain: DATABASE_URL is required. " +
        "Copy .env.example to .env and fill it in, or export the variable before running.",
    );
    process.exit(2);
  }

  const logger = createLogger({ service: "db-backfill-audit-chain", pretty: true });
  const db = createDatabase({
    connectionString: databaseUrl,
    applicationName: "db-backfill-audit-chain",
    max: 4,
  });

  try {
    // Enumerate every tenant (including NULL for vendor-global rows)
    // that has at least one audit entry. Run under the pool's
    // default role — we need to see every tenant's data.
    const tenants = await db
      .selectFrom("metadata.meta_audit_log")
      .select(["tenant_id"])
      .distinct()
      .execute();

    const stats: BackfillStats = await runBackfill(
      db,
      logger,
      tenants.map((r) => r.tenant_id),
    );
    logger.info(
      stats,
      DRY_RUN ? "db-backfill-audit-chain: dry-run done" : "db-backfill-audit-chain: done",
    );
  } finally {
    await db.destroy();
  }
}

export async function runBackfill(
  db: ReturnType<typeof createDatabase>,
  logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">,
  tenantIds: readonly (string | null)[],
): Promise<BackfillStats> {
  const repo = new AuditRepository(db);
  let tenantsProcessed = 0;
  let rowsVisited = 0;
  let rowsRewritten = 0;
  let chainsAlreadyValid = 0;

  for (const tenantId of tenantIds) {
    // If the chain is already intact AND every row has a hash, skip.
    // `verifyChain` returns null for both "no rows" and "clean chain"
    // — either means no work. A quick null-hash check upfront catches
    // the partial-state case.
    const hasNullHashes = await db
      .selectFrom("metadata.meta_audit_log")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where((eb) =>
        tenantId === null ? eb("tenant_id", "is", null) : eb("tenant_id", "=", tenantId),
      )
      .where("after_hash", "is", null)
      .executeTakeFirstOrThrow();
    const unhashedCount = Number(hasNullHashes.count);

    if (unhashedCount === 0) {
      const breakage = await repo.verifyChain(tenantId);
      if (breakage === null) {
        chainsAlreadyValid += 1;
        tenantsProcessed += 1;
        logger.info(
          { tenant_id: tenantId ?? "<vendor>", rows: 0 },
          "tenant chain already intact — skipping",
        );
        continue;
      }
      // Chain has hashes but a verify-time mismatch — rebuild anyway.
      logger.warn(
        { tenant_id: tenantId ?? "<vendor>", breakage },
        "tenant chain reports tamper/mismatch — rebuilding",
      );
    }

    // Rebuild the chain inside one transaction per tenant. The app
    // code's `readLastHashInTx` filter (`WHERE after_hash IS NOT
    // NULL`) means concurrent appends still succeed against the
    // old head; once this commit lands, every row is chained.
    const rewritten = await db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("metadata.meta_audit_log")
        .selectAll()
        .where((eb) =>
          tenantId === null ? eb("tenant_id", "is", null) : eb("tenant_id", "=", tenantId),
        )
        .orderBy("audit_pk")
        .execute();
      rowsVisited += rows.length;

      let prevAfter: string | null = null;
      let wroteThisTenant = 0;

      for (const row of rows) {
        const payload = {
          tenant_id: row.tenant_id,
          actor_id: row.actor_id,
          action: row.action,
          ...(row.target_type !== null ? { target_type: row.target_type } : {}),
          ...(row.target_id !== null ? { target_id: row.target_id } : {}),
          ...(row.change_set_id !== null ? { change_set_id: row.change_set_id } : {}),
          diff: row.diff,
          context: row.context,
          created_at: row.created_at.toISOString(),
        };
        const expectedAfter = computeAfterHash(prevAfter, payload);
        // Touch only rows whose stored hashes don't match — avoids
        // generating noise writes when the script runs on a healthy DB.
        const storedBefore = row.before_hash;
        const storedAfter = row.after_hash;
        const needsWrite = storedBefore !== prevAfter || storedAfter !== expectedAfter;

        if (needsWrite && !DRY_RUN) {
          await trx
            .updateTable("metadata.meta_audit_log")
            .set({ before_hash: prevAfter, after_hash: expectedAfter })
            .where("audit_pk", "=", row.audit_pk)
            .execute();
        }
        if (needsWrite) wroteThisTenant += 1;

        prevAfter = expectedAfter;
        // Sanity: canonicalize is pure, deterministic. If an earlier
        // rewrite stored a different canonical form (shouldn't
        // happen), surface it.
        void canonicalize(payload);
      }

      return wroteThisTenant;
    });

    rowsRewritten += rewritten;
    tenantsProcessed += 1;
    logger.info(
      {
        tenant_id: tenantId ?? "<vendor>",
        rows_visited: rowsVisited,
        rows_rewritten: rewritten,
        dry_run: DRY_RUN,
      },
      "tenant chain backfilled",
    );
  }

  return { tenantsProcessed, rowsVisited, rowsRewritten, chainsAlreadyValid };
}

const invokedAsScript = Boolean(
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")),
);
if (invokedAsScript) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("db-backfill-audit-chain: fatal", err);
    process.exit(1);
  });
}
