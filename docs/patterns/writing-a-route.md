# Pattern — Writing a Fastify Route

CLAUDE.md §5: routes are thin. Parse input with Zod, call a service,
format output with Zod. Business logic never lives in a route handler.
Every route has a Zod schema registered in OpenAPI; errors are
RFC 7807 problem+json; every request has an `x-request-id`.

The plumbing for all of this is in `apps/api/src/plugins/*` and is
wired up by `buildServer()` in `apps/api/src/server.ts` — the single
place every dependency lives (CLAUDE.md §7 #11).

## The shape

Every route does four things:

1. **Defines its Zod schemas** — request inputs (params, query,
   body) and response shapes. Lives in `apps/api/src/schemas/<area>.ts`.
2. **Registers the route in the OpenAPI registry** — so
   `/docs/openapi.json` lists it with the right Zod-derived schemas.
3. **Parses inputs explicitly** via `parseBody`, `parseQuery`,
   `parseParams`. ZodErrors get caught by the errors plugin and
   returned as RFC 7807 with a structured `errors` array.
4. **Returns through `reply.code(N).send(body)`** with the body
   parsed through the response Zod schema (so the contract is
   enforced on the way out too).

## Canonical example — `/healthz`

The smallest real TASK-09 route is also the easiest to keep handy.
`apps/api/src/routes/health.ts`:

```ts
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { FastifyInstance } from "fastify";

import { HealthSchema } from "../schemas/health.js";

export interface HealthRouteWiring {
  readonly serviceName: string;
  readonly registry: OpenAPIRegistry;
  readonly startedAt: Date;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  wiring: HealthRouteWiring,
): Promise<void> {
  // 1. OpenAPI registration — the registry is the source of truth.
  wiring.registry.registerPath({
    method: "get",
    path: "/healthz",
    description: "Liveness probe — returns 200 as long as the process is alive.",
    tags: ["Health"],
    responses: {
      200: {
        description: "Process is up.",
        content: { "application/json": { schema: HealthSchema } },
      },
    },
  });

  // 2. The handler — thin, parses output through the Zod schema.
  app.get("/healthz", async (_req, reply) => {
    const body = HealthSchema.parse({
      status: "ok",
      service: wiring.serviceName,
      uptime_seconds: Math.floor((Date.now() - wiring.startedAt.getTime()) / 1000),
    });
    return reply.code(200).send(body);
  });
}
```

Notes:

- The handler takes nothing tenant-scoped, so `/healthz` is in the
  `DEFAULT_PUBLIC` list inside the auth + tenant-context plugins.
  Anything OUTSIDE that list requires `x-tenant-id` (and, when
  `authRequired: true`, `x-user-id`).
- The schema is the source of truth. `HealthSchema.parse()` on the
  way out fails loudly if the response shape drifts — better to
  catch a missing field at dev time than at the integration boundary.

## Tenant-scoped route — the typical case

```ts
// apps/api/src/routes/v1/customers.ts
import type { FastifyInstance } from "fastify";

import { parseParams, parseBody } from "../../plugins/zod-validation.js";
import {
  CustomerIdParamsSchema,
  UpdateCustomerBodySchema,
  CustomerSchema,
} from "../../schemas/customers.js";
import type { CustomerService } from "../../services/customer-service.js";

export interface CustomersRouteWiring {
  readonly registry: OpenAPIRegistry;
  readonly customers: CustomerService;
}

export async function registerCustomerRoutes(
  app: FastifyInstance,
  wiring: CustomersRouteWiring,
): Promise<void> {
  wiring.registry.registerPath({
    method: "patch",
    path: "/v1/customers/{id}",
    request: {
      params: CustomerIdParamsSchema,
      body: { content: { "application/json": { schema: UpdateCustomerBodySchema } } },
    },
    responses: {
      200: { description: "Updated.", content: { "application/json": { schema: CustomerSchema } } },
      404: {
        description: "Customer not found.",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  });

  app.patch("/v1/customers/:id", async (request, reply) => {
    const params = parseParams(request, CustomerIdParamsSchema);
    const body = parseBody(request, UpdateCustomerBodySchema);

    // Business logic lives in the service.
    const result = await wiring.customers.update(request.appContext.tenantId, params.id, body, {
      actor: request.appContext.userId,
    });

    return Result.match(result, {
      ok: (customer) => reply.code(200).send(CustomerSchema.parse(customer)),
      err: (kind) => mapErrToReply(reply, kind),
    });
  });
}
```

Notes:

- `request.appContext.tenantId` is set by the tenant-context plugin
  (already validated against `t_[a-z0-9_]{2,62}`).
- The service returns a `Result<T, E>`; the route maps it to an
  HTTP response via `Result.match`. The `err` branch goes through
  `mapErrToReply` which builds an RFC 7807 problem+json — see
  `docs/patterns/handling-errors.md`.
- Repository methods inside the service call `withTenantContext`
  themselves (RLS fires there); the route never opens a DB
  transaction.

## Verified by

- [`apps/api/test/integration/server.integration.test.ts`](../../apps/api/test/integration/server.integration.test.ts)
  — 12 contract tests via `fastify.inject()`: `/healthz`, `/readyz`,
  `/docs/openapi.json` shape, `x-request-id` round-trip,
  RFC 7807 404, tenant-context missing/invalid/valid header,
  auth required/unauthenticated/with-headers.
- `scripts/verify.ts` invariant #2 — every Fastify route registration
  has a `schema` option (currently vacuous; will fire when the first
  route ships with body validation in TASK-10).

## Anti-patterns

- **Business logic in the handler.** `app.get(..., async () => {
const rows = await db.selectFrom(...).execute(); /* compute */ })`
  — push the logic into a service; let the route be three lines.
- **Forgetting the OpenAPI registration.** A route that only exists
  in `app.get(...)` won't appear in `/docs/openapi.json`. Every
  client integration breaks silently. The lint will fail invariant
  #2 once it sees a real route without a schema.
- **Returning through `reply.send(rawObject)` without re-parsing.**
  Skipping the response-side `Schema.parse()` lets the contract
  drift; the SDK consumers find out before the test does.
- **Throwing for expected failures.** Use `Result.err(...)` and
  let the error envelope ship via `mapErrToReply`. See
  `docs/patterns/handling-errors.md`.
