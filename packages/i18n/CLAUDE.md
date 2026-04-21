# @erp/i18n — Internationalization Primitives

## Purpose

Arabic-and-English primitives and RTL utilities — locale lookup,
direction detection, ICU MessageFormat helpers, Hijri/Gregorian date
formatting (the Hijri side comes via `Intl` extensions). The
console (`apps/console`) wires `i18next` against these primitives.

CLAUDE.md §2 pins Arabic as a primary language. RTL is **first-class**,
not an afterthought.

## Boundaries

**Imports:** `@erp/core`. The `i18next` runtime lives in `apps/console`,
not here.

**Exports:** `Locale` type, direction detection, label fallback rules
(per-locale → English → key), and a small set of date/number formatters.

## Patterns

- **Localized string** is the type used inside metadata `label` fields:
  `{ en: "Customer", ar: "عميل" }`. Always include English; Arabic is
  the second pillar.
- **Fallback order** for a string lookup: requested locale → English →
  the raw key. Never throw on a missing translation.

## Invariants

1. No `Intl.DisplayNames` calls outside this package — go through the
   exported helpers so behavior stays consistent.
2. RTL detection is structural, not heuristic — based on locale, not
   on character class.

## Known gotchas

- This package populates in **TASK-13** (reference tenant seed) and
  again when the console grows real i18n. TASK-01 ships only the
  scaffold.
