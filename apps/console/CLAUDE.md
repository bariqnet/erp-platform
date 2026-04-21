# apps/console — Admin Console (Next.js)

## Purpose

The Next.js admin console — RTL-first, Arabic + English, App Router
only. Phase 1 ships a thin shell over the Admin API; the
Configuration Studio designers (Form, Workflow, Report, Automation,
Role) are Phase 3 (RFC §16.3).

## Boundaries

**Imports:** `@erp/core`, `@erp/i18n`, `@erp/ui-kit`, plus `next`,
`react`, `react-dom`. Server data fetching uses native `fetch`
against the Admin API; the console must never import `apps/api` or
`apps/kernel` directly.

**Must never:**

- Import `fastify`, `kysely`, `pino`, or any backend infra
- Use Next.js Parallel Routes, Intercepting Routes, or other
  experimental patterns (CLAUDE.md §2 — Frontend, §15)

## Patterns

- **React Server Components by default.** `"use client"` only at the
  interaction boundary (form fields, dialogs, charts).
- **TanStack Query** for client-side server state, **Zustand** for
  local UI state — added when the console needs them.
- **i18next** with RTL-first layout — Arabic is a primary language
  (CLAUDE.md §2). Default `<html dir>` is set per request from the
  user's locale; TASK-01 defaults to `ltr` until i18n is wired.
- **Default exports allowed** in App Router files (`page.tsx`,
  `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`,
  `template.tsx`, `default.tsx`, `route.ts`, and `next.config.*`).
  The shared ESLint config has the override.

## Invariants

1. No experimental Next.js features.
2. Default export rule is relaxed only for App Router routing files
   and `next.config.*`. Anywhere else, named export.
3. RTL works end-to-end — every component renders correctly under
   `dir="rtl"`.

## Known gotchas

- This package overrides `verbatimModuleSyntax: false` in its
  `tsconfig.json` because Next.js's bundler (not tsc) handles module
  resolution and the strict-ESM `.js`-extension rule is not a fit for
  `.tsx` files. This is the only intentional override of the shared
  base config.
- Populates progressively: TASK-12 (Runtime CRUD UI for one entity),
  Phase 2/3 (Configuration Studio). TASK-01 ships a placeholder home
  page only.
