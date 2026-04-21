# @erp/change-set — State Machine

## Purpose

Implements the Change Set state machine from RFC §9.3:
`draft → proposed → approved → deployed → rolled_back`, with the
authorization guards each transition requires. This package owns the
*pure* state-machine logic — atomic deploy + O(1) rollback semantics
are wired up in `apps/api` (the HTTP surface) and `packages/db` (the
persistence surface).

## Boundaries

**Imports:** `@erp/core`. Nothing infrastructural.

**Exports:** the state machine, transition guards, and the impact
analyzer.

## Patterns

- States, transitions, and guards must match RFC §9.3 exactly. Any
  divergence is a bug.
- Rollback is O(1): pointer flip on `valid_until`. If implementing
  rollback ever requires more than a pointer flip + cache invalidation,
  it is wrong (CLAUDE.md §7 non-negotiable #7).

## Invariants

1. Pure state machine — no side effects in this package.
2. Audit entries are emitted via the `EventBus` port; no direct DB
   writes.

## Known gotchas

- This package populates in **TASK-07**. TASK-01 ships only the
  scaffold.
