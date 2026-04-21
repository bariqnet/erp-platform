# Pattern — Writing a Repository

> **Status:** Stub. Populated by **TASK-03** (introduces `TenantRepository`)
> and exercised by every later task that adds a new repository.

## Problem

CLAUDE.md §7 non-negotiable #4: every tenant-scoped query passes
through a repository that injects `tenant_id`. CLAUDE.md §9: every
repository method accepts a `TenantContext` and refuses to execute
without one. Direct Kysely against tenant tables is a bug.

## When to use

- You are adding a new tenant-scoped table.
- You are adding a new query against an existing tenant-scoped table.
- You are reading from `meta_*` or `ops_*`.

## Skeleton

The full skeleton — extending `TenantRepository`, accepting
`TenantContext`, building the Kysely query, returning `Result<T, E>` —
is documented when TASK-03 introduces the base class. This stub
exists so future contributors can find the location.

## Verified by

- `scripts/verify.ts` invariant #1 — every repository class extends
  `TenantRepository`.
- Postgres row-level security at the database layer (defense in depth).
