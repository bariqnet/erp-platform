// CacheInvalidator — polls metadata.meta_outbox for
// `metadata.change_set_deployed` events above the instance's cursor
// and evicts each affected tenant's cache from both L1 and L2.
//
// Read-only poller: it does NOT flip delivered_at. The worker app's
// OutboxPump owns that. Each kernel instance runs its own invalidator
// pointing at the shared outbox table, tracking its own in-memory
// cursor. No cross-kernel coordination needed.
//
// RFC §5.4 SLO: propagation p95 < 500 ms across the fleet. The default
// tick interval (250 ms) is well under half that budget.

import { type Database } from "@erp/db";
import { type Logger } from "@erp/telemetry";
import { type Kysely } from "kysely";

import { type KernelCache } from "./cache.js";

const CHANGE_SET_DEPLOYED = "metadata.change_set_deployed";

export interface CacheInvalidatorOptions {
  readonly db: Kysely<Database>;
  readonly cache: KernelCache;
  readonly logger: Logger;
  /** Milliseconds between ticks. Defaults to 250. */
  readonly tickIntervalMs?: number;
}

export class CacheInvalidator {
  private lastSeenPk = BigInt(0);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: CacheInvalidatorOptions) {}

  /**
   * Initialize the cursor to the current max(outbox_pk). Called once
   * at boot so the invalidator only reacts to events published after
   * this kernel started — it never reprocesses old ones.
   */
  async initCursor(): Promise<void> {
    const row = await this.opts.db
      .selectFrom("metadata.meta_outbox")
      .select((eb) => eb.fn.max<string>("outbox_pk").as("max_pk"))
      .executeTakeFirst();
    if (row?.max_pk !== null && row?.max_pk !== undefined) {
      this.lastSeenPk = BigInt(row.max_pk);
    }
  }

  /**
   * Process every deploy event above the cursor. Returns the number
   * of events consumed. Called from tick() and from tests directly
   * (bypasses the timer).
   */
  async drainOnce(): Promise<number> {
    const rows = await this.opts.db
      .selectFrom("metadata.meta_outbox")
      .select(["outbox_pk", "tenant_id", "event_type", "payload"])
      .where("outbox_pk", ">", this.lastSeenPk.toString())
      .where("event_type", "=", CHANGE_SET_DEPLOYED)
      .orderBy("outbox_pk")
      .limit(100)
      .execute();

    for (const row of rows) {
      if (row.tenant_id !== null) {
        const invalidated = await this.opts.cache.invalidateTenant(row.tenant_id);
        this.opts.logger.info(
          { tenant_id: row.tenant_id, outbox_pk: row.outbox_pk, invalidated },
          "kernel cache invalidated on metadata.change_set_deployed",
        );
      }
      this.lastSeenPk = BigInt(row.outbox_pk);
    }

    return rows.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.opts.tickIntervalMs ?? 250;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.drainOnce();
      } catch (err: unknown) {
        this.opts.logger.warn({ err }, "kernel invalidator: drain failed; will retry");
      }
      if (this.running) {
        this.timer = setTimeout(tick, interval);
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
