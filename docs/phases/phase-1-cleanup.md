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

### TASK-10.1b — Better Auth wiring

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
- [ ] Migration 0005 `0005_auth.sql` creates the Better Auth tables
      (users, sessions, accounts, verifications) in the `metadata`
      schema with RLS policies on every tenant-scoped table.
- [ ] `apps/api/src/plugins/auth.ts` replaced with a Better Auth
      Fastify adapter. Session carries `tenant_id` as a claim; the
      plugin maps it onto `request.appContext.{userId, userRoles,
tenantId}`.
- [ ] Every admin + runtime integration test that used
      `x-user-id` / `x-user-roles` headers now builds a real session
      via a `createSession(tenantId, roles)` test fixture.
- [ ] `apps/console/app/login/login-form.tsx` POSTs credentials to
      the Better Auth endpoint; `lib/session.ts` reads the Better
      Auth cookie instead of the JSON dev cookie.
- [ ] `apps/console/lib/api.ts`'s `authHeaders()` is replaced by
      passing the Better Auth cookie through on the server-side fetch.
- [ ] ADR-0002 status flips to `Superseded by ADR-NNNN` with the new
      ADR covering the completed migration.

**Dependencies:** TASK-10.1a done. Blocks TASK-14.2, TASK-14.5, and
most Phase 2 tasks that touch user-facing surface area.

**Scope:** TASK-10.1a was ~1 session (Zod 4 was less breaking than
feared). TASK-10.1b is ~2–3 sessions for the Better Auth wiring
(~300 lines of code + new migration + ~50 integration tests updating
their auth fixtures).

---

## TASK-14.1 — Backfill hash chain on Change Set audit rows

**Goal:** existing Change Set audit writes (TASK-07) landed with
`before_hash` / `after_hash` = NULL. The new `AuditRepository`
(TASK-13.x) writes chained rows; the filter `WHERE after_hash IS NOT
NULL` keeps the two histories separate, but RFC §13.2 expects one
continuous chain. Close the gap.

**RFC anchor:** RFC §13.2.

**Done when:**

- [ ] `ChangeSetRepository.writeAudit()` is replaced by a call to
      `AuditRepository.appendInTx(trx, ...)` so every new change-set
      transition is chained.
- [ ] A one-shot migration script (`scripts/backfill-audit-chain.ts`)
      walks historical rows where `after_hash IS NULL`, recomputes
      each row's canonical payload + chain, and writes `before_hash`
      and `after_hash` in tenant order.
- [ ] The script is idempotent (re-running is a no-op) and covers
      vendor-level rows (`tenant_id IS NULL`) as their own chain.
- [ ] Integration test asserts `verifyChain(TENANT)` returns `null`
      across the unified history after the backfill runs.

**Dependencies:** none; independent of TASK-10.1.

**Scope:** ~150 lines + a migration script; 1 session.

---

## TASK-14.2 — Runtime "Create row" UI in the console

**Goal:** the console's Entities Explorer only PATCHes and DELETEs.
Add a "+ New" action that renders the derived `createValidator` shape
so admins can populate seeded entities through the UI.

**RFC anchor:** RFC §9.2.

**Done when:**

- [ ] `apps/console/app/entities/[entity]/new/page.tsx` renders the
      same `EntityForm` bound to an empty body with `required` fields
      visually marked.
- [ ] Submit POSTs to `/v1/:entity` via a new
      `createRowAction(entityId, formData)` Server Action.
- [ ] On success, redirects to `/entities/:entity/:newRowId`.
- [ ] 400 validation errors surface inline per-field using the
      problem+json `errors[]` array.
- [ ] "New" link in the list page header (top-right).
- [ ] Playwright smoke test (see TASK-14.4) covers create → list.

**Dependencies:** works against the placeholder auth; benefits from
TASK-10.1 landing first.

**Scope:** ~200 lines; 1 session.

---

## TASK-14.3 — Grafana Cloud OTLP exporter wiring

**Goal:** every service already creates spans via
`@erp/telemetry.createTracer()` but the exporter is the OTel default
NoOp. Register an OTLP HTTP exporter pointing at Grafana Cloud in
production, keep NoOp in dev + tests.

**RFC anchor:** RFC §14, CLAUDE.md §2 (Observability).

**Done when:**

- [ ] `packages/telemetry/src/otel-sdk.ts` exports
      `registerOtelSdk({serviceName, endpoint, headers})` that
      installs `NodeSDK` with the OTLP/HTTP trace exporter +
      Prometheus metric reader or OTLP metric exporter.
- [ ] `apps/api`, `apps/kernel`, `apps/worker` call it in
      `src/index.ts` **before** `buildServer/buildKernel/createWorker`
      (so spans from startup are captured), guarded by
      `GRAFANA_CLOUD_OTLP_ENDPOINT !== undefined`.
- [ ] `.env.example` gets the two Grafana variables. Secrets go in
      `.env` (gitignored), never in `.env.example`.
- [ ] Structured log lines carry `trace_id` / `span_id` by reading
      the active OTel context — they already carry `trace_id` from the
      W3C header; this adds span_id.
- [ ] Integration test: spin up an in-memory OTLP collector (e.g.
      `@opentelemetry/exporter-trace-otlp-http` pointed at a local
      Fastify mock), make one request, assert the collector received
      spans with the expected `service.name` and trace-context.

**Dependencies:** none.

**Scope:** ~250 lines; 1 session.

---

## TASK-14.4 — Playwright E2E smoke

**Goal:** one end-to-end scenario that clicks through the console
against a live stack. Guards against UI regressions that unit +
integration tests can't catch.

**RFC anchor:** CLAUDE.md §8 (Testing Strategy).

**Done when:**

- [ ] `apps/console/playwright.config.ts` + `apps/console/test/e2e/`
      directory seeded.
- [ ] `pnpm --filter @erp/console test:e2e` runs the suite
      (new script).
- [ ] Scenario 1: login → list customers → open first row → PATCH
      loyalty_tier → assert the table reflects the change.
- [ ] Scenario 2: locale toggle flips `<html dir="rtl">` and Arabic
      strings render.
- [ ] CI job runs Playwright against the compose stack + migrate +
      seed + all three services (reuses the `dev:services` path).
- [ ] Turbo's `test:e2e` task depends on `build`.

**Dependencies:** none, but leans on TASK-10.1 so the login step is
against real auth.

**Scope:** ~400 lines (config + 2 scenarios + fixture helpers); 1–2
sessions.

---

## TASK-14.5 — Production infra scaffold (Terraform + ECS Fargate)

**Goal:** CLAUDE.md §2 pins ECS Fargate + RDS + ElastiCache + S3 in
Frankfurt. Today there is no Terraform. Lay down the minimum viable
single-region, single-AZ stack so "pilot this tenant" is a deploy
command instead of a yak-shave.

**RFC anchor:** CLAUDE.md §2 (Runtime + Cloud).

**Done when:**

- [ ] `infra/terraform/` created with:
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
    REDIS_URL, BETTER_AUTH_SECRET, GRAFANA_CLOUD_OTLP_HEADERS)
- [ ] `infra/docker/Dockerfile.api`, `Dockerfile.kernel`,
      `Dockerfile.worker` produce distroless or alpine-based images
      that `node dist/index.js` as a non-root user.
- [ ] `infra/docker/Dockerfile.console` (Next.js standalone output).
- [ ] `.github/workflows/deploy.yml` builds images, pushes to ECR,
      updates the ECS service revisions on `main` merges.
- [ ] `docs/runbooks/production-deploy.md` documents first-time setup
      (DNS, TLS cert via ACM, secrets population, `terraform apply`
      order, rollback via ECS revision pinning).
- [ ] Staging environment brought up end-to-end once to prove the
      pipeline works; teardown recorded.

**Dependencies:** TASK-10.1 (auth needed before public IP), TASK-14.3
(observability wanted in prod from day one).

**Scope:** ~1,500 lines of HCL + 3–4 Dockerfiles + workflow; 3–5
sessions. Largest single task in the cleanup list.

---

## Summary

| Task       | Title                               | Scope    | Blocks                        |
| ---------- | ----------------------------------- | -------- | ----------------------------- |
| TASK-10.1a | Zod 3 → Zod 4 migration ✅ **done** | 1 day    | unblocked 10.1b               |
| TASK-10.1b | Better Auth wiring                  | 2–3 days | almost everything user-facing |
| TASK-14.1  | Audit chain backfill                | 1 day    | compliance                    |
| TASK-14.2  | Console create-row UI               | 1 day    | demo completeness             |
| TASK-14.3  | Grafana Cloud OTLP                  | 1 day    | production readiness          |
| TASK-14.4  | Playwright E2E                      | 1–2 days | UI regressions                |
| TASK-14.5  | Terraform + ECS deploy              | 3–5 days | pilot launch                  |

**Remaining:** ~2 weeks of engineering at steady pace, before Phase 2
work begins. (TASK-10.1a landed ahead of schedule — Zod 4 was less
breaking than feared.)
