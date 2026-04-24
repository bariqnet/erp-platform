# @erp/auth — Better Auth Wiring

## Purpose

The single place any service talks to `better-auth`. Wraps the
library's Kysely adapter with our schema mapping (tables live at
`auth.*`) and exposes a Fastify-friendly `resolveSession()` plus a
test fixture `createTestSession()`. Apps import from `@erp/auth`
only — **never** `better-auth` or `@better-auth/kysely-adapter`
directly.

See [ADR-0004](../../docs/adr/0004-better-auth-wiring.md) for the
full design rationale.

## Boundaries

**Imports:** `@erp/core`, `@erp/db`, `better-auth`,
`@better-auth/kysely-adapter`, `kysely`, `zod`.

**Must never import:** `fastify`, `pino`, `redis`, `next`. The
Fastify plugin lives in `apps/api/src/plugins/auth.ts`; this package
is framework-agnostic.

**Exports:**

- `createAuth(input)` — build the Better Auth server instance.
- `resolveSession(auth, req)` — extract + validate a session from
  request headers.
- `resolveTenantContext(db, session, tenantId)` — join against
  `metadata.user_tenant` to get the user's roles in the requested
  tenant.
- `createTestSession(db, opts)` — test fixture that directly writes
  `auth.*` + `metadata.user_tenant` rows and returns a cookie
  string.
- Type exports: `AuthInstance`, `ResolvedSession`, `TestSession`.

## Patterns

- **Schema-qualified table names** via Better Auth's `modelName`
  option (`auth.user`, `auth.session`, etc.). The shared Kysely
  instance resolves them as `schema.name` pairs. See ADR-0004 for
  why this over `search_path`.
- **Session resolution is per-request**, not cached. One join on
  every auth-required call: `auth.session → auth.user → user_tenant`
  filtered by the requested tenant. A future task can add a
  `Session.tenantContext` cache if profile data shows it matters.
- **`createTestSession` bypasses Better Auth's login flow.** It
  writes the rows directly so tests don't pay HTTP round-trip
  cost. The cookie it returns is a valid Better Auth session
  cookie signed with the test secret.

## Invariants

1. **No app or package imports `better-auth` directly.** Enforced
   by a scripts/verify.ts check (follow-up task; for now it's
   documented here and in ADR-0004).
2. `BETTER_AUTH_SECRET` must be non-empty when `createAuth` is
   called with `required: true`. Absent in dev: a well-known dev
   secret fires with a log warning.
3. `createTestSession` refuses to run when `NODE_ENV === "production"`.
   The helper writes cookies that any request can steal — tests only.

## Known gotchas

- Better Auth's `modelName: "auth.user"` is interpreted by
  `@better-auth/kysely-adapter` as a Kysely table reference. The
  adapter calls `db.selectFrom("auth.user")` which Kysely resolves
  to the schema-qualified identifier. If you see
  `relation "auth.user" does not exist` errors, it means Kysely is
  quoting the whole string rather than splitting on `.`. Our
  `packages/db/src/schema.ts` uses the same `"auth.user"` convention
  elsewhere, so the tooling is consistent.
- The `better-auth@1.6.8` package peer-depends on `zod@^4.0.0` —
  satisfied by the Zod 4 migration (TASK-10.1a). If a future
  `pnpm install` downgrades Zod, the adapter's runtime validation
  will fail at request time, not at install time.
