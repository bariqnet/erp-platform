# @erp/events — EventBus

## Purpose

Phase 1 implementation of the `EventBus` port (declared in `@erp/core`):
in-process `EventEmitter` backed by a Postgres outbox table for
durability. CLAUDE.md §2 pins this — no external bus until Phase 2.

When Phase 2 swaps in NATS JetStream, the port stays the same; only the
adapter changes. Domain code never touches the bus directly.

## Boundaries

**Imports:** `@erp/core`. Postgres access goes through `@erp/db`,
which is added when this package needs it (TASK-08).

**Exports:** `InProcessEventBus` (implementation of `EventBus` from
`@erp/core`), the outbox-pump factory used by `apps/worker`, and
the dedup-key helpers.

## Patterns

- **At-least-once delivery** with dedup keys. Consumers must be
  idempotent.
- **Outbox-first**: events publish atomically with the writing
  transaction. The pump dispatches asynchronously.
- **Tenant-bound topics**: every event carries `tenant_id`; subscribers
  filter by it. Cross-tenant leakage is impossible by construction.

## Invariants

1. The bus implementation never appears in domain code (CLAUDE.md
   §2 — Events). Domain imports the port from `@erp/core`.
2. Events survive a process restart — proven by the integration test
   in TASK-08.

## Known gotchas

- This package populates in **TASK-05** (port shape) and **TASK-08**
  (in-process + outbox adapter). TASK-01 ships only the scaffold.
