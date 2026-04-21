# Pattern — Writing a Database Migration

> **Status:** Stub. Populated by **TASK-03** (the metadata schema
> migration is the canonical example).

## Problem

CLAUDE.md §5: migrations are forward-only in dev with a documented
rollback plan in the file's header comment. Indexes are created
`CONCURRENTLY` to never block writes. All timestamps are
`timestamptz` UTC. All money is integer minor units paired with a
`currency_field`.

`scripts/verify.ts` invariant #5 enforces the header rule —
every migration file must have a `-- Rollback plan:` block before the
`-- +migrate up` marker.

## File shape

```sql
-- File: NNNN_short_description.sql
-- Author: Claude Code
-- Issue: <link>  Change Set: <id if applicable>
--
-- Rollback plan:
--   1. <one or more bullet points describing how to undo this migration>
--
-- +migrate up
<DDL or DML>
-- +migrate down
<reverse DDL or DML, when reversible — otherwise document why not above>
```

## Online migration recipes

For schema changes that touch a large existing table:

- **Adding a column:** add nullable, backfill in batches, set
  `NOT NULL` in a follow-up migration.
- **Dropping a column:** stop writing in code first, deploy, then
  drop in a follow-up migration.
- **Index creation:** `CREATE INDEX CONCURRENTLY`. Never bare
  `CREATE INDEX` on a table with traffic.
- **Renaming:** add new, dual-write, switch reads, drop old. Three
  migrations, never one.

## Skeleton

The first real migration — the metadata schema from RFC §4.1 — lands
in TASK-03 and replaces this stub with the worked example.
