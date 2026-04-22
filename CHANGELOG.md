# Changelog

All notable changes per phase. Conventional-commit style; entries land alongside the PR that introduces them.

## Phase 1 — Metadata Core

### Unreleased

- **TASK-01 · Monorepo Scaffold** — empty monorepo with tooling wired up, CLAUDE.md + RFC-001 committed, `pnpm verify` runs a green smoke test per package, CI runs `pnpm verify` on every push and PR.
- **TASK-02 · Local Dev Environment** — `infra/docker/compose.dev.yml` runs Postgres 16, Redis 7, OpenSearch 2 (warm ~10 s, healthy via `--wait`); `.env.example` documents every variable the stack and future services read; `docs/runbooks/local-dev.md` covers start/inspect/reset/teardown with verified commands; Testcontainers smoke suite in `packages/db` exercises all three services (6 tests / ~10 s); `pnpm test:integration` split from `pnpm test` so integration tests stay off the every-commit verify loop.
- **TASK-03 · Metadata Schema** — four RFC §4.1 tables (`metadata.meta_object`, `meta_change_set`, `meta_layer_activation`, `meta_audit_log`) with Kysely types, the `idx_meta_object_current` partial index, and RLS policies (ENABLED + FORCEd). A non-superuser `erp_app` role + `withTenantContext(db, tenantId, fn)` API together make policies actually fire in dev. SQL-file migration runner via Kysely's `Migrator` (idempotent, re-run-safe) plus a `pnpm db:migrate` CLI. Integration tests prove cross-tenant reads are blocked and the migrator round-trips cleanly. [ADR-0001](./docs/adr/0001-metadata-schema.md) records the non-DDL decisions; `docs/patterns/writing-a-migration.md` now has the real example.
