# @erp/ui-kit — Shared UI Components

## Purpose

The shadcn/ui component set, **copied** into the repo (not imported)
per CLAUDE.md §2 — adapted for RTL-first layout. `apps/console` is
the consumer.

## Boundaries

**Imports:** `@erp/core`, `@erp/i18n`, plus `react` and Tailwind
peer-deps when those land.

**Must never import:** Next.js APIs, `fastify`, or anything tied to
the runtime. This is a pure component library.

**Exports:** named React components (Button, Input, Dialog, etc.) and
their styling primitives.

## Patterns

- **Server Components by default.** Add `"use client"` only at the
  interaction boundary (CLAUDE.md §2 — Frontend, §15).
- **No default exports** (CLAUDE.md §5). Even when re-exporting an
  upstream component, name it.
- **RTL via Tailwind logical properties** (`ms-`, `me-`, `ps-`, `pe-`),
  not directional ones (`ml-`, `mr-`).

## Invariants

1. Every component renders correctly in both `dir="ltr"` and
   `dir="rtl"`. Visual regression tests added when the kit grows.
2. No `useEffect` with cleanup-only purpose. If you reach for one,
   reconsider — it usually means a Server Component would be simpler.

## Known gotchas

- This package populates as the console grows (TASK-12+). TASK-01
  ships only the scaffold.
