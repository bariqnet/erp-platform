# ERP-RFC-001 · Metadata-Driven Customization Platform

**Status:** Draft — Open for Engineering Review
**Author:** Bariq (sponsor) — drafted by Platform Architecture
**Target release:** Platform v1.0 (Phase 1), Configuration Studio GA (Phase 2)
**Related:** Class A Global ERP — Master Features Plan; Extension Volume II §20
**Version:** 1.0 · April 2026

---

## Summary

This RFC defines the technical architecture of the customization platform that sits at the core of the ERP — the mechanism by which one codebase serves many tenants, each with their own industry-shaped configuration, without ever forking source code. Customizations are expressed as metadata stored in a versioned, tenant-partitioned store, resolved at runtime through a five-layer overlay algorithm, and rendered by an Application Kernel that materializes entities, views, and workflows dynamically. Every configuration change is upgrade-safe by construction because the vendor core never overwrites customer layers.

The document specifies the metadata object model, the storage schema in PostgreSQL, the resolution algorithm with conflict handling, the caching and invalidation strategy, the admin and runtime APIs, the multi-tenant isolation guarantees, the performance SLOs, and a four-phase delivery plan covering approximately eighteen months of engineering work.

## Goals

1. A single codebase that serves an unlimited number of tenants, each with per-tenant customizations at the schema, workflow, UI, report, and permission layers.
2. Configuration changes expressible visually through the Configuration Studio, without writing code for 80%+ of customer needs.
3. Upgrade-safe overlays — vendor releases never overwrite customer configurations, and tenant extensions are automatically compatibility-tested against new core releases.
4. Sub-millisecond steady-state metadata read latency at p99, supporting request-path rendering without I/O.
5. Strict multi-tenant isolation enforced at four independent planes (database, runtime, execution, AI).
6. Full audit trail of every metadata change, approval, and deploy — retained indefinitely, exportable for compliance.
7. Rollback of any change in O(1) — pointer updates, not data restores.

## Non-Goals

- Replacing source code for all functionality. The core engine itself (authentication, billing, email delivery, payment integrations, numerical tax engines) remains implemented in code.
- Exposing a general-purpose SQL interface to customers. Metadata edits flow through controlled APIs only.
- Supporting dynamic schema migrations of the base transactional tables at runtime. Custom fields extend entities through a defined mechanism (§6.4), not ad-hoc DDL.
- Providing a drag-and-drop designer in v1. Early phases expose metadata primarily through a structured admin API; the visual Configuration Studio is a separate delivery phase consuming these APIs.

## Glossary

| Term | Definition |
|------|------------|
| **Metadata** | Declarative definitions of business objects, relationships, workflows, views, permissions, etc. Stored as data, not code. |
| **Application Kernel** | The runtime that reads metadata on each request and constructs the UI, API, validation chain, and data access path dynamically. |
| **Layer** | A level in the metadata overlay stack. Five are defined: L0 (Core), L1 (Template), L2 (Tenant Config), L3 (Tenant Extensions), L4 (Custom Code). |
| **Overlay** | A metadata definition in a higher layer that modifies or replaces a definition in a lower layer. |
| **Resolution** | The runtime process of computing the effective metadata for an entity by walking layers top-down. |
| **Change Set** | A bundle of proposed metadata changes that is reviewed and deployed atomically. |
| **Tenant** | A single customer organization. All data and metadata are partitioned by `tenant_id`. |
| **Package** | A distributable unit of metadata — a template, a compliance pack, or a partner extension. |
| **Materialization** | Compilation of resolved metadata into optimized runtime representations (cached ORM, validator chain, UI component tree). |
| **Tombstone** | A marker in a higher layer that deletes an inherited definition from a lower layer. |

---

## 1. Architecture Overview

The platform separates three concerns that are conflated in legacy ERP architectures: how the business is defined (metadata), how the business is executed (runtime kernel), and how the business stores its data (transactional store). Each has its own schema, its own change lifecycle, and its own scaling profile.

### 1.1 High-Level Component Diagram

The system is composed of seven first-class components, each independently deployable:

```
+--------------------------------------------------------------+
|                     Client Surfaces                          |
|   Web Console  ·  Mobile App  ·  Public API  ·  AI Agent     |
+-----------------------------+--------------------------------+
                              |
+-----------------------------v--------------------------------+
|                    Application Kernel                        |
|   Request Router · Auth · Permission Gate · Rate Limiter     |
|   Metadata Resolver · Entity Materializer · Validator        |
|   View Renderer    · Workflow Engine     · Automation Engine |
+----+-----------+------------+-------------+------------+-----+
     |           |            |             |            |
     v           v            v             v            v
+---------+  +-------+  +-----------+  +---------+  +--------+
| Meta-   |  | Ops   |  | Analytics |  | Event   |  | Script |
| data    |  | Data  |  | Store     |  | Bus     |  | Sand-  |
| Store   |  | (PG)  |  | (HANA/CH) |  | (Kafka) |  | box    |
| (PG)    |  |       |  |           |  |         |  |        |
+---------+  +-------+  +-----------+  +---------+  +--------+
```

### 1.2 Request Lifecycle

A typical write request flows through seven stages. Steps 2–5 all read from the Metadata Store — through the cache — before any operational data is touched:

1. Client sends authenticated request with tenant context to Application Kernel.
2. Router resolves the target entity; Permission Gate verifies the caller's role has the required privilege on the resolved entity.
3. Metadata Resolver walks layers L4→L0 and produces the effective metadata for the entity; result is cached per `(tenant_id, entity_name, metadata_version)`.
4. Entity Materializer constructs a validator chain and an ORM binding from the effective metadata.
5. Validator runs type-checks, formulas, cross-field rules, and referential integrity.
6. Operational write is applied to the Ops Data store inside a transaction that also emits domain events to the Event Bus.
7. Automation Engine consumes events asynchronously and triggers downstream actions (notifications, cross-entity updates, webhooks, AI prompts).

### 1.3 Three Independent Schemas

The platform uses three distinct schemas with different lifecycle characteristics:

| Schema | Content | Change Rate | Backup Strategy |
|--------|---------|-------------|-----------------|
| **metadata** | Layer definitions, resolution snapshots, change log | Minutes to hours | Continuous WAL; instant point-in-time restore |
| **ops** | Transactional business data (invoices, orders, etc.) | Seconds to milliseconds | Hourly snapshots; PITR to the minute |
| **analytics** | Columnar copy for reporting and AI retrieval | Near real-time CDC | Rebuildable from ops; daily snapshot for convenience |

> **Design Principle.** Metadata is the system of record for how the business is defined. Ops data is the system of record for what the business did. Keeping these separate is what makes per-tenant customization scalable — you can roll back a workflow change without affecting any transactional record, and you can audit every definitional change independently of operational activity.

---

## 2. Metadata Object Model

All metadata conforms to a typed object model. Eight top-level object types are defined; every object has a stable identifier, a layer attribution, a version, and a JSON body whose shape is validated by a layer-specific JSON Schema.

### 2.1 Common Envelope

Every metadata object, regardless of type, carries the same envelope fields:

```json
{
  "object_id":        "ent.customer",
  "object_type":      "Entity",
  "layer":            "L2",
  "tenant_id":        "t_4f8a3c",
  "template_id":      "tpl.retail_multi_store.v2",
  "version":          37,
  "valid_from":       "2026-04-15T09:30:00Z",
  "valid_until":      null,
  "created_by":       "u_7b2f",
  "created_via":      "configuration_studio",
  "change_set_id":    "cs_9e4a",
  "body":             { /* type-specific payload */ }
}
```

The envelope is the only thing the resolver needs to reason about overlays; everything else is type-specific.

### 2.2 Object Types

| Type | ID Prefix | Purpose |
|------|-----------|---------|
| Entity | `ent.` | Business object definition (fields, relationships, lifecycle, indexing hints) |
| Field | `fld.` | A typed attribute on an entity (only used for standalone field definitions; most fields are nested inside Entity) |
| Relationship | `rel.` | Typed connection between entities, with cascade and integrity rules |
| Workflow | `wfl.` | State machine definition (states, transitions, guards, SLA timers, actions) |
| View | `vw.` | Rendered surface (form, list, dashboard, report) composed from widgets |
| Automation | `aut.` | Trigger-condition-action rule |
| Permission | `prm.` | Role definition plus entity/field/record-level grants |
| Localization | `loc.` | Per-locale overrides for labels, formats, and text |

### 2.3 Entity Definition

The Entity type is the most complex. A simplified but representative Entity body:

```json
{
  "name":          "Customer",
  "plural":        "Customers",
  "label":         { "en": "Customer", "ar": "عميل" },
  "icon":          "users",
  "description":   "A person or organization that purchases goods or services.",
  "storage":       { "table": "cust_customer", "strategy": "hybrid" },
  "fields": [
    {
      "name":       "code",
      "type":       "string",
      "required":   true,
      "unique":     true,
      "max_length": 32,
      "label":      { "en": "Code", "ar": "الرمز" }
    },
    {
      "name":       "name",
      "type":       "string",
      "required":   true,
      "max_length": 255,
      "i18n":       true
    },
    {
      "name":       "credit_limit",
      "type":       "money",
      "currency_field": "currency",
      "default":    0,
      "validate":   "credit_limit >= 0"
    },
    {
      "name":       "tax_id",
      "type":       "string",
      "max_length": 64,
      "validate":   "tax_id == null || is_valid_tax_id(tax_id, country)"
    }
  ],
  "relationships": [
    { "name": "primary_contact", "type": "many_to_one", "target": "ent.contact", "cascade": "nullify" },
    { "name": "invoices",        "type": "one_to_many", "target": "ent.invoice", "via": "customer_id" }
  ],
  "lifecycle": {
    "states":      ["draft", "active", "on_hold", "archived"],
    "initial":     "draft",
    "workflow_id": "wfl.customer_lifecycle"
  },
  "indexes": [
    { "fields": ["code"],          "unique": true },
    { "fields": ["name", "tenant_id"] },
    { "fields": ["tax_id"],        "where": "tax_id IS NOT NULL" }
  ],
  "permissions_base": "prm.customer_defaults",
  "audit": true
}
```

### 2.4 Field Types

The runtime supports 30+ field types. A representative sample:

| Type | Storage | Notes |
|------|---------|-------|
| `string` | text | Optional `max_length`, `i18n` flag, regex validator |
| `localized_string` | jsonb `{locale: str}` | Explicit multi-language values with fallback rules |
| `integer` | bigint | Range constraints |
| `decimal` | numeric(p, s) | Precision and scale fixed at metadata layer |
| `money` | bigint (minor units) | Paired with `currency_field`; always integer math (IQD/fils, USD/cents) |
| `boolean` | boolean | Tri-state (true/false/null) with explicit default |
| `date` | date | Optional Hijri/Gregorian display mode |
| `datetime` | timestamptz | Always UTC at rest; tenant-TZ aware display |
| `enum` | smallint (coded) | Values defined as ordered list; codes stable on rename |
| `reference` | bigint (FK) | Typed reference to another entity |
| `attachment` | uuid + object-store | Binary stored out of row in S3-compatible store |
| `formula (computed)` | virtual | Expression over other fields; materialized as generated column when possible |
| `json` | jsonb | Free-form; validated against optional JSON Schema |
| `phone` | text | Country-aware validation; stored E.164 normalized |
| `national_id` | text | Country-specific checksum validators |

### 2.5 Workflow Definition

Workflows are finite state machines expressed declaratively. A simplified example:

```json
{
  "entity":  "ent.purchase_order",
  "states":  ["draft", "submitted", "approved", "partial", "received", "closed", "cancelled"],
  "initial": "draft",
  "transitions": [
    { "from": "draft",     "to": "submitted",
      "trigger": "user_action:submit",
      "guards":  ["po.total > 0", "has_line_items(po)"] },
    { "from": "submitted", "to": "approved",
      "trigger": "user_action:approve",
      "required_role": "role.po_approver",
      "guards":  ["po.total <= approver.limit"] },
    { "from": "approved",  "to": "partial",
      "trigger": "event:goods_received",
      "guards":  ["grn.qty < po.qty"] },
    { "from": ["approved", "partial"], "to": "received",
      "trigger": "event:goods_received",
      "guards":  ["total_received(po) >= po.qty"] }
  ],
  "slas": [
    { "state": "submitted", "max_duration": "P2D", "on_breach": "aut.po_escalation" }
  ],
  "notifications": [
    { "on_transition": "submitted→approved", "template": "notif.po_approved" }
  ]
}
```

> **Workflow Versioning Rule.** A running workflow instance is pinned to the version it started on. Updating the workflow definition creates a new version; in-flight instances continue on their pinned version until they reach a terminal state. This prevents mid-flight semantic changes and is required for audit integrity.

---

## 3. Layered Resolution Algorithm

Given a request for an entity definition from a caller in a specific tenant, the resolver returns the effective metadata by walking layers top-down and merging. This section specifies the exact algorithm.

### 3.1 Layer Definitions

| Layer | Name | Owner | Scope | Lifetime |
|-------|------|-------|-------|----------|
| L0 | Core | Vendor | All tenants | Bound to platform release |
| L1 | Industry Template | Vendor/Partner | Tenants subscribing to that template | Template version |
| L2 | Tenant Configuration | Customer | Single tenant | Owned by tenant |
| L3 | Tenant Extensions | Customer | Single tenant | Owned by tenant |
| L4 | Custom Code | Partner | Opt-in per tenant | Tied to extension version |

### 3.2 Resolution Algorithm

For any metadata read request, resolution is a deterministic pure function of the tenant's layer configuration and the object being resolved:

```
function resolve(tenant_id, object_id) -> ResolvedObject:
    layers = get_active_layers(tenant_id)   // ordered L0..L4
    effective = null

    for layer in layers:                    // bottom-up
        candidate = fetch(layer, object_id)
        if candidate is null:
            continue

        if candidate.operation == "tombstone":
            effective = null                // inheritance deleted
            continue

        if effective is null:
            effective = deep_copy(candidate.body)
        else:
            effective = merge(effective, candidate.body, candidate.merge_strategy)

        effective.provenance.append({
            layer:     layer,
            version:   candidate.version,
            object_id: candidate.object_id
        })

    if effective is null:
        raise ObjectNotFound(object_id)

    return effective
```

### 3.3 Merge Strategies

Each metadata field in each object type carries a merge-strategy annotation that the resolver uses to combine layers. Four strategies cover all cases:

| Strategy | Behavior | Example Use |
|----------|----------|-------------|
| `replace` | Higher layer wins outright | Entity label, icon, description |
| `merge_object` | Deep-merge keys; recursive replace on conflicts | Settings blocks, localization bundles |
| `append` | Higher layer's list appended to lower layer's | Additional fields, additional automations |
| `merge_list_by_key` | Lists merged by entry key; upper overrides matching entries | Fields list (by field name), transitions (by from+trigger) |

### 3.4 Tombstones

A tombstone is an explicit marker in a higher layer saying "remove the inherited definition." Without tombstones, tenants could not remove fields, workflows, or automations defined in the template.

```json
{
  "object_id":  "ent.customer.field.tax_id",
  "operation":  "tombstone",
  "layer":      "L2",
  "tenant_id":  "t_4f8a3c",
  "reason":     "Tenant does not collect tax IDs; field hidden from all forms."
}
```

Tombstones are audit-tracked and reversible. Their resolution semantics are specified: once a tombstone is encountered during resolution, the resolver resets the effective value to null for that object, and lower layers no longer contribute.

### 3.5 Conflict Handling

Conflicts arise when a template upgrade introduces an object that already exists in the tenant's L2 or L3 layer — for example, a new template version adds field `loyalty_tier` on Customer, but the tenant already defined a field with that name. The resolver does not silently merge; it surfaces the conflict:

- **Structural conflict** — same name, incompatible types. Resolution is halted and the object is flagged as requiring admin intervention. The tenant continues on the prior template version until resolution.
- **Compatible drift** — same name, compatible types (e.g., same type but different default). The resolver applies the merge strategy and records a conflict resolution note in the audit log.
- **Namespace collision** — prevented at authoring time by reserving vendor namespaces (`sys_`, `core_`) that tenant layers cannot use.

### 3.6 Resolution Determinism

Resolution is a pure function: same inputs always produce the same output. This lets the resolver cache aggressively, lets the system snapshot an effective metadata view at any point in time (for audit or rollback), and makes resolution a safe building block for the AI Specialist's `simulate_change` tool.

---

## 4. Storage Model

Metadata lives in PostgreSQL in its own schema, separate from operational data. The design prioritizes (a) fast per-(tenant, object) reads, (b) cheap versioning via append-only writes, (c) efficient cache invalidation, and (d) strict tenant partitioning.

### 4.1 Core Tables

```sql
-- Every metadata object, every version, every layer, in one table.
CREATE TABLE meta_object (
    object_pk        BIGSERIAL PRIMARY KEY,
    object_id        TEXT        NOT NULL,       -- e.g. 'ent.customer'
    object_type      TEXT        NOT NULL,       -- 'Entity', 'Workflow', ...
    layer            TEXT        NOT NULL,       -- 'L0'..'L4'
    tenant_id        TEXT,                       -- null for L0/L1
    template_id      TEXT,                       -- non-null for L1 only
    version          INT         NOT NULL,
    operation        TEXT        NOT NULL
                     DEFAULT 'upsert'
                     CHECK (operation IN ('upsert','tombstone')),
    body             JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       TEXT        NOT NULL,
    created_via      TEXT        NOT NULL,
    change_set_id    TEXT        NOT NULL,
    valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until      TIMESTAMPTZ,                -- set when superseded
    UNIQUE (object_id, layer, tenant_id, version)
);

-- Fast lookup for the "currently active" row in a given layer/tenant.
CREATE INDEX idx_meta_object_current
    ON meta_object (object_id, layer, tenant_id)
    WHERE valid_until IS NULL;

-- Grouping of related changes.
CREATE TABLE meta_change_set (
    change_set_id    TEXT        PRIMARY KEY,
    tenant_id        TEXT        NOT NULL,
    status           TEXT        NOT NULL CHECK
                     (status IN ('draft','proposed','approved','deployed','rolled_back')),
    description      TEXT,
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by      TEXT,
    approved_at      TIMESTAMPTZ,
    deployed_at      TIMESTAMPTZ,
    rolled_back_at   TIMESTAMPTZ
);

-- Which layers are active for a tenant, and which version of each.
CREATE TABLE meta_layer_activation (
    tenant_id        TEXT        NOT NULL,
    layer            TEXT        NOT NULL,
    source_id        TEXT        NOT NULL,       -- e.g. template id or tenant id
    version          TEXT        NOT NULL,       -- semver for L1/L4
    activated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_by     TEXT        NOT NULL,
    PRIMARY KEY (tenant_id, layer)
);

-- Full-text + structured audit trail.
CREATE TABLE meta_audit_log (
    audit_pk         BIGSERIAL PRIMARY KEY,
    tenant_id        TEXT,
    actor_id         TEXT        NOT NULL,
    action           TEXT        NOT NULL,
    target_type      TEXT,
    target_id        TEXT,
    change_set_id    TEXT,
    before_hash      TEXT,                       -- sha256 of prior state
    after_hash       TEXT,
    diff             JSONB,
    context          JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.2 Custom Field Storage Strategy

Custom fields added by tenants need somewhere to live. Three strategies are combined depending on usage shape:

| Strategy | When Used | Pros | Cons |
|----------|-----------|------|------|
| Native column | High-cardinality, high-selectivity custom fields | Full PostgreSQL indexing; typed checks | Requires background migration on add |
| JSONB extension | Moderate-use custom fields | No migration; flexible schema | Index less efficient; harder ad-hoc queries |
| Side table | Large text/blob custom fields | Keeps main row narrow | Extra join on retrieval |

The Application Kernel decides the strategy at custom-field creation time using heuristics (type, expected volume, index hint) and can migrate fields between strategies online without downtime using the Migration Primitives (§11.3).

### 4.3 Tenant Partitioning

Every metadata table carries `tenant_id` as part of every non-global primary key; every query goes through a session parameter that pins the tenant. Two defense layers are enforced:

- **ORM layer** — repository base class injects `tenant_id` into every `WHERE` clause; queries without a tenant context raise at compile time.
- **Database layer** — PostgreSQL row-level security policies activated on all metadata tables; a session variable set at connection check-out enforces policy-level filtering regardless of what the application sends.

### 4.4 Immutable Versioning

Metadata rows are never updated in place. A new version is a new row with an incremented version number. The prior row has its `valid_until` set. Rollback is a matter of flipping `valid_until` back to null on the previous row and invalidating the cache. This yields two durable properties:

- Any configuration state at any historical timestamp can be reconstructed deterministically.
- Rollback is constant-time; no data restore or replay is required.

---

## 5. Application Kernel

The Application Kernel is the runtime that turns resolved metadata into executable behavior. It is the only component that reads metadata on request paths; every other service interacts with the Kernel via the Runtime API (§9.2).

### 5.1 Responsibilities

- **Metadata resolution** — walk layers and produce effective definitions (caches aggressively)
- **Entity materialization** — compile metadata into runtime structures: ORM mappers, validator chains, serializers
- **View rendering** — transform View metadata into JSON for the UI, or HTML/PDF for reports
- **Workflow execution** — evaluate guards, execute transitions, enforce SLAs
- **Automation dispatch** — listen to events, evaluate conditions, invoke actions
- **Permission checking** — evaluate RBAC + record-level security before any read or write

### 5.2 Materialization Pipeline

When the Kernel receives the first request for an entity since a metadata version bump, it runs a materialization pipeline. Output is cached keyed by `(tenant_id, entity_name, metadata_version)` and served on subsequent requests from memory:

```
Stage 1 — RESOLVE:      walk layers, produce effective definition
Stage 2 — VALIDATE:     check internal consistency (FK targets exist, enum codes unique, etc.)
Stage 3 — COMPILE:
    · build ORM class with typed fields and relationship accessors
    · build validator chain (required, format, range, cross-field, custom formulas)
    · build serializer for each supported format (JSON, RTL-aware PDF, etc.)
    · compile permission resolver (RBAC + row-level predicates)
Stage 4 — CACHE:        install into per-process LRU, keyed by version
Stage 5 — PUBLISH:      emit 'entity_materialized' event for observability
```

### 5.3 Caching Layers

Three cache tiers cover the read path:

| Tier | Location | Keyed By | Hit Ratio Target | Invalidation |
|------|----------|----------|------------------|--------------|
| L1 in-process | Application node | `(tenant, object, version)` | >99% steady state | Version-bump → key rotates |
| L2 shared | Redis cluster | `(tenant, object, version)` | >95% cold path | TTL + explicit evict on deploy |
| L3 source | Metadata PG | primary key | Always correct | Source of truth |

Because resolution is deterministic given `(tenant, object, version)`, cache keys are append-only — a new version creates a new key rather than mutating an old one. This eliminates classic cache-invalidation race conditions: old readers continue to hit the old key until they themselves load the new version.

### 5.4 Event-Driven Invalidation

When a Change Set deploys, the metadata store emits a `metadata_deployed` event over the Event Bus. Kernel nodes subscribe; each evicts the affected L1 entries, and Redis evicts L2 entries on the same signal. Propagation p95 target: under 500ms across the fleet.

### 5.5 Cold-Start Performance

On a cold node, the first request for an entity incurs the full materialization pipeline — approximately 20–80ms in typical conditions. Every subsequent request hits L1 and responds in sub-millisecond time. To smooth cold starts, the Kernel pre-warms the top-100 most-used entities per tenant at startup, parallelized across a dedicated thread pool.

---

## 6. Custom Objects & Fields

Customers can extend the model in two ways: adding fields to vendor entities, or defining entirely new entities. Both flow through the metadata system, not through DDL issued by users.

### 6.1 Adding a Custom Field

Adding a field to Customer is a single metadata write to L2:

```http
POST /admin/v1/metadata/changes
{
  "change_set_id": "cs_9e4a",
  "operations": [{
    "op":       "add_field",
    "entity":   "ent.customer",
    "field": {
      "name":     "loyalty_tier",
      "type":     "enum",
      "values":   ["bronze", "silver", "gold", "platinum"],
      "default":  "bronze",
      "label":    { "en": "Loyalty Tier", "ar": "مستوى الولاء" },
      "indexed":  true,
      "storage":  "auto"
    }
  }]
}
```

On deploy, the Kernel chooses the storage strategy (§4.2), issues the corresponding migration through the Migration Primitives (§11.3) if the native-column strategy is chosen, waits for completion, and atomically rotates the materialized entity version. No downtime; concurrent reads continue on the old version until the new one is fully ready.

### 6.2 Creating a Custom Entity

A custom entity declaration is a complete Entity object in the L3 layer, with `storage.strategy` set appropriately (typically `hybrid`). The Kernel auto-provisions the backing table with the base columns (`tenant_id`, `id`, `created_at`, `updated_at`, `status`, `data jsonb`) and adds indexed columns for fields marked `indexed: true`.

### 6.3 Relationships to Vendor Entities

A custom entity can declare relationships to vendor entities:

```json
{
  "name": "Voyage",
  "fields": [
    { "name": "name",       "type": "string", "required": true },
    { "name": "load_port",  "type": "string" },
    { "name": "discharge_port", "type": "string" }
  ],
  "relationships": [
    { "name": "customer",
      "type": "many_to_one",
      "target": "ent.customer",
      "cascade": "restrict" }
  ]
}
```

Relationships from a tenant's custom entity to a vendor entity are fully supported and audited. Reverse navigation (`customer.voyages`) is optional; when enabled, the Kernel compiles a view-only accessor that does not alter vendor entity storage.

### 6.4 Impact Analysis on Destructive Changes

Removing a field, changing its type, or deleting an entity triggers the Impact Analyzer before deploy:

- Count of records currently holding a non-null value in the field being removed.
- Reports, dashboards, workflows, automations, and permissions referencing the field.
- Downstream integrations with the field in their payload mapping.
- Active extensions that read the field via SDK.

Breaking changes require explicit admin confirmation; Impact Report is archived with the Change Set for audit.

---

## 7. Scripting & Extensions

Configuration is not always enough. Two execution surfaces are available for behavior beyond what Automations can express: Low-Code Scripts (L3) and Pro-Code Extensions (L4). Both run in sandboxes that are isolated per tenant.

### 7.1 Low-Code Scripts (L3)

Scripts are short, stateless functions written in a TypeScript subset. They expose a narrow API and run in a hardened V8 isolate.

```typescript
// script: on_invoice_posted — adjust customer credit when invoice posts
import { system, entities } from "@erp/script";

export async function onInvoicePosted(event: InvoiceEvent) {
  const invoice = event.record;
  const customer = await entities.customer.get(invoice.customer_id);

  const remaining = customer.credit_limit - invoice.total;
  if (remaining < 0) {
    system.log.warn("customer_over_limit", { customer_id: customer.id });
    await system.notifications.send("credit.manager", "notif.customer_over_limit", {
      customer_id: customer.id,
      overdraft:   -remaining
    });
  }

  return { outstanding: customer.outstanding + invoice.total };
}
```

### 7.2 Script Sandbox Guarantees

| Control | Limit |
|---------|-------|
| CPU budget | 200ms per invocation (configurable to 2s by tenant plan) |
| Memory budget | 128 MB per isolate |
| Wall clock | 5s max, hard-killed on breach |
| Filesystem | None — no fs access of any kind |
| Raw network | None — all outbound via allowlisted connector SDK |
| Tenant isolation | Isolate is disposed after execution; zero shared memory |
| Cross-tenant read | Impossible — tenant context bound cryptographically to the script context |
| Syscalls | None — isolate has no OS bridge |

### 7.3 Pro-Code Extensions (L4)

Extensions are full modules distributed as packages. Each extension declares its manifest, its requested permissions, and its compatibility range against platform versions. Approval, deployment, and lifecycle mirror the Change Set flow (§9.3).

### 7.4 Compatibility Harness

Every tenant script and extension is exercised against pre-release core builds in an isolated shadow environment. The harness replays recorded inputs and asserts behavioral equivalence; any divergence is surfaced to the extension author and the tenant admin with N releases of advance notice before the new core is published. This is the mechanism that keeps Layer 3 and Layer 4 upgrade-safe in practice, not just in principle.

---

## 8. Templates & Packages

Templates, compliance packs, and partner extensions all ship as Packages — a single container format with a manifest, a set of metadata objects, optional scripts, optional extensions, and a content bundle (demo data, documentation, sample reports).

### 8.1 Package Manifest

```json
{
  "package_id":       "tpl.retail_multi_store",
  "package_type":     "template",
  "semver":           "2.3.1",
  "name":             { "en": "Retail Multi-Store", "ar": "متاجر التجزئة متعددة الفروع" },
  "vendor":           "platform",
  "requires": {
    "platform":       "^1.4",
    "packs":          ["compliance.arabic_rtl@^1", "compliance.iraqi_tax@^2"]
  },
  "layers": [
    { "target_layer": "L1", "includes": ["metadata/**/*.json"] },
    { "target_layer": "L3", "includes": ["scripts/**/*.ts"],   "optional": true }
  ],
  "demo_data":        "bundles/demo.jsonl.gz",
  "migrations":       "migrations/",
  "documentation":    "docs/",
  "preview":          "preview/screenshots/",
  "ai_priming":       "ai/priming.md"
}
```

### 8.2 Installation Flow

1. Package signature verified against the publisher's trust root.
2. Compatibility checked against platform version and tenant's currently active packs.
3. Impact Analyzer produces a diff: what will be added, modified, or conflict.
4. Admin reviews and approves. Package metadata is loaded into the tenant's L1 layer (templates), L3 layer (scripts), or L4 layer (extensions).
5. Demo data is inserted if opted-in (production installs typically decline demo data).
6. AI Specialist priming context is attached to the tenant's AI profile.
7. Audit entry records the install event with full manifest hash.

### 8.3 Upgrading a Package

Tenants can pin a package version; upgrades are an opt-in action. When upgrading, the same conflict-resolution rules apply as for any layered merge (§3.5). Minor and patch upgrades are typically transparent; major upgrades present an admin-facing changelog and may require explicit acceptance of breaking changes.

---

## 9. API Surface

Three distinct API surfaces are exposed: the Admin API (for metadata authoring and governance), the Runtime API (for operational data), and the Change-Set API (for orchestrating proposals, reviews, and deployments). All are versioned, authenticated, tenant-scoped, and rate-limited.

### 9.1 Admin API (Metadata)

REST + GraphQL. Read access is broadly available to admins; write access requires the `metadata.write` privilege and is always scoped to a Change Set.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/v1/metadata/objects` | List metadata objects (filterable by type, layer, tenant) |
| GET | `/admin/v1/metadata/objects/{id}` | Fetch the resolved metadata for an object (optionally per-layer) |
| GET | `/admin/v1/metadata/objects/{id}/history` | Version history for an object |
| POST | `/admin/v1/metadata/changes` | Attach operations to a Change Set (draft) |
| POST | `/admin/v1/metadata/changes/{id}/simulate` | Dry-run resolution with proposed changes (no write) |
| POST | `/admin/v1/metadata/changes/{id}/propose` | Move Change Set to 'proposed' state |
| POST | `/admin/v1/metadata/changes/{id}/approve` | Approve (requires appropriate role) |
| POST | `/admin/v1/metadata/changes/{id}/deploy` | Deploy atomically; returns operation id |
| POST | `/admin/v1/metadata/changes/{id}/rollback` | Instant rollback (pointer flip) |

### 9.2 Runtime API (Operational Data)

Every entity gets automatic REST and GraphQL endpoints derived from its metadata. For `ent.customer`, the Kernel publishes: `GET /v1/customers`, `GET /v1/customers/{id}`, `POST /v1/customers`, `PATCH /v1/customers/{id}`, `DELETE /v1/customers/{id}`, plus named actions (`POST /v1/customers/{id}/actions/activate`, etc.) for every workflow transition. All requests pass through the Permission Gate; schema, validation, and serialization are all derived from resolved metadata.

### 9.3 Change-Set API

The Change Set is the atomic unit of configuration deployment. Its lifecycle is a strict state machine:

```
draft ──(propose)──▶ proposed ──(approve)──▶ approved ──(deploy)──▶ deployed
  ▲                   │                                          │
  └─── (revert) ──────┘                                          ▼
                                                             rolled_back
```

Transitions carry authorization rules (drafting is self-service; approval requires approver role; deploy requires a separate deployer role for SOX-sensitive tenants) and optional notification hooks. Change Sets can reference prior Change Sets as dependencies for ordered deployments.

### 9.4 Simulation Before Commit

`simulate_change` is a first-class API. Given a Change Set, the resolver computes the effective metadata that would result, the Impact Analyzer runs, and results are returned to the caller — without any write. This is what powers both the Configuration Studio's preview mode and the AI Specialist's `simulate_change` tool.

---

## 10. Multi-Tenant Isolation Enforcement

Isolation between tenants is a correctness property, not a performance property. It is enforced in four independent planes so that a bug, misconfiguration, or compromise in any one plane does not cause a cross-tenant breach.

### 10.1 Database Plane

- Every metadata and operational table includes `tenant_id` in the primary key (compound PKs where necessary).
- PostgreSQL row-level security (RLS) policies enabled on all tenant-scoped tables; bypass requires the superuser role, which no application user holds.
- Connection pooling sets a `session_replication_role` and sets `app.current_tenant` on check-out; RLS policies read this variable.
- Cross-tenant queries in any admin tooling are explicit and logged.

### 10.2 Runtime Plane

- Every request carries a signed Tenant Context token (`tenant_id` + role + session).
- Application Kernel refuses any operation whose resolved target tenant differs from the token tenant.
- Caches are keyed on `tenant_id` as part of the primary cache key; no global caches exist that could leak metadata or data.
- Event Bus topics are tenant-suffixed; subscribers receive only the tenant they are authorized for.

### 10.3 Execution Plane

- Low-Code scripts run in freshly-provisioned V8 isolates; disposed after use.
- Pro-Code extensions run in per-extension containers with tenant-scoped credential injection; credentials never persist to disk.
- Workflow and Automation engines are tenant-sharded; a runaway automation cannot exhaust capacity in another tenant's shard.

### 10.4 AI Plane

- AI Specialist sessions carry the tenant context cryptographically and cannot be reused across tenants.
- RAG retrieval indexes are physically partitioned per tenant; the retriever cannot request documents outside the current tenant.
- Long-term conversation memory is tenant-partitioned; vendor-side analytics on AI usage is aggregate-only and unlinkable.
- Model context window includes a tenant-binding statement that the model is trained/prompted to honor; grounding and output filtering verify tenant binding on every response.

---

## 11. Versioning, Upgrades & Compatibility

### 11.1 Semantic Versioning of Layers

Every layer source (core, template, extension) publishes a semver. Compatibility is expressed with caret and tilde ranges against the platform and against other packages. The resolver refuses to activate a layer whose compatibility range is not satisfied.

### 11.2 Deprecation Policy

- Breaking changes to any public API require dual-version deprecation: the old behavior is flagged deprecated one release before the new behavior becomes default, and removed no earlier than two major versions later.
- Deprecated APIs emit warnings to admin audit logs with links to the migration guide.
- Vendor-maintained templates publish a changelog with each release; AI Specialist presents it conversationally when a tenant considers upgrading.

### 11.3 Migration Primitives

Schema-level changes (adding native columns, changing column types, moving storage strategy) use a set of online migration primitives modeled on established patterns:

- **Dual-write migration** — new column added with NULL default, code writes to both old and new, back-fill runs in batches, switchover to read-from-new, old column dropped in a follow-up deploy.
- **Shadow-read verification** — during transition, reads from both sources are compared; any divergence aborts the migration.
- **Online index build** — `CREATE INDEX CONCURRENTLY`; progress-tracked; interruptible.
- **Backfill throttling** — migration workers respect tenant-level CPU and I/O budgets so long-running migrations do not degrade tenant performance.

### 11.4 Rollback

Because metadata is immutable-versioned, rollback of a metadata change is a pointer update: `meta_change_set.status` moves from deployed back to approved, the prior `meta_object` rows have `valid_until` reverted to null, and the `metadata_rolled_back` event invalidates caches. Rollback of a custom-field storage migration requires the reverse migration primitive to run; rollback semantics are tracked per operation and presented to admins before any deploy.

---

## 12. Performance & SLOs

The platform's customization mechanism sits on every request path, so its performance determines the performance of the entire ERP. Targets below are sized for a tenant of 50,000 active records per major entity and 200 requests per second sustained.

| Metric | Target (p50) | Target (p99) | Measurement |
|--------|-------------|--------------|-------------|
| Metadata resolution (L1 hit) | < 0.1 ms | < 0.5 ms | Per call in-process |
| Metadata resolution (L2 hit) | < 2 ms | < 8 ms | Including Redis round-trip |
| Cold resolution + materialization | < 30 ms | < 150 ms | First request after version bump |
| Entity read (simple by id) | < 5 ms | < 25 ms | End-to-end, cache-warm |
| Entity list (50 rows, 5 fields) | < 15 ms | < 60 ms | End-to-end, cache-warm |
| Change Set deploy | < 500 ms | < 2 s | End-to-end; cache propagation under 500ms p95 |
| Cache invalidation propagation | < 200 ms | < 500 ms | Per-node across a 50-node fleet |
| Audit write | < 2 ms | < 10 ms | Asynchronous; never blocks user request |
| Custom field add (JSONB) | < 1 s | < 3 s | Pure metadata; no table migration |
| Custom field add (native column) | < 60 s / M rows | < 5 min / M rows | Depends on row count; throttled |

### 12.1 Scaling Profile

Metadata reads scale horizontally via stateless Kernel nodes, bounded by Redis L2 capacity. Redis is deployed in a clustered topology with consistent hashing on `tenant_id`, so a single tenant's working set stays colocated. Metadata writes are low-volume (hundreds per day per tenant even for heavily customized tenants) and can run on a primary-with-replicas Postgres topology without sharding.

### 12.2 Capacity Planning Assumptions

- 100,000 tenants per region cluster
- Average 1,200 resolved metadata objects per tenant (base template + customizations)
- Average 500 requests per tenant per minute at peak; top 1% of tenants reach 10,000 requests per minute
- Metadata working set per tenant: ~4 MB serialized, ~40 MB materialized
- Ops data working set per tenant: highly variable, sized per tenant plan

---

## 13. Security

### 13.1 Permission Resolution Order

On every operation, the Permission Gate evaluates permissions in a fixed order; the first DENY short-circuits; if no grant is found the operation is denied by default:

1. Role-based entity-level grants (can this role read/write this entity at all).
2. Field-level grants (which fields in the entity this role can read or write).
3. Record-level predicates (which specific rows this role can see/mutate, evaluated as SQL predicates compiled from metadata).
4. Delegated permissions (temporary grants for approval workflows).
5. Implicit owner-of-record grants if the entity declares `owner_field`.

### 13.2 Audit Log Guarantees

- Every metadata change, read of sensitive data, permission check failure, and privileged action is logged.
- Log rows are chained with hash linking (each row carries a hash of the previous) making tampering detectable.
- Logs are tenant-partitioned, retained indefinitely by default, and exportable in a format suitable for SOX, ISO 27001, and MENA regulatory review.
- A dedicated audit-reader role has read-only access; no role can delete audit rows.

### 13.3 Secrets & Credentials

- Integration credentials (ZainCash, FIB, bank connectors, SMTP, etc.) are stored encrypted at rest in a dedicated secrets store.
- Scripts and extensions receive credentials through just-in-time injection; credentials never appear in source or logs.
- Key rotation is non-disruptive; old and new keys coexist during a rolling rotation window.

### 13.4 Data at Rest and in Flight

- All databases are encrypted at rest (storage-level AES-256).
- TLS 1.3 is required for all external traffic; mutual TLS for service-to-service.
- Tenant-specific encryption keys are supported as an add-on; per-tenant key rotation is online.

---

## 14. Observability

Every component emits structured logs, metrics, and traces. Observability is a first-class product surface — not only for engineering but also for tenant admins, who see operational dashboards covering their own system's behavior.

### 14.1 Metrics

- Resolution latency histograms (per layer, per object type) with tenant-tagged quantiles
- Cache hit ratios at L1 and L2, per-tenant
- Change Set deploy success rate, time-to-deploy, rollback rate
- Script execution metrics (invocations, duration, CPU consumed, budget breaches)
- API request rates and error rates broken down by endpoint and tenant

### 14.2 Tracing

Distributed tracing is end-to-end via W3C Trace Context. A trace starts at the edge, propagates through the Kernel, database calls, script sandboxes, and async automation runs. Traces carry `tenant_id` and `change_set_id` where applicable, so any operation can be tied back to the configuration change that caused it.

### 14.3 Tenant-Facing Dashboards

- Operational health of the tenant's ERP — error rates, slow queries, failing automations
- Configuration hygiene — unused fields, orphaned automations, stale role grants
- Change activity — who changed what, when, with direct links to Change Sets

---

## 15. Open Questions & Risks

### 15.1 Open Questions

1. **Template authoring** — do we ship a structured DSL for template authors on day one, or rely on raw JSON until tooling matures?
2. **Cross-tenant template marketplace** — at what stage do we allow partners to publish publicly, and what is the quality review process?
3. **Script language choice** — TypeScript subset is the tentative decision; Python subset is an alternative worth evaluating given MENA developer familiarity.
4. **Record-level security compilation** — evaluate whether predicates compile to SQL `WHERE` clauses universally, or whether some classes of predicates require post-query filtering.
5. **AI Specialist's write authority** — explicitly scoped per Change Set operation or blanket per session? Recommendation leans per-operation; needs product sign-off.

### 15.2 Known Risks

> **Risk: Template drift at scale.** As templates evolve through versions, tenants who customize heavily may end up far from the current template baseline, making upgrades painful. **Mitigation:** the resolver tracks per-tenant drift metrics; the AI Specialist proactively flags high-drift tenants before major template upgrades and proposes reconciliation paths.

> **Risk: Performance regression under deep customization.** Tenants stacking many custom fields and complex automations could see resolution and materialization slow down. **Mitigation:** performance SLOs are measured per-tenant; the AI Specialist surfaces slow-down early with a configuration-hygiene scorecard; the platform can auto-migrate JSONB fields to native columns when usage justifies.

> **Risk: AI-proposed changes at scale.** If the AI Specialist proposes changes frequently and admins rubber-stamp them, long-term configuration quality could degrade. **Mitigation:** every AI proposal carries an explanation; an approval dashboard tracks proposal rate, approval rate, and rollback rate per tenant; consistently high rollback rates trigger AI model review.

---

## 16. Phased Delivery Plan

Delivered across four engineering phases spanning approximately eighteen months. Each phase closes with a ship-gate and a production readiness review.

### 16.1 Phase 1 — Metadata Core (Months 1–5)

- Metadata object model, storage schema, and resolver implementation
- Two-layer operation (L0 + L2) to unblock single-tenant customization
- Admin API for metadata CRUD and Change Sets
- Runtime API deriving endpoints from Entity metadata
- Audit log, Permission Gate, and basic caching
- One reference tenant live on the platform in controlled pilot

### 16.2 Phase 2 — Templates & Packages (Months 5–9)

- L1 (Industry Template) layer and Package format
- Package installer, versioning, conflict resolver, and Impact Analyzer
- Launch Wave 1 template catalog (five verticals)
- Tenant onboarding flow with template-first signup
- Configuration Studio v0 — read-only views of resolved metadata

### 16.3 Phase 3 — Configuration Studio + Extensions (Months 9–14)

- Configuration Studio GA: Form, Workflow, Report, Automation, and Role designers
- L3 layer — Low-Code Scripting sandbox
- L4 layer — Pro-Code Extension SDK and marketplace
- Compatibility harness for scripts and extensions
- AI Specialist v1 integrated against the Change Set API

### 16.4 Phase 4 — Scale, Governance & Verticals (Months 14–18+)

- Multi-region deployment and tenant migration between regions
- Advanced governance: multi-party approvals, environment promotion pipelines, tenant-defined policies
- Observability dashboards for tenants (configuration hygiene, drift, etc.)
- Partner certification program and public marketplace launch
- Wave 2 templates (manufacturing, healthcare, education, hospitality, automotive)

### 16.5 Milestone Summary

| Phase | Duration | Team Size (engineers) | Exit Criterion |
|-------|----------|----------------------|----------------|
| 1 | Months 1–5 | 8–10 | One reference tenant live; SLO targets met in pilot |
| 2 | Months 5–9 | 12–15 | Five templates GA; ten tenants live; package installer hardened |
| 3 | Months 9–14 | 18–22 | Configuration Studio GA; AI Specialist v1 live; scripting sandbox production-ready |
| 4 | Months 14–18+ | 25–30 | Multi-region, marketplace open, Wave 2 templates shipped, 200+ tenants |

---

## 17. Appendix A — Full Entity Schema

The complete JSON Schema for Entity metadata (abridged — production schema includes field-level format constraints omitted here for readability):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id":     "https://erp.example.com/schemas/entity.v1.json",
  "type":    "object",
  "required":["name", "fields"],
  "properties": {
    "name":        { "type": "string", "pattern": "^[A-Z][A-Za-z0-9_]*$" },
    "plural":      { "type": "string" },
    "label":       { "type": "object",
                     "additionalProperties": { "type": "string" } },
    "description": { "type": "string" },
    "icon":        { "type": "string" },
    "storage": {
      "type": "object",
      "properties": {
        "table":    { "type": "string" },
        "strategy": { "enum": ["native", "hybrid", "jsonb", "side_table"] }
      }
    },
    "fields": {
      "type": "array",
      "minItems": 1,
      "items":    { "$ref": "#/$defs/field" }
    },
    "relationships": {
      "type": "array",
      "items":    { "$ref": "#/$defs/relationship" }
    },
    "lifecycle": {
      "type": "object",
      "properties": {
        "states":      { "type": "array", "items": { "type": "string" } },
        "initial":     { "type": "string" },
        "workflow_id": { "type": "string" }
      }
    },
    "indexes":   { "type": "array", "items": { "$ref": "#/$defs/index" } },
    "audit":     { "type": "boolean", "default": true }
  },
  "$defs": {
    "field":        { /* full field schema */ },
    "relationship": { /* full relationship schema */ },
    "index":        { /* full index schema */ }
  }
}
```

## 18. Appendix B — Sample Resolution Trace

Resolver trace for `ent.customer` on tenant `t_4f8a3c` with L1=Retail Multi-Store v2.3.1 active and L2 customizations present:

```
[resolve]  tenant=t_4f8a3c  object=ent.customer
[layer L0] fetched version=12  fields=8  workflows=1
[layer L1] fetched version=37  strategy=merge_list_by_key
           + adds field 'store_group'
           + adds field 'loyalty_tier'
           + adds lifecycle state 'prospect'
[layer L2] fetched version=4   strategy=merge_list_by_key
           ~ modifies field 'credit_limit' default: 0 → 500000
           + adds field 'whatsapp_number' (custom, jsonb strategy)
           - tombstones field 'fax_number'
[layer L3] no object
[layer L4] no object
[result]   fields=11  workflows=1
           cache-key = "t_4f8a3c:ent.customer:v_L0-12_L1-37_L2-4"
           ttl       = infinite (version-keyed; rotates on any change)
```

---

*End of ERP-RFC-001 · v1.0 · April 2026*
