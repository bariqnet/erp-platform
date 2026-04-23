# apps/kernel — Application Kernel Service

## Purpose

A standalone service that resolves metadata on demand. Owns the **L2
Redis cache** and the in-process **L1 LRU** (RFC §5.3). Subscribes to
`metadata.change_set_deployed` events and evicts L1 entries on receipt
— RFC §5.4, propagation p95 < 500 ms across the fleet.

Exposes `POST /internal/resolve` returning resolved metadata for a
`(tenant, object)` pair, plus `/healthz`, `/readyz`, and
`/docs/openapi.json`.

## Boundaries

**Imports:** `@erp/core`, `@erp/metadata`, `@erp/kernel-runtime`,
`@erp/db`, `@erp/events`, `@erp/telemetry`. The Redis client is the
only infra it instantiates directly (in `src/cache.ts`, constructed
by `src/server.ts`).

**Must never import:** `apps/api`, `@erp/ui-kit`. Kernel is a
back-of-the-house service; the public API surface lives in `apps/api`.

## Wiring

Everything is assembled in `src/server.ts`'s `buildKernel()` —
CLAUDE.md §7 non-negotiable #11:

1. Logger (silent in tests via `input.logger`).
2. Kysely (`createDatabase` or injected `input.db`).
3. `KernelCache` — L1 + optional L2.
4. `MetadataObjectRepository` — the `MetadataStore` the resolver reads
   through.
5. `ResolveService` — glues cache + repo + logger + tracer.
6. `CacheInvalidator` — polls `metadata.meta_outbox`.
7. Fastify app + plugins (telemetry, errors, openapi) + routes
   (`/healthz`, `/readyz`, `/internal/resolve`).
8. Returns a `KernelHandle` whose `close()` reverses the above.

## Patterns

- **Tenant-prefixed cache keys** — `${tenantId}::${objectId}` so
  invalidation can sweep all of a tenant's entries with a single
  prefix loop (L1) + `SCAN MATCH` (L2). L2 keys additionally carry
  the configurable `redisKeyPrefix` (default `erp:kernel:`).
- **Read-only outbox poller** — the `CacheInvalidator` never flips
  `delivered_at` on the outbox row. The worker app's `OutboxPump`
  owns delivery semantics. The kernel is a **fan-out listener**:
  every kernel instance keeps its own cursor (`lastSeenPk`) and
  reacts to every tenant's deploy events, regardless of what the
  pump has or hasn't delivered. That's how N kernels all see the
  same invalidation without coordinating.
- **Cold-start safety** — `initCursor()` sets `lastSeenPk` to the
  current `max(outbox_pk)` at boot so a newly-started kernel never
  replays old deploy events. It reacts only to what happens *after*
  it came up.
- **Graceful L2 degradation** — if Redis is unreachable at boot or
  errors mid-flight, the cache sets `redis = null` and every
  subsequent op runs on L1 only. L1 stays correct; the SLO widens.
- **Every resolve emits a span** — `tracer.startActiveSpan("kernel.resolve")`
  wraps every call. No-op until an OTel SDK registers, which is
  CLAUDE.md §2's Phase-1 contract (the SDK registration lands with
  the Grafana Cloud export wiring).

## Invariants

1. **Cache invalidation propagates across the fleet.** Verified by
   `test/integration/kernel.integration.test.ts`: two `buildKernel()`
   instances pre-warm their own L1, a deploy event lands in the
   outbox, both `drainOnce()` calls sweep the tenant, both next
   resolves come back `cache_status = miss`. RFC §5.4 SLO: p95 < 500 ms.
2. **The resolver itself stays pure** (`@erp/metadata`). Only this
   app knows about Redis or the outbox.
3. **No hand-crafted SQL against `metadata.meta_object` from the
   kernel.** Reads go through `MetadataObjectRepository`, which owns
   RLS posture and layer semantics.

## Known gotchas

- `KernelCache.redis` is deliberately `private redis: Redis | null`
  (not `readonly`). ioredis's `connect()` can fail asynchronously
  long after the constructor returns; on that failure we reassign to
  `null` and drop to L1-only. `readonly` would block the downgrade.
- The invalidator polls `metadata.meta_outbox` without `SET LOCAL` —
  it runs as the pooled `erp` role which bypasses RLS. That's
  intentional (it needs to see every tenant's events). Tests should
  not try to run the invalidator under a tenant context.
- The kernel has **no tenant-context plugin** and **no auth plugin**.
  Tenant lives in the body of every `/internal/resolve` call
  (that's how a single caller can resolve across tenants for
  vendor-level backfills). In production this is safe because
  `/internal/*` is not exposed to the internet — it's called only
  from apps/api over the private network.
- Tests set `startInvalidator: false` and drive `invalidator.drainOnce()`
  manually so assertions are deterministic. Production uses the
  250 ms poll loop.
