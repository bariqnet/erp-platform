# Phase 3 Task Queue — Configuration Studio + Extensions

Corresponds to RFC §16.3. Months 9–14 in the original plan.

**Status:** Captured as **epics** only. Each epic is multiple PR-sized
tasks; the first task of Phase 3 is to decompose these into a
`phase-3-tasks.md` queue in the same shape as Phase 2. That
decomposition lands when Phase 2 wraps — designing Phase 3 tasks now
is speculation (CLAUDE.md §10: "update when you learn something").

Prerequisite: all of Phase 2. Particularly TASK-20 (L3 scripting) and
TASK-25 (AI Specialist v0), both of which Phase 3 builds on.

---

## Epic P3-A — Configuration Studio GA

RFC §16.3 calls for five designers, all first-class, all WYSIWYG:

- **Form Designer** — drag-and-drop field layout for each Entity;
  output = Form metadata object (`frm.*`). RTL-aware.
- **Workflow Designer** — visual state-machine editor for `wfl.*`.
  Simulates guard predicates against sample records.
- **Report Designer** — query + visualization builder; output = Report
  metadata object (`rpt.*`). Renders to PDF + spreadsheet.
- **Automation Designer** — event-trigger + action-chain visual
  editor; output = Automation metadata object (`aut.*`). Chains can
  include L3 script steps (TASK-20).
- **Role Designer** — grants, field permissions, record predicates
  for `prm.*`. Previews the effective permission surface for a test
  user.

Every designer writes to a draft Change Set; every change supports
`simulate_change` preview. Output round-trips through the Admin API;
nothing bypasses the state machine.

Scope estimate: 8–10 tasks, ~4–5 weeks of work. Each designer is its
own 300–500 LOC React surface plus the metadata object schema +
resolver integration.

---

## Epic P3-B — L4 pro-code extension SDK + marketplace

RFC §16.3 introduces the L4 layer: tenants (or partners) ship
arbitrary TypeScript in per-extension Docker containers with signed
credentials injected by the platform. The SDK provides typed
bindings for the Admin + Runtime + Event APIs.

Scope estimate: 5–6 tasks. Includes the container runtime (probably
ECS Fargate for the extension host, with Cloud Map for service
discovery), the SDK package, a marketplace service (new
`apps/marketplace`), signing + verification flow, and tenant-facing
install UI.

Prerequisite: TASK-18 (package format) generalizes to support L4
bundles, not just L1 templates.

---

## Epic P3-C — Compatibility harness for scripts + extensions

RFC §7.4. Before a platform release ships, a harness re-runs every
tenant's L3 scripts + L4 extensions against the new platform against
a curated benchmark set, flags API-shape changes, and produces a
compat report. Release blocked until all tenants pass or have opted
to update their code.

Scope estimate: 3 tasks. Mostly orchestration — reuses TASK-20's
ScriptRunner and TASK-25's AI Specialist to auto-generate upgrade
diffs for scripts that break.

---

## Epic P3-D — AI Specialist v1 — write-capable implementation

Write authority behind the AI Specialist. Per-operation scope (not
per-session) — see RFC §15.1 open-question #5. The AI proposes
Change Sets and explains them; admins approve. Rollback rate and
approval rate land on a per-tenant scorecard (RFC §15.2 mitigation).

Prerequisite: TASK-25 (AI Specialist v0) lands first; this is v1.

Scope estimate: 4 tasks. Includes the Change-Set-proposal tool-calling
surface, the approval dashboard, the scorecard metrics, and the
grounding/output-filter layer that enforces tenant binding.

---

## Epic P3-E — GraphQL surface

RFC §9 notes both REST and GraphQL endpoints are derived from
metadata. Phase 1 shipped REST only. Phase 3 adds the GraphQL
surface alongside.

Scope estimate: 2 tasks. Most of the work is schema generation from
the materialized EntityBody; the resolver wiring is shared with the
REST path.

---

## Epic P3-F — Observability dashboards for tenants

RFC §16.4 ("Phase 4") puts tenant-facing dashboards there, but the
primitives arrive in Phase 3 because the Configuration Studio needs
them: per-tenant slow-query reports, drift scorecards, audit-log
browsers.

Scope estimate: 3 tasks. Two tabs in the console, one backfill
service that populates an `ops_analytics` schema overnight.

---

## Epic P3-G — Pro-code SDK package + docs

A typed TypeScript package that extensions depend on. Published to a
private npm registry. Auto-generated from the current platform's
OpenAPI + the Entity metadata for a specific tenant — so the SDK is
tenant-shaped.

Scope estimate: 2 tasks.

---

## Epic P3-H — Partner certification program

Process + tooling for third-party partners to publish L1 templates
and L4 extensions. Automated scanning + signing + sandbox run before
publication.

Scope estimate: 3 tasks. Mostly CI-system work.

---

## Exit criterion (RFC §16.5)

Configuration Studio GA; AI Specialist v1 live; scripting sandbox
production-ready.

At the start of Phase 3, decompose these eight epics into PR-sized
TASK-26 … TASK-5x in `phase-3-tasks.md`.
