# Architecture Decision Records

One ADR per architectural decision. Each ADR captures **what** was
decided, **why**, and **what alternatives were considered**, so future
sessions never have to re-litigate the choice.

## When to write an ADR

Write one when:

- The decision is **architectural** — picks one of several valid
  options that will shape later code.
- The decision is **not obvious from the code itself**.
- The decision **affects more than one package**.
- A `CLAUDE.md` non-negotiable is added or changed.

Don't write one for:

- Naming a variable, picking a library version (Renovate handles
  versions), or other purely-local choices.
- Anything already specified in `CLAUDE.md` or `docs/rfc/ERP-RFC-001.md`.

## Format

Each ADR is a Markdown file named `NNNN-short-title.md`, sequentially
numbered, with this structure:

```markdown
# NNNN — Short Title

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-MMMM
**Date:** YYYY-MM-DD

## Context
What problem are we solving? What constraints apply?

## Decision
What did we choose?

## Alternatives Considered
What else was on the table, and why was each rejected?

## Consequences
What are the trade-offs we are accepting? What follow-up work does
this imply?
```

## Index

| # | Title | Status | Task |
|---|-------|--------|------|
| _ | _Reserved for the first decision in TASK-03 (metadata schema)_ | _ | _ |

ADR-0001 lands with TASK-03 per the task's "Done when" list.
