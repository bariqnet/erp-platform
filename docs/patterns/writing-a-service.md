# Pattern — Writing a Service

CLAUDE.md §5: services own business logic. Routes are thin; databases
are dumb. Services compose repositories, the EventBus port, and
domain primitives. Expected failures return `Result<T, E>`; truly
exceptional cases throw.

## When to use

- You are about to add business logic to a route handler — stop and
  put it in a service instead.
- You are coordinating two or more repositories.
- You are emitting domain events.
- You need to share the same workflow between the HTTP layer
  (apps/api), the worker (apps/worker), and the kernel (apps/kernel).

## The shape

A service is a class:

- **Constructor injection** for every dependency (repositories, the
  EventBus port, a clock). No globals, no static lookups.
- **Methods return `Result<T, E>`** for expected failures (validation,
  not-found, conflict). Throw only for programming errors and
  infrastructure outages (CLAUDE.md §5).
- **Stateless** — no per-instance mutable state. The DB connection
  pool inside the repository is the only shared mutable state, and
  it lives there, not in the service.
- **Thin** — services orchestrate; the heavy lifting belongs in the
  domain primitives (e.g., the `transition()` state machine in
  `@erp/change-set`) or the repository (the actual SQL).

## Canonical example — `ChangeSetService`

The TASK-10 service that wraps `ChangeSetRepository`. Lives in
[`apps/api/src/services/change-set-service.ts`](../../apps/api/src/services/change-set-service.ts).
Trimmed for the pattern doc:

```ts
import { type Operations, type TransitionActor } from "@erp/change-set";
import { Result, type Result as ResultT } from "@erp/core";
import {
  type ChangeSetRepoError,
  type ChangeSetRepository,
  type ChangeSetRow,
  type TransitionOutcome,
} from "@erp/db";

export type ServiceError =
  | ChangeSetRepoError
  | { readonly kind: "already_exists"; readonly change_set_id: string };

export interface CreateInput {
  readonly tenantId: string;
  readonly change_set_id: string;
  readonly description?: string;
  readonly created_by: string;
  readonly operations?: Operations;
}

export class ChangeSetService {
  constructor(private readonly repo: ChangeSetRepository) {}

  async create(input: CreateInput): Promise<ResultT<ChangeSetRow, ServiceError>> {
    try {
      await this.repo.create(input.tenantId, {
        change_set_id: input.change_set_id,
        created_by: input.created_by,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    } catch (err: unknown) {
      // Postgres UNIQUE violation — domain-level "already exists".
      if (isUniqueViolation(err)) {
        return Result.err({ kind: "already_exists", change_set_id: input.change_set_id });
      }
      throw err; // Programming or infra error — let it propagate.
    }

    if (input.operations !== undefined && input.operations.length > 0) {
      const r = await this.repo.addOperations(input.tenantId, {
        change_set_id: input.change_set_id,
        operations: input.operations,
      });
      if (Result.isErr(r)) return Result.err(r.error);
    }

    const loaded = await this.repo.load(input.tenantId, input.change_set_id);
    if (Result.isErr(loaded)) return Result.err(loaded.error);
    return Result.ok(loaded.value);
  }

  async transition(
    input: { tenantId: string; change_set_id: string; actor: TransitionActor },
    action: "propose" | "approve" | "deploy" | "rollback" | "revert",
  ): Promise<ResultT<TransitionOutcome, ServiceError>> {
    return this.repo.transition(input.tenantId, {
      change_set_id: input.change_set_id,
      action,
      actor: input.actor,
    });
  }
}
```

## Five conventions this example demonstrates

1. **Constructor injection.** `constructor(private readonly repo:
ChangeSetRepository)` — nothing else. The composition root
   (`apps/api/src/server.ts`) wires the actual repository in. Tests
   can pass a fixture repo of the same shape.

2. **Result<T, E> returns.** Every method returns
   `Promise<Result<T, ServiceError>>`. `ServiceError` is a
   discriminated union — including the underlying repository's
   `RepoError` plus service-level kinds (`already_exists`). The route
   handler does `Result.match(result, { ok, err })` and the err
   branch maps to RFC 7807 problem+json.

3. **`throw` is the exception.** The single `throw` here is the
   re-throw of an unknown DB error in the catch block. Postgres
   UNIQUE violation (code 23505) is a domain outcome — converted to
   `Result.err({ kind: "already_exists" })`. Anything else is a
   programmer or infra error and propagates.

4. **Composition over duplication.** `create` calls `addOperations`
   and `load` — three repository methods, one service method. The
   "atomic create-with-operations" workflow lives once, in the
   service, instead of being copied into every caller of the
   repository.

5. **No business state.** Every method takes everything it needs as
   parameters. There's no `this.currentTenantId` or
   `this.currentUser` — those would make the service unsafe to share
   across requests. Contrast with the route handler, which reads
   from `request.appContext` and passes it explicitly into the
   service.

## Where services live

| Where                       | Why                               |
| --------------------------- | --------------------------------- |
| `apps/api/src/services/`    | Used by HTTP routes               |
| `apps/worker/src/services/` | Used by event consumers           |
| `apps/kernel/src/services/` | Used by the resolver/materializer |

When the same service is used by two apps, factor it into a
package (e.g. `@erp/change-set` for the pure state machine, or a
new shared package). The HTTP-layer wrappers stay in `apps/api`.

## Verified by

- TASK-10 contract tests in [`apps/api/test/integration/admin-routes.integration.test.ts`](../../apps/api/test/integration/admin-routes.integration.test.ts)
  walk every Admin endpoint via fastify.inject(), exercising
  ChangeSetService + MetadataObjectService through the same path
  the production HTTP traffic takes.

## Anti-patterns

- **Fat handlers, thin services.** If a route handler does
  `await db.selectFrom(...).execute()` then computes something then
  emits an event — that's all business logic. Push it into a
  service.
- **Throwing for "not found".** Domain outcomes belong in
  `Result.err({ kind: "not_found" })`. `throw new NotFoundError()`
  forces every caller to deal with exception flow.
- **Stateful services.** A service that holds the current tenant
  on `this` is a singleton landmine — works fine in tests, races
  in production. Pass tenant_id (and every other request-scoped
  value) as a method argument.
- **Services that import Fastify.** A service should be runnable from
  the worker app or the kernel app without touching HTTP. If you
  reach for `FastifyRequest`, you've put route concerns in the wrong
  layer.
