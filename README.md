# ERP Platform

A metadata-driven, multi-tenant ERP platform for the MENA market.

## Source of truth

Before making any change to this repository, read [`CLAUDE.md`](./CLAUDE.md) in full. It is the project brief, the tech-stack lock-in, and the working contract for every session. When `CLAUDE.md` and anything else disagree, `CLAUDE.md` wins — raise a PR against it first.

The full technical specification lives in [`docs/rfc/ERP-RFC-001.md`](./docs/rfc/ERP-RFC-001.md).

## Repository

- **GitHub:** <https://github.com/bariqnet/erp-platform>
- **Issues:** <https://github.com/bariqnet/erp-platform/issues>
- **License:** proprietary — see [`LICENSE`](./LICENSE). Not open source.

## Getting started

```bash
# 1. Use the pinned Node version (20.18.1)
nvm use

# 2. Enable pnpm via corepack (one-time per machine)
corepack enable

# 3. Install dependencies
pnpm install

# 4. Verify the working copy is green before your first commit
pnpm verify
```

Further runtime setup (Postgres, Redis, OpenSearch) lands in `TASK-02`. See [`CLAUDE.md §13`](./CLAUDE.md) for the task queue.

## The one command that matters

```bash
pnpm verify
```

Runs typecheck, lint, test, build, and custom invariants. **No commit lands on red.** Full details in [`CLAUDE.md §4`](./CLAUDE.md).

## Layout

See [`CLAUDE.md §3`](./CLAUDE.md) for the authoritative repository structure and the purpose of each package.
