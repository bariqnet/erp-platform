# Runbook — Local Development Environment

The local stack is a single `docker compose` project named **`erp-dev`**
containing PostgreSQL 16, Redis 7, and OpenSearch 2. Everything listens
on `localhost` only.

## Prerequisites

| Tool                  | Required version                       | Why                              |
| --------------------- | -------------------------------------- | -------------------------------- |
| macOS / Linux         | any recent                             | host OS                          |
| Docker Engine 24+     | any 24+                                | compose v2 syntax; `--wait` flag |
| Docker Compose v2.20+ | any 2.20+                              | `--wait` behavior is stable      |
| Node.js               | `20.18.1` (pinned in `.nvmrc`)         | `nvm use` to match               |
| pnpm                  | `9.15.4` (pinned via `packageManager`) | `corepack enable`                |

Any Docker-compatible runtime works — tested on **OrbStack**, **Docker
Desktop**, and **Colima**. The compose file uses only portable features.

## Start

```bash
# From repo root. --wait blocks until every healthcheck passes.
docker compose -f infra/docker/compose.dev.yml up -d --wait
```

**Typical startup time:**

| Scenario                       | Duration                                            |
| ------------------------------ | --------------------------------------------------- |
| Cold (images not yet pulled)   | 60–150 s — dominated by the OpenSearch pull (~1 GB) |
| Warm (images + volumes cached) | ~10 s                                               |

On first run, `--wait` will block while Docker pulls the three images;
there is no progress bar on `--wait` itself. Run `docker compose -f
infra/docker/compose.dev.yml pull` once up front if you prefer to watch
the download separately.

## Inspect

```bash
# Overview
docker compose -f infra/docker/compose.dev.yml ps

# Postgres — server version, drop into psql, tail logs
docker compose -f infra/docker/compose.dev.yml exec postgres \
    psql -U erp -d erp_dev -c 'SELECT version();'
docker compose -f infra/docker/compose.dev.yml exec postgres \
    psql -U erp -d erp_dev
docker compose -f infra/docker/compose.dev.yml logs -f postgres

# Redis — ping, CLI, logs
docker compose -f infra/docker/compose.dev.yml exec redis redis-cli PING
docker compose -f infra/docker/compose.dev.yml exec redis redis-cli
docker compose -f infra/docker/compose.dev.yml logs -f redis

# OpenSearch — cluster health, indices, logs
curl -s http://localhost:9200/_cluster/health | jq
curl -s http://localhost:9200/_cat/indices?v
docker compose -f infra/docker/compose.dev.yml logs -f opensearch
```

All three services are reachable from the host:

| Service    | URL                                           |
| ---------- | --------------------------------------------- |
| Postgres   | `postgresql://erp:erp@localhost:5432/erp_dev` |
| Redis      | `redis://localhost:6379`                      |
| OpenSearch | `http://localhost:9200`                       |

Ports are env-overridable (`POSTGRES_PORT`, `REDIS_PORT`,
`OPENSEARCH_PORT`) — see `.env.example`.

## Reset (keep the stack, drop the data)

```bash
docker compose -f infra/docker/compose.dev.yml down -v
docker compose -f infra/docker/compose.dev.yml up -d --wait
```

`-v` removes the three named volumes (`erp-dev-postgres-data`,
`erp-dev-redis-data`, `erp-dev-opensearch-data`). Use this any time you
want a pristine database — much faster than re-running migrations
destructively.

## Stop (preserve data)

```bash
docker compose -f infra/docker/compose.dev.yml stop
# or, to remove containers but keep named volumes:
docker compose -f infra/docker/compose.dev.yml down
```

`stop` and `down` both preserve the named volumes. Only `down -v`
drops data.

## Teardown (remove everything except image cache)

```bash
docker compose -f infra/docker/compose.dev.yml down -v
# optionally drop the images too:
docker rmi postgres:16-alpine redis:7-alpine opensearchproject/opensearch:2.18.0
```

## Common issues

### Port already in use

```
Error: bind: address already in use
```

Another service on your machine is using `5432`, `6379`, or `9200`.
Either stop it or override the port:

```bash
echo 'POSTGRES_PORT=5433' >> .env
docker compose -f infra/docker/compose.dev.yml up -d --wait
```

`.env` in the repo root is auto-loaded by compose.

### OpenSearch container keeps restarting, "bootstrap checks failed"

Usually a `vm.max_map_count` limit (Linux only). On macOS it's a Docker
runtime thing and typically self-heals; if not:

```bash
# Linux hosts only
sudo sysctl -w vm.max_map_count=262144
```

### OpenSearch: OOM (container killed)

Lower the JVM heap in `.env`:

```bash
OPENSEARCH_JAVA_OPTS=-Xms256m -Xmx256m
```

The default (`-Xms512m -Xmx512m`) is conservative but may still be too
much on an 8 GB machine with many other containers running.

### `docker` command not found after installing a runtime

Make sure the runtime's `bin/` is on your `PATH`. Check with
`which docker`; expected targets:

| Runtime        | `docker` points to                                       |
| -------------- | -------------------------------------------------------- |
| OrbStack       | `/Applications/OrbStack.app/Contents/MacOS/xbin/docker`  |
| Docker Desktop | `/Applications/Docker.app/Contents/Resources/bin/docker` |
| Colima         | `/opt/homebrew/bin/docker` (via `brew install docker`)   |

## Testcontainers for integration tests

`docker compose up` is for long-running dev state. **Integration tests
don't use it** — they use **Testcontainers** to spin up fresh, isolated
containers per test run. That pattern is exercised by
`packages/db/test/integration/testcontainers-smoke.integration.test.ts`.

Run the integration suite:

```bash
pnpm test:integration
```

Testcontainers talks to the same Docker socket the compose stack uses,
so make sure a runtime is up before running integration tests.

## Related

- CLAUDE.md §4 — first-run commands and the verify contract
- RFC §1.3 — why Postgres, Redis, and (eventually) OpenSearch
- `docs/patterns/writing-a-test.md` — the integration-test pattern
