# apps/kernel — Application Kernel Service

## Purpose

A standalone service that resolves metadata on demand. Owns the **L2
Redis cache** and the in-process **L1 LRU** (RFC §5.3). Subscribes to
`metadata_deployed` events and evicts L1 entries on receipt — RFC
§5.4, propagation p95 < 500 ms across the fleet.

Exposes `POST /internal/resolve` returning resolved metadata for a
`(tenant, object)` pair.

## Boundaries

**Imports:** `@erp/core`, `@erp/metadata`, `@erp/kernel-runtime`,
`@erp/db`, `@erp/events`, `@erp/telemetry`. The Redis client is the
only infra it instantiates directly (in `src/server.ts`).

**Must never import:** `@erp/api`, `@erp/ui-kit`. Kernel is a
back-of-the-house service; the public API surface lives in `apps/api`.

## Patterns

- **Cache-key versioning** — every cache key includes the metadata
  version. New deploy = new key. Old key ages out (CLAUDE.md §7
  non-negotiable #6).
- **Cold-start pre-warm** — at startup, pre-warm the top-100 most-used
  entities per tenant (RFC §5.5).

## Invariants

1. Cache invalidation on `metadata_deployed` propagates within 500 ms
   across the fleet (RFC §5.4 SLO). Verified by the integration test
   in TASK-11.
2. The resolver itself stays pure (`@erp/metadata`) — only this app
   knows about Redis.

## Known gotchas

- Populates in **TASK-11**. TASK-01 ships only the scaffold.
