# Pattern — Tenant Isolation

> **Status:** Stub. Populated by **TASK-03** (RLS at the database
> layer) and **TASK-09** (`tenant-context` Fastify plugin).

## Problem

CLAUDE.md §9: cross-tenant data leaks are existential bugs. Every
layer is defense-in-depth.

## The seven layers

1. **Every tenant table** has `tenant_id TEXT NOT NULL` and RLS
   enabled.
2. **Every DB connection** sets `app.current_tenant` at checkout via
   `SET LOCAL`.
3. **Every repository method** accepts a `TenantContext` and refuses
   to execute without one.
4. **Every API request** is tenant-scoped via a header, validated
   against the session's authorized tenants.
5. **Every cache key** includes `tenant_id` as a prefix.
6. **Every log line** includes `tenant_id` as a structured field.
7. **Every test** explicitly runs under a tenant context or asserts
   it is a vendor-level operation.

## The bedrock rule

> If you can write code that accesses tenant data without naming a
> tenant, the API is wrong. Fix the API, don't work around it.

## Skeleton

Concrete code lands with the layers it covers — TASK-03 for the
database layer (RLS policies, `SET LOCAL app.current_tenant`),
TASK-09 for the runtime layer (tenant-context plugin, repository
base class). This stub captures the policy.

## Verified by

- Postgres RLS enforces it at the database boundary.
- `scripts/verify.ts` invariant #1 enforces every repository extends
  `TenantRepository`, which carries `TenantContext`.
- Integration test in TASK-03 asserts cross-tenant reads are blocked.
