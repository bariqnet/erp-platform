# Changelog

All notable changes per phase. Conventional-commit style; entries land alongside the PR that introduces them.

## Phase 1 — Metadata Core

### Unreleased

- **TASK-01 · Monorepo Scaffold** — empty monorepo with tooling wired up, CLAUDE.md + RFC-001 committed, `pnpm verify` runs a green smoke test per package, CI runs `pnpm verify` on every push and PR.
- **TASK-02 · Local Dev Environment** — `infra/docker/compose.dev.yml` runs Postgres 16, Redis 7, OpenSearch 2 (warm ~10 s, healthy via `--wait`); `.env.example` documents every variable the stack and future services read; `docs/runbooks/local-dev.md` covers start/inspect/reset/teardown with verified commands; Testcontainers smoke suite in `packages/db` exercises all three services (6 tests / ~10 s); `pnpm test:integration` split from `pnpm test` so integration tests stay off the every-commit verify loop.
