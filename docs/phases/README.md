# Phase Roadmap

Phase 1 is specified in `CLAUDE.md` §13 and is **complete** (TASK-01 …
TASK-13 shipped to `main`).

This directory contains the task queues for Phases 2 → 4 and the
Phase-1 cleanup items that were deferred during the MVP sprint. Each
phase file has the same shape as `CLAUDE.md` §13: numbered tasks,
Goal, Done-when, RFC anchors, dependencies, and a rough scope.

| File                                       | Phase                             | RFC anchor | Status                  |
| ------------------------------------------ | --------------------------------- | ---------- | ----------------------- |
| [phase-1-cleanup.md](./phase-1-cleanup.md) | Deferred from Phase 1             | RFC §16.1  | 6 tasks, none started   |
| [phase-2-tasks.md](./phase-2-tasks.md)     | Templates & Packages              | RFC §16.2  | 11 tasks, none started  |
| [phase-3-tasks.md](./phase-3-tasks.md)     | Configuration Studio + Extensions | RFC §16.3  | 8 epics, not decomposed |
| [phase-4-tasks.md](./phase-4-tasks.md)     | Scale, Governance & Verticals     | RFC §16.4  | 6 epics, not decomposed |

## Rules for working through these queues

These match the discipline from CLAUDE.md §12:

1. **Tasks execute sequentially within a phase.** Cross-phase
   dependencies are called out on each task.
2. **One task = one PR, 200–400 lines.** If a task is bigger, break
   it first (create TASK-Nx.y sub-tasks before writing code).
3. **RFC references are the spec.** Any divergence is a bug or an
   ADR — not a silent choice.
4. **`pnpm verify` stays green** between tasks. If a cross-cutting
   change breaks other packages, that's part of the current task's
   scope, not a follow-up.
5. **The CHANGELOG.md entry lands with the task**, not separately.
6. **Status updates land in this file's status table**, not in
   CLAUDE.md — CLAUDE.md stays a stable contract.

## Decomposition policy

Phase 2's 11 tasks are fully fleshed out (Goal + Done-when + scope
estimates). Phase 3 and 4 are captured as **epics** — one or two
paragraphs each — because their design depends on what Phase 2
surfaces at the product level. When Phase 2 wraps, the first task of
Phase 3 is to decompose the Phase 3 epics into PR-sized tasks, the
way Phase 2 was decomposed here.

That follows CLAUDE.md §10's "update when you learn something" —
writing Phase 3's PR-sized task list now would be speculation; we
author it when we have the context to author it well.
