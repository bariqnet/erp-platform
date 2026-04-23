// OutboxPump — drains metadata.meta_outbox into the OutboxBus's in-process
// subscribers. Runs in the worker app (apps/worker) per CLAUDE.md §3.
//
// One row → one dispatch attempt. Per-row state machine:
//
//   pending (delivered_at IS NULL, attempt_count < max)
//     drainOnce picks it up FOR UPDATE SKIP LOCKED
//     dispatch(event) — fans out to subscribers
//     ── success ── delivered_at = now()
//     ── throws ── attempt_count += 1; last_error stored; row stays
//                  pending unless attempt_count >= max
//
// FOR UPDATE SKIP LOCKED lets multiple pumps share the load without
// double-delivery — each transaction holds its row exclusively.
//
// Restart durability: rows the pump never got to (delivered_at NULL,
// attempt_count 0) are picked up by the next pump that starts. Rows
// the pump dispatched but crashed before flipping delivered_at are
// re-delivered (consumers must dedup on event.dedup_key or event.event_id).

import { type Database } from "@erp/db";
import { type Kysely } from "kysely";

import { rowToEvent } from "./row.js";

import type { OutboxBus } from "./outbox-bus.js";

export interface OutboxPumpOptions {
  /** Rows pulled per drain. Default 50. */
  readonly batchSize?: number;
  /** Milliseconds between drain cycles when nothing new arrived. Default 250. */
  readonly idlePollMs?: number;
  /** Max delivery attempts per row before the pump skips it. Default 8. */
  readonly maxAttempts?: number;
}

export interface DrainStats {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
}

export class OutboxPump {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly batchSize: number;
  private readonly idlePollMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: OutboxBus,
    options: OutboxPumpOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.idlePollMs = options.idlePollMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  /**
   * Drain one batch synchronously. Returns the per-batch stats. Used
   * by tests and by the start() loop. Safe to call concurrently —
   * each call's transaction holds its rows exclusively.
   */
  async drainOnce(): Promise<DrainStats> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("metadata.meta_outbox")
        .selectAll()
        .where("delivered_at", "is", null)
        .where("attempt_count", "<", this.maxAttempts)
        .orderBy("outbox_pk")
        .limit(this.batchSize)
        .forUpdate()
        .skipLocked()
        .execute();

      let delivered = 0;
      let failed = 0;

      for (const row of rows) {
        const event = rowToEvent(row);
        try {
          this.bus.dispatch(event);
          await trx
            .updateTable("metadata.meta_outbox")
            .set({ delivered_at: new Date() })
            .where("outbox_pk", "=", row.outbox_pk)
            .execute();
          delivered += 1;
        } catch (err: unknown) {
          await trx
            .updateTable("metadata.meta_outbox")
            .set({
              attempt_count: row.attempt_count + 1,
              last_attempt_at: new Date(),
              last_error: errorMessage(err),
            })
            .where("outbox_pk", "=", row.outbox_pk)
            .execute();
          failed += 1;
        }
      }

      return { attempted: rows.length, delivered, failed };
    });
  }

  /**
   * Start the polling loop. Returns immediately; the loop runs in the
   * background. Call stop() to drain it gracefully.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        const stats = await this.drainOnce();
        // If we drained a full batch, there's likely more — poll again
        // immediately. If not, wait the idle interval.
        const next = stats.attempted >= this.batchSize ? 0 : this.idlePollMs;
        this.timer = setTimeout(tick, next);
      } catch {
        // The drain itself errored (DB unreachable, etc) — back off
        // for the idle interval and try again.
        this.timer = setTimeout(tick, this.idlePollMs);
      }
    };
    void tick();
  }

  /** Stop the polling loop. Returns once the in-flight tick has finished. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Give any in-flight tick a chance to land.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Inspect the dead-letter queue — rows past the maxAttempts cap.
   * The pump won't pick them up again. Operators clear them manually
   * after fixing whatever the root cause was.
   */
  async deadLettered(
    limit = 100,
  ): Promise<readonly { outbox_pk: string; event_type: string; last_error: string | null }[]> {
    return this.db
      .selectFrom("metadata.meta_outbox")
      .select(["outbox_pk", "event_type", "last_error"])
      .where("delivered_at", "is", null)
      .where("attempt_count", ">=", this.maxAttempts)
      .orderBy("outbox_pk")
      .limit(limit)
      .execute();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
