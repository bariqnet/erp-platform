# Phase 4 Task Queue — Scale, Governance & Verticals

Corresponds to RFC §16.4. Months 14–18+ in the original plan.

**Status:** Epics only. Decompose into PR-sized tasks when Phase 3
wraps. Same rule as Phase 3: writing PR-sized tasks for Phase 4 now
would be speculation.

Prerequisite: all of Phase 3. Phase 4 is primarily infrastructure,
compliance, and go-to-market.

---

## Epic P4-A — Multi-region active-active

Tenants pinned to a home region (Frankfurt / MENA region / …) with
cross-region failover. Per-tenant data-residency controls surface in
the console. CDC-based replication keeps read-replicas warm across
regions; the Kernel's L2 cache invalidator understands the
multi-region outbox topology.

Prerequisite: TASK-19 (NATS) generalizes to a cluster that spans
regions, or we swap in Apache Kafka with MirrorMaker. The RFC is
silent on the final choice — expect an ADR.

Scope estimate: ~12 tasks. This is the biggest epic.

---

## Epic P4-B — Kubernetes migration

RFC §2 pins ECS Fargate for Phases 1–3. Phase 4 migrates to
Kubernetes (likely EKS + ArgoCD) once the service mesh + secrets +
auto-scaling needs outgrow Fargate's sweet spot. Include a custom
operator for Change Set deploys to preserve the atomic-deploy
guarantee during rolling upgrades.

Scope estimate: ~6 tasks.

---

## Epic P4-C — SOX + ISO 27001 + MENA regulatory packs

Compliance feature-flags and audit reports: SOX §404 control
narratives generated from the audit-chain (TASK-14.1); ISO 27001
Annex A controls mapped to metadata policies; MENA-specific
data-locality (Iraq Data Protection Act, UAE Federal Decree-Law No.
45 of 2021, KSA PDPL) audit bundles exported as compliance packs.

Prerequisite: legal + compliance review outside the engineering
scope. One ADR per jurisdiction documents which controls are coded
vs which are process-only.

Scope estimate: ~8 tasks.

---

## Epic P4-D — Advanced governance

Multi-party Change Set approvals, environment promotion pipelines
(dev → staging → prod Change Set graph), tenant-defined policy
constraints on what their admins can change.

Scope estimate: ~5 tasks.

---

## Epic P4-E — Partner marketplace GA

Phase 3 shipped certification; Phase 4 opens it to the public.
Revenue-share billing, consumer-facing template + extension listings,
reviews + ratings, dispute resolution.

Scope estimate: ~6 tasks. Includes a new billing service and
integrations with regional payment providers (ZainCash, FIB, card
networks).

---

## Epic P4-F — Wave 2 templates (manufacturing / healthcare /

education / hospitality / automotive)

RFC §16.4 names the five verticals. Each vertical is one L1 template
with 10–20 Entity overlays, a handful of Workflows, a reference
permission matrix, and a compliance pack.

Scope estimate: ~10 tasks (2 per vertical: "draft template" and
"pilot with reference customer").

---

## Exit criterion (RFC §16.5)

Multi-region operational, marketplace open, Wave 2 templates
shipped, 200+ tenants live.

At the start of Phase 4, decompose these six epics into PR-sized
TASK-6x … TASK-N in `phase-4-tasks.md`.
