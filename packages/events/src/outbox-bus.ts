// OutboxBus — the @erp/core EventBus port backed by metadata.meta_outbox.
//
// Phase 1 wiring per CLAUDE.md §2: in-process EventEmitter for fan-out
// to subscribers, Postgres outbox for durability across restarts.
// Phase 2+ swaps in NATS JetStream behind the same `EventBus`
// interface; this file goes away.
//
// Two publish surfaces:
//
//   publish(event)              — opens its own transaction. Use from
//                                 places that don't already have one
//                                 (cron jobs, admin scripts).
//   publishWithin(trx, event)   — atomic with the caller's transaction.
//                                 Use from repository code that just
//                                 wrote the data the event describes.
//                                 If the surrounding tx aborts, the
//                                 outbox row never appears — the
//                                 outbox-with-data pattern.
//
// Subscribers are in-memory. The OutboxPump drains pending rows and
// calls bus.dispatch(event) — the bus then fans out to subscribers
// for that event_type. Subscribers SHOULD dedup on event.event_id or
// event.dedup_key — at-least-once delivery means a handler may see
// the same event twice if it threw on the first attempt.

import { EventEmitter } from "node:events";

import {
  type DomainEvent,
  type EventBus,
  type EventHandler,
  type Subscription,
  type WaitForOptions,
} from "@erp/core";
import { type Database } from "@erp/db";
import { type Insertable, type Kysely, type Transaction } from "kysely";

type OutboxInsert = Insertable<Database["metadata.meta_outbox"]>;

export interface OutboxBusOptions {
  /** Defaults to 5_000 ms — used by waitFor() when no per-call timeout. */
  readonly defaultWaitTimeoutMs?: number;
}

export class OutboxBus implements EventBus {
  private readonly emitter = new EventEmitter();
  private readonly defaultWaitTimeoutMs: number;

  constructor(
    private readonly db: Kysely<Database>,
    options: OutboxBusOptions = {},
  ) {
    this.defaultWaitTimeoutMs = options.defaultWaitTimeoutMs ?? 5_000;
    // EventEmitter complains past 10 listeners by default; subscribers
    // can stack up if the kernel + worker + HTTP layer all listen.
    this.emitter.setMaxListeners(100);
  }

  /**
   * Publish an event in its own transaction. Returns once the row is
   * durably in the outbox. Dispatch to in-memory subscribers happens
   * later, when the OutboxPump drains.
   *
   * Idempotent on `dedup_key`: a second publish with the same
   * dedup_key is a no-op (ON CONFLICT DO NOTHING).
   */
  async publish(event: DomainEvent): Promise<void> {
    await this.db
      .insertInto("metadata.meta_outbox")
      .values(toOutboxRow(event))
      .onConflict((c) => c.column("dedup_key").doNothing())
      .execute();
  }

  /**
   * Publish an event inside the caller's transaction. THE outbox-with-
   * data pattern: the event INSERT shares atomicity with whatever data
   * change the caller just wrote. Either both land or neither does.
   */
  async publishWithin(trx: Transaction<Database>, event: DomainEvent): Promise<void> {
    await trx
      .insertInto("metadata.meta_outbox")
      .values(toOutboxRow(event))
      .onConflict((c) => c.column("dedup_key").doNothing())
      .execute();
  }

  subscribe<TPayload = unknown>(eventType: string, handler: EventHandler<TPayload>): Subscription {
    const wrapped = (event: DomainEvent): void => {
      // Subscribers may return a Promise; the dispatch loop awaits it.
      // EventEmitter.on doesn't await, so we wrap with .then to surface
      // unhandled rejections during pump dispatch.
      const result = handler(event as DomainEvent<TPayload>);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err: unknown) => {
          this.emitter.emit("__bus_error__", err, event);
        });
      }
    };
    this.emitter.on(eventType, wrapped);
    return {
      event_type: eventType,
      unsubscribe: () => {
        this.emitter.off(eventType, wrapped);
      },
    };
  }

  /**
   * Wait for the next event whose `predicate(event)` returns true.
   * Used by the kernel cache invalidation path (RFC §5.4) and by
   * tests that need to block on a specific deploy.
   */
  async waitFor<TPayload = unknown>(
    predicate: (event: DomainEvent) => boolean,
    options: WaitForOptions = {},
  ): Promise<DomainEvent<TPayload>> {
    const timeoutMs = options.timeoutMs ?? this.defaultWaitTimeoutMs;
    return new Promise<DomainEvent<TPayload>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off("__dispatch__", listener);
        reject(new Error(`OutboxBus.waitFor: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const listener = (event: DomainEvent): void => {
        if (predicate(event)) {
          clearTimeout(timer);
          this.emitter.off("__dispatch__", listener);
          resolve(event as DomainEvent<TPayload>);
        }
      };
      this.emitter.on("__dispatch__", listener);
    });
  }

  /**
   * Internal — the OutboxPump calls this for each pending row it
   * drained. We emit on both the type-specific channel (for
   * subscribe()) and the dispatch channel (for waitFor()).
   */
  dispatch(event: DomainEvent): void {
    this.emitter.emit(event.event_type, event);
    this.emitter.emit("__dispatch__", event);
  }

  /** Subscribe to handler errors that escaped the pump. */
  onHandlerError(listener: (err: unknown, event: DomainEvent) => void): Subscription {
    this.emitter.on("__bus_error__", listener);
    return {
      event_type: "__bus_error__",
      unsubscribe: () => {
        this.emitter.off("__bus_error__", listener);
      },
    };
  }
}

// ── Conversion ────────────────────────────────────────────────────────

function toOutboxRow(event: DomainEvent): OutboxInsert {
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    event_version: event.event_version,
    occurred_at: new Date(event.occurred_at),
    tenant_id: event.tenant_id,
    actor_id: event.actor_id,
    change_set_id: event.change_set_id ?? null,
    dedup_key: event.dedup_key ?? event.event_id,
    trace: event.trace ? JSON.stringify(event.trace) : null,
    payload: JSON.stringify(event.payload),
  };
}
