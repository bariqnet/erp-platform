# 0002 — Better Auth Integration Deferred Pending Zod 4 Migration

**Status:** Accepted
**Date:** 2026-04-23

## Context

CLAUDE.md §2 pins [Better Auth](https://www.better-auth.com/) as the
authentication layer for the platform:

> **Authentication** — **Better Auth** — TypeScript-native,
> self-hosted, first-class multi-tenancy. Sessions stored in Postgres
> (same DB); no additional infra

TASK-10's "Done when" list originally included Better Auth
integration: the Admin API's role checks would be driven by a real
Better Auth session with `metadata.write` / `metadata.approve` /
`metadata.deploy` privileges.

When TASK-10 landed, the integration hit a blocking dependency
conflict:

- **Better Auth 1.2.x** peer-depends on **`zod@^4.0.0`**.
- **`@erp/core`** and every package that validates at the edge depend
  on **`zod@3.24.2`** (pinned in `pnpm-workspace.yaml` → `catalog:`).
- **`@asteasolutions/zod-to-openapi@7.3.0`** — used by `apps/api` and
  `apps/kernel` for OpenAPI generation — requires Zod v3's API.

Zod 3 and Zod 4 are **not API-compatible**. Published breaking
changes include:

- Error structure (`ZodError.issues` shape, `path` semantics) has
  changed — every `.parse()` call site that inspects issues is
  affected.
- `z.record()` signature changed (requires explicit key type in v4).
- Several method removals (`.nonstrict()`, `.deepPartial()`) and
  discriminated-union internals.
- `.openapi()` extension mechanism differs — `zod-to-openapi` v7 will
  not work against Zod v4.

The monorepo currently has **29 non-dist source files** that `import
… from "zod"`, spread across `@erp/core`, `@erp/change-set`,
`@erp/events`, `apps/api`, `apps/kernel`, and `apps/worker`. Every
one of them is exercised on the request hot path or in Change Set
deploys. A Zod-3 → Zod-4 migration is therefore the biggest
infrastructure change the codebase can absorb without breaking a
core domain invariant.

TASK-10 unblocked itself by shipping a **dev-mode placeholder auth**
— the `auth` plugin accepts `x-user-id` and `x-user-roles` headers
instead of a real Better Auth session. The placeholder:

- passes every TASK-10 contract test;
- is _explicitly_ documented as not production-ready in
  `apps/api/src/plugins/auth.ts`;
- refuses requests without a user header when `authRequired: true`
  (used in integration tests).

Phase 1 shipped with this placeholder. Phase 1's pilot tenant is
internal, so the placeholder is acceptable for the next 6 weeks; a
production cutover to external customers requires a real auth layer
before launch.

This ADR records **why** Better Auth did not land in Phase 1 and
**which path** we take when the integration resumes.

## Decision

### Summary

We defer Better Auth integration to a dedicated follow-up task
("TASK-10.1") whose first deliverable is the **Zod 3 → Zod 4
migration across `@erp/core`, `@erp/change-set`, `@erp/events`,
`apps/api`, `apps/kernel`, and `apps/worker`**, plus a version bump
of `@asteasolutions/zod-to-openapi` to a Zod-4-compatible release.
Better Auth wiring is the second step, once Zod 4 is green.

This is **Option A: bump Zod** below. The placeholder auth in
`apps/api/src/plugins/auth.ts` remains in place until then and is
the only allowed authentication surface. No new code depends on
Better Auth symbols.

### Deliverables of TASK-10.1 (when it runs)

1. **Zod 4 migration PR**, serial, small commits per package:

   - Start at `@erp/core` (the dependency root), work outward.
   - Every `ZodError.issues` inspection site migrates to the v4
     shape. `apps/api/src/plugins/errors.ts` and
     `apps/kernel/src/plugins/errors.ts` each touch this.
   - `z.record(string, unknown)` — add the key-type argument
     everywhere it's used.
   - Replace any `.nonstrict()` / `.deepPartial()` / removed APIs.
   - Update round-trip tests for every schema in `@erp/core`.
   - Update `@asteasolutions/zod-to-openapi` to the Zod-4 release
     — verify `extendZodWithOpenApi(z)` still sits in
     `apps/api/src/openapi-registry.ts` and
     `apps/kernel/src/openapi-registry.ts`.

2. **Better Auth wiring**, in `apps/api`:

   - Replace the placeholder `auth` plugin with Better Auth's
     Fastify adapter.
   - Better Auth tables migrate via a new SQL file (`0005_auth.sql`)
     in the same Kysely migrator, in the same `metadata` schema
     (or a new `auth` schema if cleaner).
   - Session cookie flow, CSRF, secure/http-only defaults, same-
     origin + CORS policy driven by env.
   - Multi-tenant session claim contains `tenant_id` + roles; the
     `auth` plugin maps it to `appContext.{userId, userRoles}`.
   - Every `admin-routes.integration.test.ts` scenario that uses
     `x-user-id` / `x-user-roles` headers switches to an authenticated
     session fixture (`createSession(tenantId, roles)`).

3. **`pnpm verify` stays green** throughout. The migration runs on a
   feature branch with the two commits separated so a mid-way red
   build is isolated.

### Why option A

Three options were on the table; see below. Option A wins because:

- **Better Auth** is what CLAUDE.md §2 pins. Deviating requires a
  stack ADR to overturn §2, and the upstream ecosystem (Fastify
  plugins, Next.js `better-auth/client` hooks, Arabic/RTL login
  flows we get for free) is worth the migration cost.
- **Zod 4** is the upstream's active track. Pinning to an older
  Better Auth release or an internal fork recreates the "bitrot
  vendor library" problem that RFC §11.2 deprecation policy is
  meant to avoid.
- **The 29 import sites** look large but are concentrated in
  `@erp/core` (17 files) and are all schema-first. The per-file
  diff is small — most files need only the `z.record()` key-type
  addition and a `ZodError.issues.map()` shape tweak.
- **CI is the safety net**: property tests in
  `packages/metadata/src/resolve.property.test.ts` and the 91
  integration tests across apps/api, apps/kernel, packages/db,
  packages/events will fail loudly on any behavior change. The
  migration is reversible (revert the PR) up until Better Auth
  tables land in a migration.

## Alternatives Considered

### Option B — Pin Better Auth to a Zod-3-compatible version

Find a Better Auth release that still supports Zod 3 (the 1.0.x line
did, before the 1.1.x Zod-4 peer-dep bump). Pin and freeze.

**Rejected** because:

- 1.0.x has an open CVE fix cadence we would lose by pinning.
- RFC §11.2's deprecation policy forbids running "deprecated
  dependencies more than two major versions behind" — pinning
  violates our own rule.
- Security updates for a multi-tenant auth surface are the one
  dependency category we cannot freeze. Bariq explicitly flagged
  this when the dependency pin was first raised.

### Option C — Write a minimal custom auth layer

A JWT-session implementation we own outright. Fastify plugins for
login, refresh, logout, and role mapping. Tables for users, sessions,
role assignments. Maybe 500 lines.

**Rejected** because:

- CLAUDE.md §15 "don't reach for clever abstractions" — this is the
  clever abstraction.
- Multi-tenancy at the session layer is the exact feature Better
  Auth ships and the one we would get most wrong writing from
  scratch. Every custom auth we've seen leaks a cross-tenant session
  in its first year.
- CLAUDE.md §9's "multi-tenancy is the one thing we must not get
  wrong" makes this the worst category for DIY.

### Option D — Replace Zod with a different validator (Valibot, ArkType)

Swap Zod entirely so we don't depend on the 3→4 transition at all.

**Rejected** because:

- CLAUDE.md §2 pins Zod. Changing the stack here requires overturning
  §2 in a separate ADR and bumps 29 source files anyway.
- `@asteasolutions/zod-to-openapi` is the specific integration that
  feeds our OpenAPI registry; no equivalent exists for Valibot or
  ArkType at the maturity level we need.
- The migration effort is comparable to Option A (touch the same 29
  files), but with no ecosystem upside — Zod 4 improves performance
  and ergonomics; a swap trades a known cost for unknown ones.

## Consequences

**Good**

- Phase 1 shipped with 91 integration tests green without blocking on
  a dependency upgrade.
- The placeholder auth's boundaries are explicit in one file
  (`apps/api/src/plugins/auth.ts`) — the surface area to replace is
  small.
- When Zod 4 lands, every package that imports it picks up the
  improved performance (Zod 4 is ~10× faster in benchmarks). The
  Runtime API's per-request `materialize + validate` path benefits
  directly.

**Trade-offs accepted**

- Phase 1's pilot tenant is internal-only. The pilot launch date
  (6 weeks per CLAUDE.md §1 "go-live in under six weeks") does not
  require Better Auth; external customer onboarding does.
- Every Admin API integration test uses `x-user-id` / `x-user-roles`
  headers. When Better Auth lands, every such header in
  `apps/api/test/integration/admin-routes.integration.test.ts` (and
  `seed.integration.test.ts`, `runtime-routes.integration.test.ts`)
  becomes a session fixture. That churn is bounded and mechanical.
- The CHANGELOG carries a running "Better Auth deferred" note on
  TASK-10 and TASK-12 entries. It is redundant once this ADR is
  linked.
- CVE exposure on the placeholder auth is limited by the fact that
  nothing in production routes to `apps/api` publicly during Phase 1.
  If that changes before TASK-10.1 runs, the placeholder auth is
  pulled entirely and every `/admin/*` and `/v1/*` request 401s.

**Follow-ups**

- **TASK-10.1** is on the backlog with this ADR as its primary
  reference. Owner: Claude Code; reviewer: Bariq.
- The CHANGELOG's "Better Auth deferred" notes under TASK-10 and
  TASK-12 can be trimmed to `see ADR-0002`.
- When TASK-10.1 lands, a third commit updates this ADR's Status to
  `Superseded by ADR-NNNN` where ADR-NNNN documents the completed
  migration.
- The Zod 4 migration is also a good moment to review whether the
  [`zod-to-openapi` v7](https://github.com/asteasolutions/zod-to-openapi)
  → its Zod-4-compatible successor still fits, or whether the
  OpenAPI generation should switch to a first-party solution.
