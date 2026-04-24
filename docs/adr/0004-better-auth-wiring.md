# 0004 — Better Auth Wiring

**Status:** Accepted. Supersedes [ADR-0002](./0002-better-auth-zod-4-deferral.md) with respect to the auth-wiring decision (Zod 4 migration is a separate concern, handled by [ADR-0003](./0003-zod-4-migration.md) and already done).

**Date:** 2026-04-24

## Context

[ADR-0002](./0002-better-auth-zod-4-deferral.md) deferred Better Auth integration pending a Zod 4 migration. The migration shipped in TASK-10.1a, and the `auth.*` schema landed in TASK-10.1b (migration `0005_auth.sql`, plus `metadata.user_tenant` with strict-tenant RLS). The wiring — the Fastify plugin that actually calls `better-auth` and replaces the dev-mode `x-user-id` / `x-user-roles` headers — is what TASK-10.1b.1 delivers.

Three non-trivial questions surfaced in the deferred work:

1. **Shared Kysely vs. separate instance.** Better Auth's `@better-auth/kysely-adapter` owns read/write on `auth.*` rows. The platform already has a shared Kysely instance in `apps/api` (injected via `server.ts`). A past wiring attempt tried `kyselyAdapter(sharedKysely, { type: "postgres" })` and hit `dialect.createDriver is not a function` — pointing at a version/shape mismatch, not a fundamental incompatibility.
2. **Schema-qualified table names.** Our tables live at `auth.user`, `auth.session`, etc. Better Auth's adapter defaults to unqualified names ("user", "session"). Three routes exist: set `search_path` on the pool, override `modelName` per model, or keep a separate Kysely instance pointed at the `auth` schema.
3. **Test-harness churn.** 115+ integration tests use the placeholder `x-user-id` / `x-user-roles` headers. Switching every test to a real Better Auth session in one commit is a ~1-day mechanical pass plus review — enough churn to deserve its own PR.

## Decision

### Summary

We wire Better Auth **against the shared Kysely instance**, **override `modelName` per model** so schema-qualified names reach Postgres, and **keep the placeholder header auth as a dev-only fallback** for one migration window. The dev fallback deletes once every test has migrated.

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│                     apps/api                               │
│                                                            │
│   ┌──────────────┐                                         │
│   │ server.ts    │ ← only place BA is instantiated         │
│   │              │                                         │
│   │  createAuth  │─────────┐                               │
│   └──────────────┘         │                               │
│                            ▼                               │
│   ┌──────────────┐   ┌──────────────────┐                 │
│   │ plugins/     │   │  @erp/auth       │                  │
│   │ auth.ts      │──▶│                  │                  │
│   │              │   │  createAuth()    │                  │
│   │ - mounts BA  │   │  resolveSession()│                  │
│   │   at /api/   │   │  createTest-     │                  │
│   │   auth/*     │   │    Session()     │                  │
│   │ - reads      │   └──────────────────┘                  │
│   │   session    │            │                            │
│   │   per req    │            ▼                            │
│   │ - dev-header │   ┌──────────────────┐                  │
│   │   fallback   │   │ kyselyAdapter    │                  │
│   │   (dev only) │   │ (@better-auth/   │                  │
│   └──────────────┘   │  kysely-adapter) │                  │
│           │          └──────────────────┘                  │
│           ▼                   │                            │
│   appContext.{userId,         ▼                            │
│   userRoles, tenantId}   shared Kysely                     │
└────────────────────────────────────────────────────────────┘
```

### Sub-decisions

- **Package `@erp/auth`** wraps Better Auth. Apps import only `@erp/auth`, never `better-auth` directly. Same pattern as `@erp/telemetry` for OTel. Lets us swap the backing library later without touching every app.
- **`modelName` overrides** set `auth.user`, `auth.session`, `auth.account`, `auth.verification`. Kysely resolves those as schema-qualified identifiers. Rejected alternatives: `search_path` on the shared pool (leaks into every query), separate Kysely instance (duplicates the connection pool, halves `max` for the app's real workload).
- **Multi-tenant session enhancement.** Better Auth's `Session` type carries `user.id` + `session.id` out of the box. Our session needs `tenantId` + `userRoles` (per-tenant). The plugin resolves this at request-time by joining `auth.session` → `auth.user` → `metadata.user_tenant`. The tenant is picked from the `x-tenant-id` request header (already validated by `tenant-context` plugin), matched against the user's memberships. A user with no membership in the requested tenant 403s.
- **Dev-mode header fallback** stays in `plugins/auth.ts` for the migration window. When no Better Auth session is present AND `NODE_ENV !== "production"` AND `x-user-id` is present, the plugin populates `appContext` from headers the same way the placeholder did. A warning log fires on every such request (`auth: dev-header fallback`). In production, the fallback is compiled out — the plugin returns 401 when no session resolves.
- **`createTestSession(handle, opts)` fixture** — `@erp/auth` exposes a helper that, given a `ServerHandle` + a tenant id + roles + a user id, inserts the relevant `auth.user` + `auth.session` + `metadata.user_tenant` rows directly via the shared Kysely, then returns a cookie string the test injects into `fastify.inject({ headers: { cookie } })`. No HTTP round-trip for the login form; the test pays only its own work. The helper is the path every integration test takes post-migration.
- **Console login form** swaps from the JSON dev cookie to `better-auth/react` or Better Auth's HTTP endpoints. `apps/console/lib/session.ts` reads the BA cookie; `apps/console/app/actions.ts`'s `loginAction` POSTs to `/api/auth/sign-in/email`. Existing dev users seeded with `pnpm db:seed` keep working — the seed gains a `createDevUser()` step that also creates a Better Auth account with a known password.

### Phasing

1. **This ADR + @erp/auth package + rewritten plugin + new integration test + console login swap** (TASK-10.1b.1 session 1 of 1 — landing in `feat(auth)` PR).
2. **Mechanical test-fixture migration** (TASK-10.1b.2). Every integration test in `apps/api/test/integration/` switches from `x-user-*` headers to `createTestSession(...)`. One PR per test file, small. When the last file migrates, remove the dev-header fallback from `plugins/auth.ts`.

Phase 1 splits this way because:

- The single big-bang approach has 115+ file diffs in one PR — painful to review, any mid-refactor syntax error blocks the whole thing.
- The dev-header fallback is compile-time removable (dead code behind `NODE_ENV`), so production is safe from day one of phase 1.
- Intermediate commits stay green — the test suite exercises both paths until the migration completes.

### Why shared-Kysely + modelName overrides

Rejected alternatives and their failure modes:

- **Separate Kysely instance pointed at `auth` schema only.** Doubles connection-pool allocation. Breaks single-transaction flows (user-tenant row insertions that need to be atomic with session creation). Adds a wiring site.
- **`SET search_path = 'auth', 'metadata', 'public'`.** Affects every query across the app. When the `ops` schema's tables grow, the resolution order becomes load-bearing in a way `SELECT * FROM user` silently depends on. Subtle cross-schema bugs get committed against this config.
- **Custom adapter** (re-implementing `kyselyAdapter`). High-effort, low-value. The built-in adapter with `modelName` is a 4-line diff; a custom adapter is 400 lines and we own its bugs.
- **Bun or Drizzle adapter.** Not in CLAUDE.md §2. Swapping the storage layer while landing the session layer mixes two unrelated decisions.

The shared-Kysely + `modelName` approach is explicitly called out as the target in ADR-0002's "Deliverables of TASK-10.1" section 2. This ADR makes that decision concrete.

### Security posture

- `BETTER_AUTH_SECRET` env var signs session cookies. Terraform's `secrets.tf` provisions an empty placeholder; the production bring-up runbook populates it via `openssl rand -hex 64`.
- Sessions are HTTP-only, `SameSite=Lax`, `Secure` in production (NODE_ENV gated). `SameSite=Strict` is too aggressive for the OAuth flows we may enable later.
- CSRF is Better Auth's built-in double-submit cookie — no additional middleware.
- Password hashing is bcrypt via Better Auth's defaults. Cost factor 10 (library default) — moderate; good enough for a Phase-1 pilot, tune for prod traffic in a Phase-4 hardening task.
- Multi-tenant tenant selection is **explicit**: the client sends `x-tenant-id`, the plugin validates the session has a membership for it. No "preferred tenant" sticky state on the session record. A user with two tenants switches by sending a different `x-tenant-id`. Guards against the "logged into the wrong tenant" class of bug RFC §10 warns about.

## Alternatives Considered

### Option B — `search_path` on the pool

Set `SET search_path TO auth, metadata, public, ops` in the Postgres pool's `afterConnect`. Better Auth's unqualified table names resolve via the first schema.

**Rejected.** Every query in the repo now depends on the search order. A future table name collision (e.g. an `ops.user` that sits under `auth.user` in the path) is silently wrong. The payoff — a 4-line `modelName` config we avoid — isn't worth the operational surface.

### Option C — Separate Kysely instance for auth

Construct a second Kysely instance in `server.ts` dedicated to the `auth` schema. Pass it into `kyselyAdapter`; keep the main Kysely for `metadata.*` / `ops.*`.

**Rejected.** Two pools per process (connection allocation). Cross-schema atomicity (a session write that also touches `metadata.user_tenant`) requires a two-phase commit we'd have to build. The schema boundary doesn't justify the infrastructure cost.

### Option D — Flip to Lucia or a custom minimal auth

Write ~500 lines of custom JWT + cookie + session store.

**Rejected for the same reasons as ADR-0002's Option C.** Multi-tenancy at the session layer is where custom auth fails. CLAUDE.md §9 — multi-tenancy is the one thing we cannot get wrong.

## Consequences

**Good**

- A single codepath — `@erp/auth.createAuth(...)` — replaces the placeholder.
- Test harness gets cleaner: `createTestSession` is one line per test setup.
- Production is safe from day one (NODE_ENV guard on the dev fallback).
- Future integrations (social login, MFA) plug in via Better Auth's plugin API without touching the plugin contract.

**Trade-offs accepted**

- Dev-header fallback in the plugin is intentionally ugly — it's meant to be removed. Every request that hits it logs a deprecation warning. When the deprecation log count hits zero for a week on staging, the fallback deletes.
- `createTestSession` writes directly to `auth.*` and `metadata.user_tenant`, bypassing Better Auth's validation. That's correct for tests (they're testing downstream, not BA itself). A mistake in the test helper would not be caught by BA's own test suite — documented in `packages/auth/CLAUDE.md`.
- Per-request session resolution adds one DB query to every request (the `user_tenant` join). Could move to a cached `Session` augmentation in a later pass; for now the simplicity beats the microsecond saved.

**Follow-ups**

- **TASK-10.1b.2** — mechanical test-fixture migration, one PR per file. Remove the dev-header fallback when the last file migrates.
- Rotate `BETTER_AUTH_SECRET` on a schedule once the pilot is live (Secrets Manager rotation, Phase-4 hardening).
- Tighten `SameSite` to `Strict` once the OAuth flows are audited and we're sure no cross-origin link-back path needs `Lax`.
- The seed script gains a deterministic demo user (`u_demo@erp.local` / password from env) so `pnpm db:seed` continues to produce a login the console can accept without manual setup.
