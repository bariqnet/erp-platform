# apps/worker — Async Jobs

## Purpose

Long-running background process that owns:

- the **outbox pump** that drains the `meta_outbox` table and dispatches
  events into the in-process bus (TASK-08, RFC §11.3)
- **automations** triggered by events (Phase 1 keeps these simple;
  full automation engine is Phase 2)
- **custom-field migrations** (the storage-strategy migrator from
  RFC §6.1 / §11.3, throttled per tenant)
- the **compatibility harness** (Phase 2+ — pre-release validation
  of tenant scripts and extensions, RFC §7.4)

## Boundaries

**Imports:** `@erp/core`, `@erp/db`, `@erp/events`, `@erp/change-set`,
`@erp/telemetry`. No `apps/api` imports — this is a sibling, not a
dependent.

**Must never import:** Fastify. The worker has no HTTP surface
(beyond `/healthz`).

## Patterns

- **At-least-once delivery** with idempotent consumers. Dedup keys
  live in `@erp/events`.
- **Backfill throttling** respects per-tenant CPU/I/O budgets so a
  long-running migration cannot starve another tenant (RFC §11.3).

## Invariants

1. Every event handler is idempotent.
2. Long jobs honor a cooperative cancellation signal at well-defined
   checkpoints.

## Known gotchas

- Populates in **TASK-08** (outbox pump) and grows with each later
  task that emits events. TASK-01 ships only the scaffold.
