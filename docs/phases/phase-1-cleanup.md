# Phase 1 Cleanup — Deferred items

These six tasks are Phase-1-scope work that was explicitly deferred
during the TASK-01 … TASK-13 sprint to keep each PR focused. They
block Phase 2 because the later phases assume the auth surface is
real (not placeholder), the audit chain is complete, the console can
create rows, observability ships telemetry somewhere, and deployment
works.

Order is recommendation, not hard dependency — any of these can start
in parallel with another if you have the bandwidth.

---

## TASK-10.1 — Better Auth integration + Zod 4 migration

Split into two sub-tasks because the Zod migration is the blocking
prerequisite and deserves its own commit trail.

### TASK-10.1a — Zod 3 → Zod 4 migration ✅ DONE

Shipped on main. See [ADR-0003](../adr/0003-zod-4-migration.md).
`pnpm verify` green; 113 integration tests pass on Zod 4.

### TASK-10.1b — Better Auth wiring (partial)

**Status:** Schema-layer done. Wiring layer deferred pending a
deliberate integration pass (see TASK-10.1b.1 below for the open
scope).

**Goal:** replace the placeholder `x-user-id` / `x-user-roles` header
auth with Better Auth (CLAUDE.md §2). Zod 4 is now in place
(TASK-10.1a), so Better Auth's peer-dep on `zod@^4.0.0` is satisfied.

**RFC anchor:** CLAUDE.md §2 (Auth stack), [ADR-0002](../adr/0002-better-auth-zod-4-deferral.md), [ADR-0003](../adr/0003-zod-4-migration.md).

**Done when:**

- [x] ~~`zod@catalog:` bumps to `4.x` in `pnpm-workspace.yaml`.~~ (TASK-10.1a, ADR-0003)
- [x] ~~ZodError.issues inspection sites compatible.~~ (TASK-10.1a; no changes needed — v4 kept the shape.)
- [x] ~~Every `z.record(value)` call.~~ (TASK-10.1a; all 14 sites were already 2-arg.)
- [x] ~~`@asteasolutions/zod-to-openapi` bumped.~~ (TASK-10.1a — now 8.5.0.)
- [x] ~~Round-trip tests in `@erp/core/src/*.test.ts` stay green on v4.~~ (TASK-10.1a — unmodified.)
- [x] ~~Migration 0005 `0005_auth.sql` creates the Better Auth tables
      in the `auth` schema + `metadata.user_tenant` with RLS.~~
      (Landed separately; no functional wiring yet — tables exist
      empty.)
- [x] ~~`@erp/db` exposes Kysely types for the new tables +
      `UserTenantRepository` for membership lookups.~~
- [x] ~~Kysely 0.28.16 bumped across the workspace (Better Auth's
      peer-dep track).~~
- [x] ~~**TASK-10.1b.1 — Better Auth wiring** (the hard integration):~~ **DONE** — see [ADR-0004](../adr/0004-better-auth-wiring.md). Shipped in one focused session (not 5-7; the upstream snag was the cookie-signature base64 flavor, which resolved in one iteration once the integration-test byte-diff surfaced it).
  - [x] ~~`packages/auth` package wraps `better-auth` with a multi-tenant session enhancer.~~ `@erp/auth` exports `createAuth`, `resolveSession`, `resolveTenantContext`, `createTestSession`.
  - [x] ~~`apps/api/src/plugins/auth.ts` mounts Better Auth at `/api/auth/*` and resolves sessions via the Fastify node handler adapter.~~ Real sessions resolve first; dev-header fallback kept for the migration window.
  - [x] ~~Reconcile Better Auth's kysely-adapter with our shared Kysely instance.~~ `kyselyAdapter(sharedKysely, { type: "postgres" })` directly as `database` works — the library's `DBAdapterInstance` type is the function signature the adapter returns.
  - [x] ~~Better Auth's `modelName: "auth.user"` routes correctly.~~ Kysely resolves the dotted name as a schema-qualified identifier. Verified end-to-end in the integration test.
  - [ ] **Deferred to TASK-10.1b.2**: migrate every admin + runtime integration test off dev-header auth onto `createTestSession`. 115+ tests; one PR per file. When the last file migrates, delete the dev-header fallback from `plugins/auth.ts`.
  - [ ] **Deferred to TASK-10.1b.2**: console login form → Better Auth endpoint; `lib/session.ts` reads the BA cookie instead of the JSON dev cookie.
  - [x] ~~ADR-0002 status flips to `Superseded by ADR-NNNN`.~~ Flipped; points at ADR-0004.

**Dependencies:** TASK-10.1b.1 unblocks TASK-10.1b.2 (the mechanical test migration) which in turn unblocks pilot-readiness of auth-sensitive surface area. Phase 2 tasks that don't touch auth are not blocked by 10.1b.2.

**Scope:** TASK-10.1b schema-layer (landed): ~1 session. TASK-10.1b.1 wiring (landed this round): ~1 session (ADR-0004 + @erp/auth + plugin rewrite + 5 integration tests + full-suite regression). TASK-10.1b.2 (test migration + console swap + fallback removal): ~3 sessions of mechanical refactor.

---

## TASK-14.1 — Backfill hash chain on Change Set audit rows ✅ DONE

**Goal:** existing Change Set audit writes (TASK-07) landed with
`before_hash` / `after_hash` = NULL. The new `AuditRepository`
(TASK-13.x) writes chained rows; the filter `WHERE after_hash IS NOT
NULL` keeps the two histories separate, but RFC §13.2 expects one
continuous chain. Close the gap.

**RFC anchor:** RFC §13.2.

**Done when:**

- [x] ~~`ChangeSetRepository.writeAudit()` delegates to
      `AuditRepository.appendInTx(trx, ...)` so every new change-set
      transition is chained.~~
- [x] ~~A one-shot migration script (`scripts/backfill-audit-chain.ts`)
      walks historical rows where `after_hash IS NULL`, recomputes
      each row's canonical payload + chain, and writes `before_hash`
      and `after_hash` in tenant order.~~ (`pnpm db:backfill-audit-chain`
      with optional `-- --dry`.)
- [x] ~~The script is idempotent (re-running is a no-op) and covers
      vendor-level rows (`tenant_id IS NULL`) as their own chain.~~
- [x] ~~Integration test asserts `verifyChain(TENANT)` returns `null`
      across the unified history after the backfill runs.~~
      (6 integration tests in `apps/api/test/integration/audit-
backfill.integration.test.ts`.)

**Dependencies:** none; independent of TASK-10.1.

**Scope:** ~150 lines + a migration script; 1 session. (Shipped.)

---

## TASK-14.2 — Runtime "Create row" UI in the console ✅ DONE

**Goal:** the console's Entities Explorer only PATCHes and DELETEs.
Add a "+ New" action that renders the derived `createValidator` shape
so admins can populate seeded entities through the UI.

**RFC anchor:** RFC §9.2.

**Done when:**

- [x] ~~`apps/console/app/entities/[entity]/new/page.tsx` renders the
      same `EntityForm` bound to an empty body with `required` fields
      visually marked.~~
- [x] ~~Submit POSTs to `/v1/:entity` via a new
      `createRowAction(entityId, formData)` Server Action.~~
- [x] ~~On success, redirects to `/entities/:entity/:newRowId`.~~
- [x] ~~400 validation errors surface inline per-field using the
      problem+json `errors[]` array.~~
- [x] ~~"New" link in the list page header (top-right).~~
- [ ] Playwright smoke test (see TASK-14.4) covers create → list.
      (Left for TASK-14.4 — Playwright harness doesn't exist yet.)

**Dependencies:** works against the placeholder auth; benefits from
TASK-10.1 landing first.

**Scope:** ~200 lines; 1 session. (Shipped.)

---

## TASK-14.3 — Grafana Cloud OTLP exporter wiring ✅ DONE

**Goal:** every service already creates spans via
`@erp/telemetry.createTracer()` but the exporter was the OTel default
NoOp. Register an OTLP HTTP exporter pointing at Grafana Cloud in
production, keep NoOp in dev + tests.

**RFC anchor:** RFC §14, CLAUDE.md §2 (Observability).

**Done when:**

- [x] ~~`packages/telemetry/src/otel-sdk.ts` exports
      `registerOtelSdk({serviceName, endpoint, headers})` that
      installs `NodeSDK` with the OTLP/HTTP trace exporter +
      OTLP metric exporter.~~ (Plus env-gated
      `registerOtelSdkFromEnv(serviceName)` for the apps to use.)
- [x] ~~`apps/api`, `apps/kernel`, `apps/worker` call it in
      `src/index.ts` **before** `buildServer/buildKernel/createWorker`
      (so spans from startup are captured), guarded by
      `GRAFANA_CLOUD_OTLP_ENDPOINT !== undefined`.~~
- [x] ~~`.env.example` gets the two Grafana variables. Secrets go in
      `.env` (gitignored), never in `.env.example`.~~
- [x] ~~Structured log lines carry `trace_id` / `span_id` by reading
      the active OTel context — they already carry `trace_id` from the
      W3C header; this adds span_id.~~ (New `otelContextMixin` wired
      into every `createLogger()` instance.)
- [x] ~~Integration test: spin up an in-memory OTLP collector (e.g.
      `@opentelemetry/exporter-trace-otlp-http` pointed at a local
      Fastify mock), make one request, assert the collector received
      spans with the expected `service.name` and trace-context.~~
      (`test/otel-sdk.integration.test.ts` — Fastify-backed mock with
      JSON payload assertions on service.name, scope name, span name,
      and attributes.)

**Dependencies:** none.

**Scope:** ~300 lines including tests; 1 session. (Shipped.)

---

## TASK-14.4 — Playwright E2E smoke ✅ DONE

**Goal:** one end-to-end scenario that clicks through the console
against a live stack. Guards against UI regressions that unit +
integration tests can't catch.

**RFC anchor:** CLAUDE.md §8 (Testing Strategy).

**Done when:**

- [x] ~~`apps/console/playwright.config.ts` + `apps/console/test/e2e/`
      directory seeded.~~ (Playwright 1.59.1; Chromium only; two
      projects — `setup` logs in and saves storage state, `chromium`
      runs scenarios with that state pre-loaded.)
- [x] ~~`pnpm --filter @erp/console test:e2e` runs the suite
      (new script).~~ (Plus `test:e2e:ui` for the inspector.)
- [x] ~~Scenario 1: login → list customers → open first row → PATCH
      loyalty_tier → assert the table reflects the change.~~
      (Assertion hardened: reload + select value + Raw JSON panel
      both confirm the PATCH persisted.)
- [x] ~~Scenario 2: locale toggle flips `<html dir="rtl">` and Arabic
      strings render.~~ (Checks `dir`, `lang`, and the Arabic label
      for "Entities"; flips back to LTR at the end so runs are
      idempotent.)
- [x] ~~CI job runs Playwright against the compose stack + migrate +
      seed + all three services (reuses the `dev:services` path).~~
      (`.github/workflows/e2e.yml` — Postgres 16 + Redis 7 via
      service containers, uploads HTML report + dev-services log on
      failure.)
- [x] ~~Turbo's `test:e2e` task depends on `build`.~~ (Already
      configured in `turbo.json`.)

**Dependencies:** none, but the login step still uses the dev cookie
(TASK-10.1b.1 will swap it for Better Auth).

**Scope:** ~350 lines (config + global-setup + setup + 2 scenarios +
CI workflow); 1 session. (Shipped.)

---

## TASK-14.5 — Production infra scaffold (Terraform + ECS Fargate) ✅ DONE (code); ⏳ operator bring-up pending

**Goal:** CLAUDE.md §2 pins ECS Fargate + RDS + ElastiCache + S3 in
Frankfurt. Today there is no Terraform. Lay down the minimum viable
single-region, single-AZ stack so "pilot this tenant" is a deploy
command instead of a yak-shave.

**RFC anchor:** CLAUDE.md §2 (Runtime + Cloud).

**Done when:**

- [x] ~~`infra/terraform/` created with:
  - `backend.tf` (S3 state bucket + DynamoDB lock table; wizard to
    bootstrap them once per account)
  - `vpc.tf` (VPC + public + private subnets + NAT)
  - `rds.tf` (Postgres 16, multi-AZ, encrypted, RLS-supporting)
  - `elasticache.tf` (Redis 7)
  - `s3.tf` (attachments bucket + versioning)
  - `ecs.tf` (cluster + three services: api, kernel, worker)
  - `ecr.tf` (one repo per service)
  - `alb.tf` (one public ALB in front of api, one internal for kernel)
  - `secrets.tf` (AWS Secrets Manager entries for DATABASE_URL,
    REDIS_URL, BETTER_AUTH_SECRET, GRAFANA_CLOUD_OTLP_HEADERS)~~
    (Plus `versions.tf`, `providers.tf`, `variables.tf`, `locals.tf`,
    `security-groups.tf`, `outputs.tf`, `staging.tfvars`,
    `prod.tfvars.example`, and a `bootstrap/` sub-module for the
    remote-state bucket.)
- [x] ~~`infra/docker/Dockerfile.api`, `Dockerfile.kernel`, `Dockerfile.worker` produce distroless or alpine-based images that `node dist/index.js` as a non-root user.~~ Alpine + tini + non-root `erp` user; multi-stage with `pnpm deploy --prod --legacy` to prune dev deps.
- [x] ~~`infra/docker/Dockerfile.console` (Next.js standalone output).~~
      (`next.config.mjs` now sets `output: "standalone"` with
      `outputFileTracingRoot` → monorepo root.)
- [x] ~~`.github/workflows/deploy.yml` builds images, pushes to ECR,
      updates the ECS service revisions on `main` merges.~~ (Plus a
      `terraform.yml` fmt/validate check on every PR touching
      `infra/terraform/**`.)
- [x] ~~`docs/runbooks/production-deploy.md` documents first-time setup
      (DNS, TLS cert via ACM, secrets population, `terraform apply`
      order, rollback via ECS revision pinning).~~ (Nine sections:
      bootstrap → first apply → secret population → first deploy →
      seed → DNS+TLS → Grafana OTLP → rollback → hardening +
      teardown.)
- [ ] **Staging environment brought up end-to-end once to prove the
      pipeline works; teardown recorded.** Requires AWS credentials
      (the one step Claude cannot do autonomously). Operator walks
      through the runbook once.

**Dependencies:** TASK-10.1 (auth needed before public IP — production
deploy can run HTTP-only until Better Auth lands; dev cookie still
works in that window), TASK-14.3 (observability wanted in prod from
day one — ✅ done).

**Scope:** ~1,500 lines of HCL + 4 Dockerfiles + two workflows + the
runbook; ~1 session for the code, a separate operator session for
the staging bring-up.

---

## Summary

| Task         | Title                                          | Scope  | Blocks                      |
| ------------ | ---------------------------------------------- | ------ | --------------------------- |
| TASK-10.1a   | Zod 3 → Zod 4 migration ✅ **done**            | 1 day  | unblocked 10.1b             |
| TASK-10.1b   | Better Auth schema layer ✅ **partial** landed | 1 day  | tables exist, no wiring yet |
| TASK-10.1b.1 | Better Auth wiring ✅ **done**                 | 1 day  | unblocks 10.1b.2            |
| TASK-10.1b.2 | Test-fixture migration + console login swap    | 3 days | prod auth hardening         |
| TASK-14.1    | Audit chain backfill ✅ **done**               | 1 day  | —                           |
| TASK-14.2    | Console create-row UI ✅ **done**              | 1 day  | —                           |
| TASK-14.3    | Grafana Cloud OTLP ✅ **done**                 | 1 day  | —                           |
| TASK-14.4    | Playwright E2E ✅ **done**                     | 1 day  | —                           |
| TASK-14.5    | Terraform + ECS deploy ✅ **code done**        | 1 day  | operator bring-up remains   |

**Remaining:** TASK-10.1b.2 (mechanical test migration + console login swap) + operator step for TASK-14.5. Everything else in Phase-1 scope is shipped. TASK-10.1b.1 landed in one focused session (ADR-0004 got the integration right first try after the cookie-signature encoding was surfaced by the integration test).
