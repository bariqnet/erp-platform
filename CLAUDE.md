# CLAUDE.md — ERP Platform Project Brief

> **You (Claude Code) are the entire engineering team for this project.**
> This file is the single source of truth. Read it fully before every session.
> Re-read it before every architectural decision. When in doubt, defer to this file.

---

## 0. How to Use This File

You are building a **metadata-driven, multi-tenant ERP platform** for the MENA market. The design, stack, and delivery plan are **already decided** — they are specified below. Your job is to implement them correctly, not to redesign them.

**The stack in this file has been chosen specifically to optimize for AI-agent engineering.** Every choice here exists because it produces correct, debuggable code on the first try. When you're tempted to reach for a more "modern" or "elegant" alternative, stop: the boring choice is the correct one, on purpose.

**The seven golden rules:**

1. **Do not re-litigate architecture.** If a decision is in this file, it's final. Propose changes as a diff to this file in a separate PR, before writing contradicting code.
2. **Read the RFC.** The full technical spec is in `docs/rfc/ERP-RFC-001.md`. Any behavior not spelled out below is specified there.
3. **Read the package-level `CLAUDE.md`.** Every major package has its own. Read it before editing any file in that package.
4. **Read `docs/patterns/` before writing new code.** The house style is documented there with runnable examples. Match it.
5. **Run `pnpm verify` before every commit.** Green or red — no commits on red.
6. **Small, single-purpose PRs.** Target 200–400 lines. Break up larger work.
7. **Tests are not optional.** No feature merges without tests. Property tests for the resolver. Integration tests with real Postgres via Testcontainers. No mocks where real services can run.

---

## 1. Mission

Build an ERP platform that lets a mid-market MENA business go from signup to a working, industry-shaped, Arabic-native ERP in **under one hour**, then guided by an AI Implementation Specialist to a go-live configuration in **under six weeks**, on a single codebase that is **upgrade-safe forever** because all tenant customization lives in metadata layers, not in forked code.

**Three pillars:**

- **Customization Platform** — five-layer metadata model, Application Kernel, Change Sets (RFC-001)
- **AI Implementation Specialist** — agent that replaces the six-figure consultant (future RFC-002)
- **Industry Templates Library** — ready-to-run MENA-first vertical packs (future RFC-003)

**This file covers Phase 1 = the Customization Platform core.** Other pillars are out of scope for the first five months.

---

## 2. Locked-In Tech Stack

These are decided. They have been chosen specifically because they produce correct code when written by an AI agent: large training-data footprint, minimal magic, self-explaining errors, stable APIs.

### Language
- **TypeScript 5.x** with strict mode maxed out (see §5 for exact flags)
- **Node.js 20 LTS**
- **Python 3.12** only for data/ML utility scripts, never for core services

### Backend
- **Fastify 4.x** as the HTTP framework. No NestJS. No magic decorators. Explicit plugins, explicit route handlers.
- **Convention-based folder structure** (§3) — no DI container, constructor injection only
- **Kysely** as the only database query layer — covers both static metadata tables and dynamic tenant entity tables
- **Zod** for every schema, every validation, every DTO — one definition → runtime validation + TypeScript types + OpenAPI

### Databases & Caching
- **PostgreSQL 16+** — two schemas: `metadata` and `ops` (see RFC §1.3)
- **Redis 7+** via **ioredis** — L2 cache for the Application Kernel
- **OpenSearch 2.x** for full-text search (used more heavily in Phase 2+ for the AI retriever)

### Frontend
- **Next.js 14+ App Router** — stable features only (no Parallel Routes, Intercepting Routes, or other experimental patterns)
- **React Server Components** for data fetching; **Client Components** at the interaction boundary. No creative mixing.
- **Tailwind CSS** + **shadcn/ui** (components copied into the repo, not imported)
- **TanStack Query** for server state, **Zustand** for local UI state
- **i18next** with RTL-first layout — Arabic is a primary language

### Events
- **Phase 1**: in-process `EventEmitter` + **Postgres outbox table** for durability. No external bus.
- **Phase 2+**: the `EventBus` port stays the same; a NATS JetStream adapter replaces the in-process one when cross-service events are actually needed
- **Domain code never touches the bus implementation directly** — always go through the port

### Authentication
- **Better Auth** — TypeScript-native, self-hosted, first-class multi-tenancy
- Sessions stored in Postgres (same DB); no additional infra

### Runtime
- **Docker** images, **ECS Fargate** in production, **docker-compose** locally
- 12-factor config (env vars only). Kubernetes deferred to Phase 4.

### Cloud
- **AWS eu-central-1 (Frankfurt)** — closest to Iraq with solid compliance posture
- **RDS for PostgreSQL** (managed), **ElastiCache for Redis**, **ECS Fargate** for services, **S3** for attachments

### Observability
- **OpenTelemetry** SDK in every service — traces, metrics, logs
- **Grafana Cloud** as the backend (hosted; free tier sufficient for Phase 1)
- Structured JSON logs via **pino**
- No self-hosted Prometheus/Loki/Tempo in Phase 1 — one less thing to operate

### Tooling
- **pnpm 9.x** + **Turborepo** for monorepo orchestration
- **ESLint + Prettier** for lint/format (not Biome — larger training data footprint)
- **Vitest** for unit and integration tests
- **Playwright** for end-to-end tests
- **Testcontainers** for integration tests against real Postgres, Redis, OpenSearch
- **fast-check** for property-based tests on the resolver
- **Kysely migrator** for database migrations (plain SQL files, versioned)
- **GitHub Actions** for CI
- **Renovate** for automated dependency updates (patch auto-merge, minor/major manual)

---

## 3. Repository Structure

Monorepo. pnpm workspaces. Turborepo orchestration. **No DI container** — plain constructor injection, wired up in each app's entry point.

```
erp-platform/
├── apps/
│   ├── api/                      # Fastify HTTP service (Admin API + Runtime API)
│   │   ├── src/
│   │   │   ├── plugins/          # Fastify plugins: auth, tenant-context, errors, telemetry
│   │   │   ├── routes/           # Route modules grouped by domain
│   │   │   │   ├── admin/        # /admin/v1/* endpoints
│   │   │   │   └── runtime/      # /v1/* auto-derived endpoints
│   │   │   ├── services/         # Business logic (uses core + repositories)
│   │   │   ├── repositories/     # Kysely-backed data access
│   │   │   ├── schemas/          # Zod request/response schemas
│   │   │   ├── context.ts        # RequestContext (tenant, user, traceId)
│   │   │   ├── server.ts         # buildServer() factory — all wiring lives here
│   │   │   └── index.ts          # Entry point
│   │   ├── test/
│   │   └── CLAUDE.md             # ← package-level brief
│   │
│   ├── kernel/                   # Application Kernel (metadata resolver + materializer)
│   │   └── CLAUDE.md
│   ├── worker/                   # Async jobs: automations, migrations, compat harness
│   │   └── CLAUDE.md
│   └── console/                  # Next.js admin console
│       └── CLAUDE.md
│
├── packages/
│   ├── core/                     # Pure domain — zero infrastructure imports
│   │   ├── src/
│   │   │   ├── entity.ts         # Entity type + Zod schema
│   │   │   ├── field.ts
│   │   │   ├── relationship.ts
│   │   │   ├── permission.ts
│   │   │   ├── localization.ts
│   │   │   ├── envelope.ts
│   │   │   ├── ports/            # Interfaces (EventBus, MetadataStore, Clock)
│   │   │   └── result.ts         # Result<T, E> for error-as-value patterns
│   │   └── CLAUDE.md
│   │
│   ├── metadata/                 # Resolver algorithm + merge strategies + conflict detection
│   │   └── CLAUDE.md
│   ├── kernel-runtime/           # Materialization, caching, entity compilation
│   │   └── CLAUDE.md
│   ├── change-set/               # State machine + impact analyzer + deploy orchestration
│   │   └── CLAUDE.md
│   ├── db/                       # Kysely types, migrations, TenantRepository base class
│   │   └── CLAUDE.md
│   ├── events/                   # EventBus port + in-process adapter + outbox table
│   │   └── CLAUDE.md
│   ├── telemetry/                # OTel setup, pino logger, metric helpers
│   │   └── CLAUDE.md
│   ├── i18n/                     # Arabic/English primitives, RTL utilities
│   ├── ui-kit/                   # shadcn/ui components (RTL-aware)
│   └── config/                   # Shared tsconfig, eslint config, prettier config, vitest preset
│
├── docs/
│   ├── rfc/
│   │   └── ERP-RFC-001.md        # The full technical spec
│   ├── adr/                      # Architecture Decision Records — one per decision
│   │   └── 0001-*.md
│   ├── patterns/                 # House style with runnable examples ← READ BEFORE WRITING
│   │   ├── writing-a-repository.md
│   │   ├── writing-a-route.md
│   │   ├── writing-a-service.md
│   │   ├── writing-a-test.md
│   │   ├── handling-errors.md
│   │   ├── validating-input.md
│   │   ├── tenant-isolation.md
│   │   ├── writing-a-migration.md
│   │   ├── emitting-an-event.md
│   │   └── writing-a-domain-type.md
│   ├── runbooks/                 # Operational procedures
│   └── api/                      # Auto-generated OpenAPI docs
│
├── infra/
│   ├── docker/                   # Dockerfiles + compose.dev.yml
│   ├── terraform/                # AWS infra (Phase 3+)
│   └── migrations/               # Raw SQL migrations applied by Kysely migrator
│
├── scripts/
│   ├── verify.ts                 # The one-command verification — MUST pass before every commit
│   ├── seed.ts                   # Seeds the reference tenant
│   └── codegen/                  # Code generators (OpenAPI → client, etc.)
│
├── .github/workflows/
├── CLAUDE.md                     # ← this file (root-level)
├── README.md                     # Human-facing short intro
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

**The package rule:** `packages/core` is pure. No I/O, no framework, no HTTP, no DB. Only `zod` as a production dependency. Everything else depends on `core`; `core` depends on nothing.

---

## 4. Environment Setup

### Prerequisites
- Node.js 20.x (pinned in `.nvmrc`)
- pnpm 9.x
- Docker Desktop
- PostgreSQL client tools (`psql`)

### First-run commands

```bash
pnpm install
docker compose -f infra/docker/compose.dev.yml up -d     # postgres + redis + opensearch
pnpm db:migrate                                           # apply migrations
pnpm db:seed                                              # load reference tenant
pnpm dev                                                  # run all apps in watch mode
```

### Standard scripts (every package)
- `pnpm dev` — watch mode
- `pnpm build` — production build
- `pnpm test` — Vitest (unit + integration)
- `pnpm test:e2e` — Playwright (apps only)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — `eslint .`
- `pnpm lint:fix` — `eslint . --fix`
- `pnpm format` — `prettier --write .`

### The one command that matters: `pnpm verify`

Run this before every commit. It runs in sequence:

1. `pnpm typecheck` — TypeScript with strict mode
2. `pnpm lint` — ESLint, zero warnings allowed
3. `pnpm test` — all unit + integration tests
4. `pnpm build` — every package builds successfully
5. Custom invariants (see `scripts/verify.ts`):
   - Every tenant-scoped repository extends `TenantRepository`
   - Every route has a Zod schema
   - No `@ts-ignore` or `as any` in committed code
   - No `console.log` outside of `scripts/`
   - Every migration has a documented rollback

**If `pnpm verify` is red, the commit is blocked.** There are no exceptions.

---

## 5. Coding Standards & Patterns

### TypeScript configuration (non-negotiable)

The shared `tsconfig.base.json` in `packages/config` enables all of these. Do not override in any package:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noImplicitReturns": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "allowUnusedLabels": false,
  "allowUnreachableCode": false
}
```

Every one of these catches a real bug class. Disabling any of them is a code smell you must justify in an ADR.

### Forbidden TypeScript patterns
- **`any`** — use `unknown` and narrow with Zod
- **`@ts-ignore`** and **`@ts-expect-error` without justification** — fix the types
- **Non-null assertions (`!`)** — handle the `undefined` case
- **Type assertions (`as X`) without a runtime check** — validate with Zod first
- **Default exports** (except Next.js pages/layouts) — use named exports

### Architecture patterns

- **Ports and adapters.** Domain (`packages/core`) defines ports (interfaces). Infrastructure packages provide adapters. The domain imports nothing concrete.
- **Constructor injection, manual wiring.** No DI container. Apps assemble their dependency graph in `server.ts` (or equivalent entry point). This is more code than a DI framework, and dramatically easier to reason about.
- **Errors as values.** Use `Result<T, E>` from `packages/core/src/result.ts` for expected failures. Reserve `throw` for truly exceptional cases (programming errors, infrastructure outages).
- **Repositories, not ORMs.** Every data-access pattern goes through a repository class that extends `TenantRepository`. Queries use Kysely.
- **Services own business logic.** Routes are thin — parse input, call a service, format output. Business logic never lives in a route handler.

### Database patterns

- **Every tenant-scoped query includes `tenant_id`.** Use `TenantRepository` — it injects `tenant_id` from the request context automatically. Direct SQL against tenant tables is a bug.
- **Row-level security is enabled** on every tenant-scoped table. It's defense-in-depth, not a replacement for application-level enforcement.
- **Migrations are forward-only in dev, with a documented rollback plan** in the migration file's header comment.
- **Indexes are created `CONCURRENTLY`.** Never block writes on index builds.
- **All timestamps are `timestamptz`, stored UTC.** Display logic converts. Never store local time.
- **All money is integer minor units paired with a `currency_field`.** Never float. IQD = 0 decimals; USD = 2.

### API patterns

- **Zod schemas are the source of truth.** OpenAPI is generated from them via `@asteasolutions/zod-to-openapi`.
- **Versioned under `/v1`.** Breaking changes go to `/v2` with deprecation notices.
- **Errors follow RFC 7807** (`application/problem+json`). One error format, everywhere.
- **Every request has an `x-request-id`** — generated if absent, propagated through traces.
- **No implicit response shapes** — always a Zod schema with a name, always registered in OpenAPI.

### Naming

- Files: `kebab-case.ts`
- Classes / Types / Interfaces: `PascalCase`
- Functions / variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- No `I` prefix on interfaces (`Repo`, not `IRepo`)
- Test files: `foo.test.ts` colocated with `foo.ts`

### Commits & PRs

- **Conventional commits**: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`, `perf:`
- **One PR = one purpose.** Target 200–400 lines changed.
- **PR description** includes: what, why, how, test plan, rollback plan.
- **CI must be green** before merge.
- **No self-merge** — create the PR, wait for CI green, then merge.

---

## 6. Phase 1 Scope — What We Are Building

**Goal:** a working Application Kernel that resolves metadata through two layers (L0 + L2), serves auto-derived REST endpoints for a handful of entities, enforces tenant isolation end-to-end, and ships one reference tenant in a controlled pilot.

### In scope for Phase 1

- L0 (core) and L2 (tenant config) layers only
- Metadata object types: **Entity**, **Field**, **Relationship**, **Permission**, **Localization**
- Change Set state machine: `draft → proposed → approved → deployed → rolled_back`
- Application Kernel: resolver + materializer + in-process L1 cache + Redis L2 cache
- Runtime API: auto-derived REST endpoints for `ent.customer`, `ent.invoice`, `ent.product`
- Admin API: full CRUD on metadata objects + Change Sets
- Custom-field storage strategies: **JSONB** and **native column** (not side-table yet)
- Tenant isolation: Postgres row-level security + runtime tenant-context enforcement
- Audit log with hash-chained rows
- In-process event bus + Postgres outbox table
- Base observability: OpenTelemetry → Grafana Cloud
- Seed: one reference tenant with minimal retail profile

### Out of scope for Phase 1 (explicitly deferred)

- **L1 templates, L3 scripting, L4 extensions** — Phase 2/3
- **Configuration Studio UI** (visual designers) — Phase 3
- **AI Specialist** — Phase 2+ (future RFC-002)
- **GraphQL API** — REST only in Phase 1
- **ClickHouse analytics** — Phase 2
- **Kubernetes** — Fargate only in Phase 1
- **Multi-region** — single region in Phase 1
- **Workflow engine** — hardcoded transitions per entity for now; full engine in Phase 2
- **NATS JetStream** — in-process bus + outbox until Phase 2

**If asked to build anything in the "out of scope" list, refuse politely and point to this section.**

---

## 7. Architecture Non-Negotiables

Inviolable constraints. A change that breaks any of these is a bug, not a feature.

1. **`packages/core` has zero runtime dependencies on infrastructure.** Only `zod`.
2. **Metadata is immutable-versioned.** No `UPDATE` on `meta_object` rows. Every change creates a new row; the prior row's `valid_until` is set.
3. **Resolution is a pure function** of `(tenant_id, object_id, active_layers)`. No global state. Same inputs → same output.
4. **Every tenant-scoped query passes through a repository** that injects `tenant_id`. Direct Kysely against tenant tables is a bug.
5. **Postgres row-level security is ON** for every tenant-scoped table.
6. **Caches are version-keyed, not invalidation-based** on hot paths. New metadata version → new cache key. Old key ages out.
7. **Rollback is O(1).** If rolling back requires more than a pointer flip + cache invalidation, it was implemented wrong.
8. **No hand-crafted tenant entity tables.** The Kernel creates and migrates them from metadata. Human-run DDL against tenant tables is forbidden outside emergency runbooks.
9. **All timestamps are `timestamptz`, UTC.** Display converts. Never store local time.
10. **All money is integer minor units** paired with a `currency_field`.
11. **No direct instantiation of Fastify, Kysely, Redis clients outside `server.ts`.** Wire them once at startup; inject everywhere else.
12. **No `fetch` / HTTP calls from domain code.** All outbound I/O goes through an adapter.

---

## 8. Testing Strategy

Your test suite is what keeps Claude Code honest. Invest heavily here.

### Test types
- **Unit tests** — Vitest, colocated (`foo.test.ts` next to `foo.ts`). Cover every pure function in `packages/core` and `packages/metadata`.
- **Integration tests** — Testcontainers spins up real Postgres, Redis, OpenSearch. Reset between suites via transaction rollback or template database.
- **Contract tests** — every API endpoint has a contract test driven by its OpenAPI schema.
- **End-to-end tests** — Playwright against the console + API. Keep slim: 20–30 scenarios covering critical flows.
- **Property-based tests** — `fast-check` on the metadata resolver. Generate arbitrary layer stacks, assert invariants (determinism, tombstone correctness, ordered resolution).

### Coverage targets
- `packages/core`: 90%+ statement coverage
- `packages/metadata`: 90%+ statement coverage
- `packages/change-set`: 85%+
- Infrastructure packages: no target — write meaningful tests, not coverage-chasing ones

### Rules
- **No mocks where a real service can run.** Testcontainers is fast enough.
- **Every bug gets a regression test** before the fix lands.
- **Every public API function has a test** that exercises it directly.
- **`pnpm verify` must be green** before every commit.

---

## 9. Multi-Tenancy — The One Thing You Must Not Get Wrong

Cross-tenant data leaks are existential bugs. Every layer is defense-in-depth.

- **Every tenant table** has `tenant_id TEXT NOT NULL` and RLS enabled
- **Every DB connection** sets `app.current_tenant` at checkout via `SET LOCAL`
- **Every repository method** accepts a `TenantContext` and refuses to execute without one
- **Every API request** is tenant-scoped via a header, validated against the session's authorized tenants
- **Every cache key** includes `tenant_id` as a prefix; no global cache namespaces
- **Every log line** includes `tenant_id` as structured metadata
- **Every test** explicitly runs under a tenant context or asserts it is a vendor-level operation

**Rule:** if you can write code that accesses tenant data without naming a tenant, the API is wrong. Fix the API, don't work around it.

See `docs/patterns/tenant-isolation.md` for the complete pattern with runnable examples.

---

## 10. Package-Level `CLAUDE.md` Files

Every major package has its own `CLAUDE.md`. Read it before editing any file in that package.

The package-level file covers:
- **Purpose** — what this package does and does not do
- **Boundaries** — what it imports, what it exports, what it must never import
- **Patterns** — the specific patterns used in this package (with a pointer to `docs/patterns/`)
- **Invariants** — package-specific rules beyond the global non-negotiables
- **Known gotchas** — recurring mistakes to avoid

**When to update it:** whenever you learn something new about a package that future sessions should know. Keep it current; stale package docs are worse than none.

---

## 11. The `docs/patterns/` Directory

Before writing new code, find the relevant pattern file and match its style. The patterns are deliberately short (50–100 lines each) with complete runnable examples.

Current pattern files (created in TASK-01):

| Pattern | Purpose |
|---------|---------|
| `writing-a-repository.md` | Tenant-scoped Kysely repositories extending `TenantRepository` |
| `writing-a-route.md` | Fastify route: schema → handler → service → response |
| `writing-a-service.md` | Business logic: pure where possible, Result<T,E> for errors |
| `writing-a-test.md` | Unit, integration, property, contract — one example each |
| `handling-errors.md` | Result type, RFC 7807 responses, logging discipline |
| `validating-input.md` | Zod at the edges; never trust the shape of incoming data |
| `tenant-isolation.md` | How TenantContext flows end-to-end |
| `writing-a-migration.md` | SQL file structure, rollback plan, online migration recipes |
| `emitting-an-event.md` | EventBus port, outbox pattern, versioning |
| `writing-a-domain-type.md` | Zod schema + inferred type + round-trip test |

**If you're writing code that doesn't match any pattern**, either you're solving a new problem (and should add a pattern file) or you're inventing where a pattern already exists (and should use it). Ask.

---

## 12. Working Method — How Every Session Should Go

### Session-start ritual
1. Read `CLAUDE.md` (this file) fully
2. Read `docs/rfc/ERP-RFC-001.md` if touching anything architectural
3. Read the relevant package-level `CLAUDE.md`
4. Read the relevant `docs/patterns/*.md`
5. State the task you're about to work on (by ID from §13)
6. Produce a **plan** — files you'll create/change, tests you'll add. Do not write code yet.
7. Wait for approval.
8. Implement in small commits.
9. Run `pnpm verify` locally. Iterate until green.
10. Open PR with the §5 description template. Wait for CI green. Merge.

### Decision protocol
When you encounter a choice not covered by this file, the RFC, the package doc, or a pattern file:

1. **Search first** — check if a similar decision was made elsewhere in the codebase
2. **If genuinely new** — propose two or three options with trade-offs, ask the user (Bariq) to decide
3. **After decision** — record it as an ADR in `docs/adr/` so it never needs to be re-decided

Never invent a decision on a genuinely new architectural question without documenting it.

### Anti-patterns to avoid
- **Don't add new dependencies without justification.** Check `package.json` first.
- **Don't refactor unrelated code while fixing a bug.** Separate PRs.
- **Don't write "TODO" comments.** Either implement it or file an issue.
- **Don't silence type errors.** Fix the types.
- **Don't skip tests "because it's urgent."** Urgent PRs need tests more, not less.
- **Don't reach for clever abstractions.** Write the boring, explicit version first. Abstract only when the third occurrence appears.

---

## 13. Task Queue — Start Here

Ordered sequentially. Do not skip ahead.

> **Phase 1 status:** ✅ complete. TASK-01 through TASK-13 shipped to
> `main`. Phase 2 onward lives in [`docs/phases/`](./docs/phases/):
>
> - [`phase-1-cleanup.md`](./docs/phases/phase-1-cleanup.md) — six
>   deferred Phase-1 items (Better Auth, audit backfill, create-row
>   UI, Grafana OTLP, Playwright E2E, Terraform + ECS).
> - [`phase-2-tasks.md`](./docs/phases/phase-2-tasks.md) — 11 PR-sized
>   tasks (TASK-15 … TASK-25) covering RFC §16.2 (Templates &
>   Packages).
> - [`phase-3-tasks.md`](./docs/phases/phase-3-tasks.md) — 8 epics
>   (Configuration Studio GA, L4 extensions, AI Specialist v1).
>   Decompose into PR-sized tasks when Phase 2 wraps.
> - [`phase-4-tasks.md`](./docs/phases/phase-4-tasks.md) — 6 epics
>   (multi-region, Kubernetes, compliance packs, Wave 2 templates).
>   Decompose when Phase 3 wraps.
>
> Phase 1 historical queue follows. Do not start work directly from
> this list — it is the record of what shipped, not a live queue.

### TASK-01 — Monorepo Scaffold
**Goal:** empty monorepo with tooling wired up; one passing smoke test per package.
**Done when:**
- `pnpm install && pnpm verify` passes on a fresh clone
- `packages/config` holds shared `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.config.base.ts`
- `scripts/verify.ts` exists and runs typecheck + lint + test + build + custom invariants
- `CI` workflow runs `pnpm verify` on every push and PR
- `docs/rfc/ERP-RFC-001.md` is committed
- `docs/patterns/*.md` stubs are committed for all 10 patterns listed in §11
- Root `README.md` points new contributors to `CLAUDE.md`
- Every app and package has a stub `CLAUDE.md`

### TASK-02 — Local Dev Environment
**Goal:** `docker compose up` gives a complete local stack in under 60 seconds.
**Done when:**
- `infra/docker/compose.dev.yml` starts healthy Postgres 16, Redis 7, OpenSearch 2
- `.env.example` documents every variable consumed by any service
- `docs/runbooks/local-dev.md` explains reset, inspect, teardown
- Integration test proves Testcontainers can spin up fresh instances

### TASK-03 — Metadata Schema
**Goal:** the four metadata tables from RFC §4.1 defined as Kysely types with a working migration.
**Done when:**
- SQL migration files in `infra/migrations/` match RFC §4.1 DDL exactly
- `packages/db/src/schema.ts` has Kysely types for all tables
- RLS policies are created as part of the migration
- `pnpm db:migrate` is idempotent
- Integration test (Testcontainers): create a tenant, insert metadata rows, assert RLS blocks cross-tenant reads
- `docs/adr/0001-metadata-schema.md` explains the shape
- `docs/patterns/writing-a-migration.md` is populated with a real example from this task

### TASK-04 — Core Domain Types
**Goal:** `packages/core` defines the metadata object model as Zod schemas with inferred TypeScript types.
**Done when:**
- Schemas for Envelope, Entity, Field, Relationship, Permission, Localization match RFC §2
- Types inferred from Zod — never declared separately
- Zero production dependencies beyond `zod`
- Round-trip tests (parse → serialize → parse) for every schema
- `docs/patterns/writing-a-domain-type.md` is populated

### TASK-05 — Result Type and EventBus Port
**Goal:** `packages/core` exposes the `Result<T, E>` type and the `EventBus` port.
**Done when:**
- `Result<T, E>` with `ok`, `err`, `isOk`, `isErr`, `map`, `flatMap`, `match`
- `EventBus` interface with `publish`, `subscribe`, `waitFor`
- `DomainEvent` envelope type with trace context and tenant context
- Unit tests for Result combinators
- Example usage documented in `docs/patterns/handling-errors.md`

### TASK-06 — Resolution Algorithm
**Goal:** `packages/metadata` implements RFC §3 — walk layers, apply merge strategies, handle tombstones, surface conflicts. Pure function.
**Done when:**
- Algorithm matches RFC §3.2 pseudocode exactly
- All four merge strategies: `replace`, `merge_object`, `append`, `merge_list_by_key`
- Tombstones correctly halt resolution
- Property tests with `fast-check` cover determinism, tombstone correctness, ordered layer application
- Benchmark: 30-field entity through 3 layers resolves in under 0.5ms p99
- Zero I/O in the resolver (it fetches via an injected port)

### TASK-07 — Change Set State Machine
**Goal:** `packages/change-set` implements the state machine from RFC §9.3.
**Done when:**
- States, transitions, and guards match the RFC exactly
- Deploy is atomic (all ops commit or none)
- Rollback is O(1) — pointer flip on `valid_until`
- Audit entries written for every transition
- Integration tests cover: approve-then-deploy, deploy-then-rollback, failed deploy leaves system consistent

### TASK-08 — In-Process EventBus + Outbox
**Goal:** `packages/events` provides an in-process `EventBus` adapter backed by a Postgres outbox table.
**Done when:**
- Events published within a database transaction land in the outbox atomically
- A background pump in the worker app processes the outbox and dispatches to in-process subscribers
- Delivery is at-least-once with dedup keys
- Integration test proves events survive a process restart
- `docs/patterns/emitting-an-event.md` is populated

### TASK-09 — Fastify API Skeleton
**Goal:** `apps/api` boots a Fastify server with plugins, routes, and a request context.
**Done when:**
- `server.ts` is the single place all dependencies are wired
- Plugins: `auth`, `tenant-context`, `errors`, `telemetry`, `openapi`, `zod-validation`
- Health endpoints: `/healthz`, `/readyz`
- OpenAPI spec served at `/docs/openapi.json`
- Every route has a Zod schema registered in OpenAPI
- Errors returned as RFC 7807 problem+json
- Structured pino logs with request ID, tenant ID, trace ID
- `docs/patterns/writing-a-route.md` is populated with a real route from this app

### TASK-10 — Admin API for Metadata CRUD
**Goal:** implement RFC §9.1 endpoints for reading, proposing, approving, deploying, and rolling back metadata changes.
**Done when:**
- All nine RFC §9.1 endpoints implemented
- Auth: Better Auth session with `tenant_id` and `metadata.write` role required for writes
- All writes scoped to an open Change Set (never direct writes)
- Contract tests derived from OpenAPI pass
- Rate limits configured per endpoint

### TASK-11 — Application Kernel Service
**Goal:** `apps/kernel` — standalone service that resolves metadata on demand.
**Done when:**
- Subscribes to `metadata_deployed` events, evicts L1 cache
- Connects to Redis for L2 cache
- Exposes `POST /internal/resolve` returning resolved metadata for `(tenant, object)`
- OpenTelemetry trace per resolution; latency histogram emitted
- Integration test: two kernel instances observe cache invalidation correctly after a deploy

### TASK-12 — Runtime API Auto-Derivation
**Goal:** `apps/api` auto-derives REST endpoints from deployed Entity metadata. Start with `ent.customer`.
**Done when:**
- Deploying an Entity makes `GET/POST/PATCH/DELETE /v1/{entity}` available
- Validation driven by a Zod schema derived from Field metadata
- Permission Gate enforced per RFC §13.1
- Adding a custom field via Admin API makes it queryable via Runtime API without redeploy
- E2E test: create a tenant, add a custom field to Customer, create a Customer with that field, list it back

### TASK-13 — Reference Tenant Seed
**Goal:** `pnpm db:seed` creates a working demo tenant.
**Done when:**
- Tenant `t_demo_retail` created with Customer, Product, Invoice entities
- 50 demo rows per entity with Arabic + English labels
- One custom field demonstrates layering
- Seed is idempotent — running twice doesn't duplicate data

---

## 14. Definition of Done (Every Task)

A task is not "done" until all of these are true:

- [ ] Code compiles with strict TypeScript (`pnpm typecheck`)
- [ ] ESLint passes with zero warnings (`pnpm lint`)
- [ ] All tests pass (`pnpm test`)
- [ ] `pnpm verify` is green
- [ ] OpenAPI spec updated for API tasks
- [ ] An ADR exists in `docs/adr/` if an architectural decision was made
- [ ] The relevant `docs/patterns/*.md` is populated with a real example from the task
- [ ] `CLAUDE.md` updated if any non-negotiable or scope changed
- [ ] Package-level `CLAUDE.md` updated if package boundaries, patterns, or gotchas changed
- [ ] PR description follows the §5 template
- [ ] CI green on the PR
- [ ] `CHANGELOG.md` has a short entry under the current phase

---

## 15. What NOT to Do

- Don't add new top-level dependencies without documenting why in the PR description
- Don't change the tech stack in §2 without a separate ADR and approval
- Don't reach for NestJS, Prisma, Drizzle, Mongoose, Express, or any other framework not listed in §2
- Don't build the Configuration Studio UI — Phase 3
- Don't build the AI Specialist — Phase 2+
- Don't build templates or compliance packs — RFC-003
- Don't adopt a message bus in Phase 1 — in-process + outbox is enough
- Don't self-host Grafana/Prometheus/Loki in Phase 1 — use Grafana Cloud
- Don't optimize prematurely. Ship correct, then benchmark, then optimize.
- Don't use `console.log` outside `scripts/`. Use the pino logger from `packages/telemetry`.
- Don't silence TypeScript errors with `any`, `@ts-ignore`, or non-null assertions
- Don't skip tests because a PR is "urgent"
- Don't write creative abstractions on the first occurrence. Write explicit code until the third repetition.
- Don't mix Server and Client components creatively in Next.js. Default to Server Components; Client at interaction boundaries.
- Don't use default exports except for Next.js pages/layouts

---

## 16. Glossary (Quick Reference)

- **L0–L4** — the five metadata layers (Core, Template, Tenant Config, Tenant Extensions, Custom Code)
- **Change Set** — atomic bundle of metadata changes with its own lifecycle
- **Kernel** — the runtime that resolves metadata and serves derived APIs
- **Materializer** — compiles resolved metadata into runtime artifacts (validators, query builders)
- **Tenant** — a single customer organization; all data partitioned by `tenant_id`
- **Tombstone** — a higher-layer marker that deletes an inherited definition
- **Resolution** — the process of computing effective metadata for an object in a tenant
- **Package** — distributable bundle (template, compliance pack, or extension)
- **Upgrade-safe** — a change to a lower layer does not overwrite a higher layer
- **Port** — an interface defined in `packages/core` for something the domain needs
- **Adapter** — an infrastructure implementation of a port

Full glossary in RFC §0.

---

## 17. Contact & Ownership

- **Product owner:** Bariq
- **Architecture:** Bariq + ERP-RFC-001
- **Sole engineer:** Claude Code (you)

For any genuine ambiguity not resolved by this file, the RFC, the package `CLAUDE.md`, or `docs/patterns/`, ask Bariq before implementing.

---

## 18. First Message to Claude Code

Copy this into your first Claude Code session:

> Read `CLAUDE.md` and `docs/rfc/ERP-RFC-001.md` fully before doing anything else. Then begin **TASK-01: Monorepo Scaffold** from §13.
>
> Start by giving me a **written plan** — no code yet. The plan should list:
> - Exact versions of every tool (pnpm, Turborepo, TypeScript, Vitest, ESLint, Prettier, Fastify, Kysely, Zod, React, Next.js, Better Auth)
> - The contents of `packages/config/tsconfig.base.json` with all strict flags from §5
> - The contents of `packages/config/.eslintrc.cjs`
> - The full file tree you will create
> - The five custom invariants that `scripts/verify.ts` will enforce
> - The first GitHub Actions workflow
>
> I will review the plan and approve, correct, or reject. Do not write code until I approve.
>
> When approved, implement in small commits, each with a conventional-commit message. Run `pnpm verify` locally and iterate until green. Open the PR with the description template from §5. Stop there and wait for me to review the PR.
>
> Proceed.

---

*End of CLAUDE.md. Version: 2.0 (AI-engineer-optimized). Last updated: April 2026.*
