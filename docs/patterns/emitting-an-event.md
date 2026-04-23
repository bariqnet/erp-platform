# Pattern — Emitting an Event

CLAUDE.md §2 (Events): in Phase 1, events are in-process via
`EventEmitter` plus a Postgres outbox table for durability. Phase 2+
swaps in NATS JetStream behind the same `EventBus` port. **Domain
code never touches the bus implementation directly** — always go
through the port.

## When to emit an event

- A state change happens that _another component_ could care about
  (`metadata.change_set_deployed`, `customer.created`,
  `invoice.posted`).
- An external integration needs to react asynchronously.

## When NOT to emit

- The reaction is purely internal to the same service (call the
  function directly).
- The event would only ever have one subscriber and that subscriber
  is in the same process and the same transaction (just call the
  function).

## The two publish surfaces

`OutboxBus` (the Phase 1 adapter in `@erp/events`) exposes two:

```ts
import { OutboxBus } from "@erp/events";
const bus = new OutboxBus(db);

// 1. Standalone — opens its own transaction.
//    Use from cron jobs, admin scripts, anywhere you don't already
//    hold a transaction.
await bus.publish(event);

// 2. Atomic with the caller's transaction (the outbox-with-data
//    pattern). Use from repository code that just wrote the data
//    the event describes — if the surrounding tx aborts, the outbox
//    row never appears.
await db.transaction().execute(async (trx) => {
  await repo.writeData(trx /* ... */);
  await bus.publishWithin(trx, event);
});
```

The second form is what makes "events survive a process restart"
work. The data write and the outbox INSERT share atomicity; either
both land or neither does.

## Building a DomainEvent

`@erp/core` defines the envelope. `@erp/change-set` ships factory
functions for every Change Set transition; do the same for any new
event type that has more than one publisher:

```ts
import { type DomainEvent } from "@erp/core";

const event: DomainEvent<{ customer_id: string }> = {
  event_id: crypto.randomUUID(),
  event_type: "customer.created",
  event_version: 1,
  occurred_at: new Date().toISOString(),
  tenant_id: ctx.tenantId,
  actor_id: ctx.userId,
  payload: { customer_id: row.id },
  // dedup_key defaults to event_id; set explicitly when you want
  // retries to collapse (e.g. one event per change_set deploy).
  dedup_key: `customer.created:${row.id}`,
};
```

`event_type` follows `<segment>.<segment>[.<segment>…]` — lowercase
identifiers separated by dots. `DomainEventSchema` enforces this at
parse time.

## Subscribing

```ts
const sub = bus.subscribe<{ customer_id: string }>("customer.created", async (event) => {
  // Idempotent! At-least-once delivery means you may see the same
  // event twice if your handler threw on the first attempt.
  await sendWelcomeEmail(event.payload.customer_id);
});

// Later, on shutdown:
sub.unsubscribe();
```

## Idempotency

The bus delivers **at-least-once**. Two distinct guarantees combine:

1. **Producer-side:** `dedup_key` UNIQUE on `meta_outbox` — a publish
   with a previously-seen dedup_key is a no-op (`ON CONFLICT DO
NOTHING`). Use a stable dedup_key when retries are likely.
2. **Consumer-side:** subscribers MAY see the same event twice if
   the pump dispatched but failed to flip `delivered_at` (process
   crash mid-batch). Subscribers should dedup on `event.event_id`
   (always unique) or on a domain-level natural key.

## How the pump works

`OutboxPump.drainOnce()`:

1. `SELECT … WHERE delivered_at IS NULL AND attempt_count < max FOR
UPDATE SKIP LOCKED LIMIT batchSize` — pulls a batch atomically.
   `SKIP LOCKED` lets multiple pumps share the load.
2. For each row, `bus.dispatch(event)` fans out to subscribers.
3. On success: `UPDATE … SET delivered_at = now() WHERE outbox_pk
= $`.
4. On failure: `UPDATE … SET attempt_count = attempt_count + 1,
last_error = $err`. The row stays pending until either the next
   drain succeeds or `attempt_count >= maxAttempts`, at which point
   it's effectively dead-lettered (use `pump.deadLettered()` to
   inspect).

`OutboxPump.start()` runs the loop. Tests use `drainOnce()` directly
so they can assert on per-batch behavior without a live timer.

## Verified by

- [`packages/events/test/integration/outbox-bus.integration.test.ts`](../../packages/events/test/integration/outbox-bus.integration.test.ts)
  — atomicity (aborted vs. committed tx), dedup_key collapse,
  pump delivery + idempotent re-drain, restart durability (fresh
  bus + pump picks up rows the previous bus published), and the
  failing-handler retry loop with a dead-letter cap.
