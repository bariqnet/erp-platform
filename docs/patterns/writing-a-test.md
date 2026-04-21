# Pattern — Writing a Test

> **Status:** Stub. Populated as the four test types come online:
> unit (everywhere), integration (TASK-03), property (TASK-06),
> contract (TASK-09).

## Problem

CLAUDE.md §8 specifies five test types: unit, integration, contract,
end-to-end, property-based. Each has rules of engagement. The blanket
rules: no mocks where a real service can run; every bug gets a
regression test before the fix lands; `pnpm verify` must be green
before every commit.

## When to use which type

| Type | When | Tool | Lives in |
|---|---|---|---|
| Unit | Every pure function in `@erp/core`, `@erp/metadata`, `@erp/change-set` | Vitest | `src/foo.test.ts` colocated, plus `test/` |
| Integration | Anything that touches Postgres, Redis, OpenSearch | Vitest + Testcontainers | `test/integration/` |
| Contract | Every API endpoint, driven by its OpenAPI schema | Vitest | `test/contract/` |
| End-to-end | 20–30 critical-path scenarios across console + API | Playwright | `apps/console/e2e/` |
| Property | The metadata resolver — determinism, tombstone correctness, ordered application | fast-check | `packages/metadata/test/` |

## Rules

- **No mocks where a real service can run.** Testcontainers is fast
  enough.
- **Every bug gets a regression test** before the fix lands.
- **Every public API function has a test** that exercises it directly.

## Skeleton

Concrete one-of-each examples land with the task that introduces each
test type — TASK-03 for integration, TASK-06 for property, TASK-09 for
contract. Until then this stub points future contributors at the
matrix above.
