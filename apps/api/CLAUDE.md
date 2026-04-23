# apps/api — Fastify HTTP Service

## Purpose

Hosts both APIs at the edge:

- **Admin API** under `/admin/v1/*` — metadata CRUD and Change Sets
  (RFC §9.1)
- **Runtime API** under `/v1/*` — auto-derived endpoints from deployed
  Entity metadata (RFC §9.2)

Plus standard health endpoints (`/healthz`, `/readyz`) and the OpenAPI
spec at `/docs/openapi.json`.

## Boundaries

**Imports:** every `@erp/*` package except `@erp/ui-kit`. Includes
`@erp/kernel-runtime` — the materializer is a pure function (zero
infrastructure), and the Runtime API uses it in-process to derive
per-request Zod validators from resolved metadata. apps/kernel
remains a separate service for direct-kernel use cases (internal
tools, BI, the AI Specialist), but apps/api does its own in-process
resolve + materialize on the hot Runtime API path so there's no
extra network hop per customer/invoice/product request.

**Wiring rule:** Fastify, Kysely, Redis, Better Auth, the OTel SDK,
and pino are all instantiated **only** in `src/server.ts`. Every
other file in `apps/api` receives them via constructor parameters.
This is CLAUDE.md §7 non-negotiable #11.

**Layout (CLAUDE.md §3):**

| Directory | Purpose |
|---|---|
| `src/plugins/` | Fastify plugins: `auth`, `tenant-context`, `errors`, `telemetry`, `openapi`, `zod-validation` |
| `src/routes/admin/` | `/admin/v1/*` routes (metadata + Change Sets) |
| `src/routes/runtime/` | `/v1/*` auto-derived routes |
| `src/services/` | Business logic — pure where possible, `Result<T, E>` for expected failures |
| `src/repositories/` | Kysely-backed data access; every class extends `TenantRepository` |
| `src/schemas/` | Zod request/response schemas (one Zod object → runtime validation + TS type + OpenAPI) |
| `src/context.ts` | `RequestContext` carrying tenant, user, request id, trace id |
| `src/server.ts` | `buildServer()` factory — single wiring location |
| `src/index.ts` | Entry point — calls `buildServer().listen()` |

## Patterns

- **Routes are thin** — parse input with Zod, call a service, format
  output with Zod. Business logic never lives in a route handler.
- **Errors as RFC 7807** `application/problem+json`. One error format
  everywhere (CLAUDE.md §5).
- **Every request** carries `x-request-id`, generated if absent.
- **Every route** has a Zod schema registered in OpenAPI. Enforced by
  `scripts/verify.ts` invariant #2.
- See `docs/patterns/writing-a-route.md` (populated in TASK-09).

## Invariants

1. Fastify, Kysely, Redis, pino, OTel — all instantiated only in
   `server.ts`.
2. Every tenant-scoped query goes through `TenantRepository`. Direct
   Kysely against tenant tables is a bug (CLAUDE.md §7
   non-negotiable #4).
3. Every route module exports a Fastify plugin function whose
   `schema` option references a Zod schema imported from
   `src/schemas/`.

## Known gotchas

- `apps/api` populates progressively: TASK-09 (skeleton), TASK-10
  (Admin API), TASK-12 (Runtime API). TASK-01 ships only the wiring
  stub.
- The Runtime API Permission Gate denies **before** leaking entity
  existence: a request for `ent.ghost` from a caller without any
  grant returns 403, not 404. Tests that want to exercise the 404
  `entity_not_deployed` path must seed a broad permission first
  (see `test/integration/runtime-routes.integration.test.ts`).
- The materialized-entity cache (`MaterializedEntityCache`) is keyed
  on a hash of the resolver's full provenance stack, not the highest
  version number. When a tenant adds an L2 override for an entity
  whose L0 is at v1, the L2 row is also v1; `max(version)` would
  stay at 1 and the stale L0-only validator would still be served.
  `provenanceVersionKey()` in `services/runtime-entity-service.ts`
  hashes `<layer>:<version>` pairs so each unique stack yields a
  unique key.
