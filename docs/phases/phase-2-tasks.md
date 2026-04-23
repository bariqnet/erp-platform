# Phase 2 Task Queue — Templates & Packages

Corresponds to RFC §16.2. Months 5–9 in the original plan. Phase 2
delivers the **L1 Industry Template layer**, the **Package format and
installer**, **five launch templates**, a **Workflow engine**, an
**L3 scripting sandbox**, **NATS JetStream** (behind the EventBus
port), and **Configuration Studio v0** (read-only resolved views).

Prerequisite: all of `phase-1-cleanup.md`. In particular, Better Auth
(TASK-10.1) and the Terraform scaffold (TASK-14.5) should land before
multi-tenant onboarding (TASK-18) runs against real users.

Dependencies within this phase are called out on each task. Parallel
work is explicitly noted.

---

## TASK-15 — Lifecycle state guards (baby workflow)

**Goal:** enforce entity `lifecycle.states` transitions at the Runtime
API. Today the `status` column is a plain string any PATCH can set;
this task checks that transitions are legal before writing.

**RFC anchor:** RFC §6 (lifecycle), RFC §9.2 (named actions).

**Done when:**

- [ ] `EntityBody.lifecycle` gains an optional
      `transitions: Array<{from: string; to: string; action?: string}>`
      in `@erp/core` with a round-trip test.
- [ ] `RuntimeEntityService.patch` rejects a `status` change not in
      the transition table with `{kind: "invalid_transition"}` → 409.
- [ ] A dedicated `POST /v1/:entity/:id/actions/:action` endpoint that
      looks up the transition by action name, applies it, and emits a
      `runtime.<entity_id>.<action>` event via `OutboxBus.publishWithin`.
- [ ] Integration tests: valid transition succeeds, invalid returns
      409, action endpoint works, event lands on the outbox.
- [ ] Console: the entity form exposes "Actions" buttons for every
      declared transition from the current state.

**Dependencies:** Phase-1-cleanup TASK-10.1 (for per-action permission
gating).

**Scope:** ~400 lines; 1–2 sessions.

---

## TASK-16 — Full Workflow engine

**Goal:** replace the inline `lifecycle.transitions` with a first-
class `Workflow` metadata object (`wfl.*`). Adds guards, SLAs, hooks,
and named-action routes per RFC §9.2.

**RFC anchor:** RFC §6 (Workflow), RFC §9.2.

**Done when:**

- [ ] `packages/core/src/workflow.ts` ships `WorkflowBodySchema`:
      `states[]`, `initial`, `transitions: [{from, to, action, guard?,
on_entry_script?, on_exit_script?, sla_ms?}]`, plus round-trip
      tests.
- [ ] `packages/workflow` new package hosts a pure evaluator:
      `evaluate(workflow, currentState, action, context) → Result<NextState, WorkflowError>`.
      Guards are the L3 script subset (TASK-20) until that lands —
      for this task, guards accept only a narrow JSON-path boolean
      expression parser.
- [ ] `EntityBody.lifecycle.workflow_id` resolves to a `wfl.*` object;
      the state machine takes over.
- [ ] SLA watchdog: the worker polls overdue transitions and emits
      `workflow.sla_breached` events.
- [ ] `apps/console/app/workflows/[id]/page.tsx` renders a graphviz-
      style diagram of the workflow (simple SVG, not a library).
- [ ] Integration tests: a two-workflow entity (`wfl.invoice_lifecycle`
      for Invoice) deploys, routes, SLA breaches fire.

**Dependencies:** TASK-15 (the transition shape).

**Scope:** ~1200 lines; 3–4 sessions. Biggest task in Phase 2.

---

## TASK-17 — L1 template layer in the resolver

**Goal:** enable the L1 (Industry Template) layer in `@erp/metadata`.
Today the resolver supports L0 and L2 only; the resolver internals
already walk a layer list, so this is mainly the L1 store + the
template ID routing.

**RFC anchor:** RFC §2 (layer model), RFC §3 (resolution), RFC §8
(templates).

**Done when:**

- [ ] `MetadataObjectRepository.fetchCandidate` accepts `layer: "L1"`
      and resolves via the `template_id` that each L1 row carries.
- [ ] `meta_layer_activation` gains a verified template resolution
      path: activate a template → the resolver walks its L1 rows
      between L0 and L2.
- [ ] Round-trip property test (`fast-check`) asserts L0 → L1 → L2
      stacks resolve deterministically per RFC §3.6.
- [ ] Seed script (`scripts/seed-templates.ts`) installs one sample
      template (`tpl.retail_basics`) with one Entity overlay.
- [ ] Admin API gains
      `POST /admin/v1/templates/activate {template_id, version}`.
- [ ] Integration test: activate template → resolve Customer for a
      tenant → assert L1 fields merge with L0.

**Dependencies:** TASK-18 (package format) is not strictly required —
this task can ship with hand-seeded L1 rows.

**Scope:** ~500 lines; 2 sessions.

---

## TASK-18 — Package format & installer

**Goal:** ship the `erp.pkg` format for distributing templates
(and later, extensions). A package is a signed tarball of metadata
objects with a manifest. The installer verifies the signature, runs
the Impact Analyzer, and activates the template atomically.

**RFC anchor:** RFC §8 (Templates & Packages), RFC §8.1 (Package
Manifest).

**Done when:**

- [ ] `packages/package-format/` new package exports
      `writePackage(manifest, objects[])` and `readPackage(tarball)`.
      Manifest Zod-validated; schema includes `id`, `name`, `version`,
      `author`, `compat_range`, `object_count`, `signature`.
- [ ] `Package.sign(privateKey)` + `Package.verify(publicKey)` using
      `node:crypto` Ed25519.
- [ ] `apps/api` gains `POST /admin/v1/packages/install` that accepts
      a tarball, verifies, runs Impact Analyzer, inserts the L1
      objects under a generated `template_id`, records an activation.
- [ ] CLI: `pnpm pkg:pack <manifest.json> <objects.json>` and
      `pnpm pkg:install <url|path>`.
- [ ] Integration test: pack a small template locally, install it
      against Testcontainers, verify the resolver picks up the L1
      overlay on the next `/v1/ent.customer` call.

**Dependencies:** TASK-17 (L1 layer in the resolver).

**Scope:** ~800 lines; 2–3 sessions.

---

## TASK-19 — NATS JetStream adapter behind the EventBus port

**Goal:** Phase 2 of RFC §16.2 notes that in-process events no longer
scale across multiple node clusters. Implement `JetstreamBus` satisfying
the existing `EventBus` port; keep `OutboxBus` unchanged so the outbox-
with-data pattern still works. Domain code changes nowhere.

**RFC anchor:** CLAUDE.md §2 (Phase 2 bus), RFC §5.4 (propagation SLO).

**Done when:**

- [ ] `packages/events-nats` new package: `JetstreamBus implements
EventBus`. Connects via `nats.js`; creates streams per event-type
      prefix (`metadata.*`, `workflow.*`, `runtime.*`).
- [ ] Worker app grows a new config key `EVENT_BUS="nats" | "in-process"`
      selecting which adapter to wire.
- [ ] Outbox pump becomes **optional** when NATS is primary: if the
      pump is enabled alongside, it republishes outbox rows onto NATS
      subjects (the belt-and-braces mode).
- [ ] Kernel's cache invalidator subscribes to the NATS subject
      instead of (or in addition to) the outbox poller; the poller
      stays as the durable fallback.
- [ ] Integration test: Testcontainers NATS; three kernel instances
      subscribe; publishing `metadata.change_set_deployed` reaches all
      three; propagation p95 under 200 ms (RFC §5.4's tighter bound).

**Dependencies:** TASK-14.5 (NATS needs infra) or a sidecar NATS
container in compose.dev.yml (quicker).

**Scope:** ~700 lines; 2–3 sessions.

---

## TASK-20 — L3 scripting sandbox (V8 isolates)

**Goal:** Low-Code Scripts per RFC §7.1. A narrow TS subset runs in
per-tenant V8 isolates with a curated API surface (`system`,
`entities`, `event`). Used by Workflow guards (TASK-16) and by
future Automations.

**RFC anchor:** RFC §7.1, §7.2 (Script Sandbox Guarantees).

**Done when:**

- [ ] `packages/scripts` new package ships:
  - `ScriptCompiler.compile(source, context)` → bytecode + manifest
    of API usage. Rejects scripts that import disallowed globals.
  - `ScriptRunner.run(bytecode, input, timeout_ms, memory_mb)` uses
    `isolated-vm` (the standard V8-isolate npm package for Node) with
    hard CPU + memory caps, per-tenant isolate pool.
  - API surface: `entities.<Entity>.{get,list,create,patch}`
    (bound to Runtime API), `system.{now, logger, emit_event}`.
    No network, no fs, no `import`, no `setTimeout`.
- [ ] Compatibility harness (RFC §7.4) — a test runner that re-runs
      every tenant's scripts against the next platform release before
      upgrade. Ships as `scripts/harness-run.ts`.
- [ ] Integration test: deploy a Workflow with a guard written in the
      subset (`return record.credit_limit_fils > 0`) and assert it's
      evaluated on transition.
- [ ] `apps/console` gains a read-only script viewer under
      `/scripts/:id`.

**Dependencies:** TASK-16 (workflow guards are the first consumer).

**Scope:** ~1,000 lines + isolated-vm dep; 3 sessions.

---

## TASK-21 — Configuration Studio v0 — resolved-metadata views

**Goal:** Phase 2 ships a **read-only** Configuration Studio. Admins
see the merged view across L0 + L1 + L2 with provenance per field,
can diff versions, and can preview the effect of a proposed Change
Set via `simulate_change` (which already exists server-side).

**RFC anchor:** RFC §9.4 (simulate), RFC §16.2 (Studio v0).

**Done when:**

- [ ] `apps/console/app/metadata/[id]/page.tsx` shows the resolved
      body with a **Provenance** column indicating which layer each
      field came from. L2 overrides are highlighted.
- [ ] `.../history/page.tsx` shows the `GET /admin/v1/metadata/objects/:id/history`
      output as a timeline with change_set_id links.
- [ ] Change-set detail page
      (`apps/console/app/changes/[id]/page.tsx`) lists staged
      operations + the simulate output side-by-side ("before / after").
- [ ] No write actions yet — those land in Phase 3's full Studio.

**Dependencies:** TASK-10.1 (auth) — no deep dep on other Phase 2
tasks, can run in parallel with TASK-17/18.

**Scope:** ~600 lines; 2 sessions.

---

## TASK-22 — Field-level permissions in the PermissionGate

**Goal:** RFC §13.1 level 2. The gate currently enforces entity-level
grants only; add field-level read + write checks and plumb the
materialized view through the Runtime API responses (admins see all
fields; a restricted role sees a projection).

**RFC anchor:** RFC §13.1.

**Done when:**

- [ ] `PermissionBody.field_grants` already exists in the Zod schema;
      the gate now honors it.
- [ ] `RuntimeEntityService.list/get` takes the gate's field ACL into
      account when building the response — redacted fields are stripped
      (not nulled, to keep the ACL from leaking their existence).
- [ ] `RuntimeEntityService.patch` rejects a PATCH that touches
      write-denied fields with
      `{kind: "field_not_writable", fields: [...]}`.
- [ ] Integration tests: a role with write on `name` but not on
      `credit_limit_fils` can update name, gets 403 on the other;
      read-side response excludes the denied field.

**Dependencies:** TASK-10.1 (roles).

**Scope:** ~400 lines; 1–2 sessions.

---

## TASK-23 — Record-level permission predicates

**Goal:** RFC §13.1 level 3. `PermissionBody.record_predicate` compiles
to a SQL `WHERE` fragment that `EntityRowRepository.list` and `.get`
AND into their queries. Expression language = the L3 script subset
from TASK-20, compiled to SQL at deploy time.

**RFC anchor:** RFC §13.1 (level 3), RFC §15.1 (the SQL-vs-post-query
open question).

**Done when:**

- [ ] `packages/permission-predicate` — AST + SQL compiler. Safe
      expressions only: no subqueries, no functions beyond a
      whitelist, no string concatenation of user input.
- [ ] `PermissionGate.check()` returns a compiled `Kysely` expression
      the service ANDs into its query.
- [ ] Integration tests: a role with `record_predicate: "owner_id ==
$user.id"` sees only the rows they own; tenant A's predicate
      never runs against tenant B's rows (RLS below + predicate above).
- [ ] A compatibility-harness test re-evaluates every deployed
      predicate against a small benchmark set at every migration.

**Dependencies:** TASK-20 (the expression language compiler).

**Scope:** ~700 lines; 2–3 sessions.

---

## TASK-24 — Custom-field storage strategy migrator

**Goal:** RFC §4.2 lists three strategies — `jsonb`, `native`,
`side_table`. Phase 1 ships `jsonb` only. Phase 2 implements the
**Migration Primitives** (RFC §11.3) that move a field between
strategies online, no downtime.

**RFC anchor:** RFC §4.2, RFC §6.1, RFC §11.3.

**Done when:**

- [ ] `apps/worker` gains a `StorageMigrator` that, given
      `(tenant, entity, field, from_strategy, to_strategy)`:
  - Phase A: add the new column / side-table row (`CREATE … IF NOT EXISTS`).
  - Phase B: dual-write — application layer writes both; batch
    backfills read from old and write to new, throttled per tenant
    (RFC §11.3).
  - Phase C: shadow-read verification — reads from both and diff.
  - Phase D: switchover — RuntimeEntityService reads from the new
    location; old column stays for rollback.
  - Phase E: drop old column on operator approval.
- [ ] `POST /admin/v1/metadata/fields/:entity/:field/migrate-storage`
      triggers the migrator. Returns a job id.
- [ ] Integration test: create a JSONB field, migrate to native
      column on 5,000 rows, assert reads/writes stay consistent end
      to end.

**Dependencies:** TASK-16 (workflow, for the multi-phase state
machine the migrator itself becomes).

**Scope:** ~900 lines; 3 sessions.

---

## TASK-25 — AI Specialist v0 — read-only advisor

**Goal:** RFC-002 doesn't exist yet but CLAUDE.md §1 names the AI
Implementation Specialist as pillar 2. Phase 2 ships **v0**: a
read-only advisor chat that can answer "what entities are deployed?",
"show me the history of this Change Set," "summarize this tenant's
configuration drift" — no write actions yet.

**RFC anchor:** none — **write RFC-002 as TASK-25.0** before code.

**Done when:**

- [ ] `docs/rfc/ERP-RFC-002.md` drafted and approved. Covers: write
      authority, retrieval surface, tenant binding, rate limits,
      audit requirements. Use Anthropic Sonnet with tool calling
      (CLAUDE.md §2 stack).
- [ ] `apps/ai-specialist` new app — minimal Fastify service that
      proxies chat messages through Anthropic with tool calling.
      Tools are scoped to `GET` endpoints on the Admin API only.
- [ ] Tenant binding: every session carries a signed
      `{tenant_id, user_id, roles}` claim that is re-validated on
      every tool call. RFC §10.4 (AI plane isolation).
- [ ] Console `apps/console/app/specialist/page.tsx` hosts a chat
      UI (server-sent events or streaming fetch).
- [ ] Integration test: ask "list my deployed entities" — tool call
      → Admin API → answer contains `ent.customer`.

**Dependencies:** this is the end-of-Phase-2 task; lands after the
first five templates exist (TASK-17/18) so the AI has something
meaningful to describe.

**Scope:** RFC-002 drafting = 2 sessions. Code ~1,200 lines; 3–4
sessions total.

---

## Summary

| #   | Title                        | Scope | Parallel with      |
| --- | ---------------------------- | ----- | ------------------ |
| 15  | Lifecycle guards             | 1–2 d | 17                 |
| 16  | Full Workflow engine         | 3–4 d | 17, 21             |
| 17  | L1 layer in resolver         | 2 d   | 15, 21             |
| 18  | Package format + installer   | 2–3 d | 16                 |
| 19  | NATS JetStream adapter       | 2–3 d | 17, 21             |
| 20  | L3 scripting sandbox         | 3 d   | —                  |
| 21  | Config Studio v0 (read-only) | 2 d   | 15–19 all parallel |
| 22  | Field-level permissions      | 1–2 d | 23                 |
| 23  | Record-level predicates      | 2–3 d | 22                 |
| 24  | Storage strategy migrator    | 3 d   | 19                 |
| 25  | AI Specialist v0 (+ RFC-002) | 5–6 d | final task         |

**Phase 2 total:** ~28–35 engineering days at steady pace (RFC §16.5
scopes Phase 2 at 12–15 engineers × 4 months; we're doing it at 1×
AI-engineer pace, so figure 6–8 weeks of focused sessions).

**Exit criterion (RFC §16.5):** five templates GA, ten tenants live,
package installer hardened.
