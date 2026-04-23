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

| #                                            | Title                                          | Status   | Task      |
| -------------------------------------------- | ---------------------------------------------- | -------- | --------- |
| [0001](./0001-metadata-schema.md)            | Metadata Schema Shape                          | Accepted | TASK-03   |
| [0002](./0002-better-auth-zod-4-deferral.md) | Better Auth Integration Deferred Pending Zod 4 | Accepted | TASK-10.1 |

ADR-0001 lands with TASK-03 per the task's "Done when" list.
ADR-0002 records why TASK-10 shipped with placeholder auth and pins
the Zod 4 migration path for TASK-10.1.
