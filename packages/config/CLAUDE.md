# @erp/config — Shared Tooling Presets

## Purpose

Single source of truth for every tool that runs across the monorepo:
TypeScript, ESLint, Prettier, and Vitest. Every other package and app
extends or re-exports from here — never inlines its own copy.

## Boundaries

**Exports (subpath, via `package.json#exports`):**

| Subpath | File | Purpose |
|---|---|---|
| `./tsconfig.base.json` | `tsconfig.base.json` | Strict-flag baseline from CLAUDE.md §5. Every package `extends` this. |
| `./tsconfig.package.json` | `tsconfig.package.json` | Preset for library packages: composite, `rootDir: src`, `outDir: dist`. |
| `./eslintrc` | `eslintrc.cjs` | Full ESLint config. Forbidden-pattern rules from CLAUDE.md §5 live here. |
| `./prettierrc` | `prettierrc.cjs` | Prettier config (100 cols, LF, double quotes, trailing commas). |
| `./vitest.base` | `vitest.config.base.ts` | Vitest preset. Consumers merge in their own options. |

**Imports:** none. This package has zero runtime dependencies; it ships
config files only.

**Must never depend on:** any other `@erp/*` package. It sits at the
root of the dependency graph.

## Patterns

- Any rule added here fires everywhere. Think twice before adding a rule
  that does not reflect an existing CLAUDE.md guardrail.
- `tsconfig.base.json` must not disable any strict flag. CLAUDE.md §5
  lists them as non-negotiable.
- When the ESLint config is extended by a per-file override, document
  *why* in this file's "Known gotchas" section below.

## Invariants

1. The ten strict TypeScript flags from CLAUDE.md §5 are all set to
   their strict value. A PR that loosens any of them must include an
   ADR.
2. The forbidden-TypeScript-patterns list (any, non-null assertions,
   @ts-ignore, default exports outside Next.js routing files,
   console.log outside `scripts/`) are enforced via ESLint rules
   declared here.
3. No runtime code in this package. Only config files.

## Known gotchas

- **`verbatimModuleSyntax: true`** in `tsconfig.base.json` requires
  explicit `import type` for type-only imports and forbids re-export
  shortcuts like `export { Foo }` when `Foo` is a type (use
  `export type { Foo }` instead).
- **`exactOptionalPropertyTypes: true`** — `{ x?: string }` is *not*
  assignable from `{ x: undefined }`. Either drop the key or type it
  `x?: string | undefined`.
- **ESLint `import/order`** enforces alphabetic import grouping with
  newlines between groups. `pnpm lint:fix` will rewrite.
