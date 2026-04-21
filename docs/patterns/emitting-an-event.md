# Pattern — Emitting an Event

> **Status:** Stub. Populated by **TASK-08** — in-process EventBus
> backed by a Postgres outbox.

## Problem

CLAUDE.md §2 (Events): in Phase 1, events are in-process via
`EventEmitter` plus a Postgres outbox table for durability.
Phase 2+ swaps in NATS JetStream behind the same `EventBus` port.
**Domain code never touches the bus implementation directly** —
always go through the port.

## When to emit an event

- A state change happens that _another component_ could care about
  (`metadata_deployed`, `change_set_approved`, `customer_created`,
  `invoice_posted`).
- An external integration needs to react asynchronously.

## When NOT to emit an event

- The reaction is purely internal to the same service (call the
  function directly).
- The event would only ever have one subscriber and that subscriber
  is in the same process and the same transaction (just call the
  function).

## Skeleton

The full pattern — outbox-write inside the same DB transaction,
worker-side pump, idempotent dedup keys, tenant-scoped topics — lands
with TASK-08.

## Verified by

- Integration test in TASK-08 proves events survive a process restart.
- The outbox-pump's at-least-once delivery assumes idempotent
  consumers — every consumer must check the dedup key before acting.
