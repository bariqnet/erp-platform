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

**Imports:** every `@erp/*` package except `@erp/ui-kit` and
`@erp/kernel-runtime` (the kernel runtime is consumed via `apps/kernel`
over the internal API, not directly).

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
