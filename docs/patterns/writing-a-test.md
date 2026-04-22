# Pattern — Writing a Test

CLAUDE.md §8 specifies five test types: unit, integration, contract,
end-to-end, property-based. Each has rules of engagement. The blanket
rules: no mocks where a real service can run; every bug gets a
regression test before the fix lands; `pnpm verify` must be green
before every commit.

## When to use which type

| Type        | When                                                                            | Tool                    | Lives in                                  |
| ----------- | ------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------- |
| Unit        | Every pure function in `@erp/core`, `@erp/metadata`, `@erp/change-set`          | Vitest                  | `src/foo.test.ts` colocated, plus `test/` |
| Integration | Anything that touches Postgres, Redis, or OpenSearch                            | Vitest + Testcontainers | `test/integration/*.integration.test.ts`  |
| Contract    | Every API endpoint, driven by its OpenAPI schema                                | Vitest                  | `test/contract/`                          |
| End-to-end  | 20–30 critical-path scenarios across console + API                              | Playwright              | `apps/console/e2e/`                       |
| Property    | The metadata resolver — determinism, tombstone correctness, ordered application | fast-check              | `packages/metadata/test/`                 |

## Filename convention

| Pattern                    | Runs during                                            |
| -------------------------- | ------------------------------------------------------ |
| `**/*.test.ts`             | `pnpm test` (and therefore `pnpm verify`)              |
| `**/*.integration.test.ts` | `pnpm test:integration` — excluded from default `test` |

The split is enforced in `packages/config/vitest.config.base.mjs`:
the default run's `exclude` list includes `**/*.integration.test.ts`,
so integration tests never slow down the every-commit verify loop.
Each package that needs integration tests carries a standalone
`vitest.integration.config.ts` that targets the `*.integration.test.ts`
glob and raises the timeout to cover container startup.

## Blanket rules

- **No mocks where a real service can run.** Testcontainers is fast
  enough.
- **Every bug gets a regression test** before the fix lands.
- **Every public API function has a test** that exercises it directly.
- **Integration tests never share state.** Each test spins up a fresh
  container. No global fixtures across test files.

## Example — integration test with Testcontainers

This is the real TASK-02 smoke suite in
`packages/db/test/integration/testcontainers-smoke.integration.test.ts`,
trimmed to the Postgres probe. The full file also covers Redis and
OpenSearch.

```ts
import { Client } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Testcontainers — Postgres 16", () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "erp",
        POSTGRES_PASSWORD: "erp",
        POSTGRES_DB: "erp_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(60_000)
      .start();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("accepts a connection and runs SELECT 1", async () => {
    const client = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: "erp",
      password: "erp",
      database: "erp_test",
    });
    await client.connect();
    try {
      const result = await client.query<{ one: number }>("SELECT 1::int AS one");
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await client.end();
    }
  });
});
```

The Redis and OpenSearch probes follow the same shape:
`GenericContainer` + the correct `Wait` strategy + a scoped client
that connects via `container.getHost()` and
`container.getMappedPort(N)`. Ports are always ephemeral — never
hard-code.

## Anti-patterns

- Waiting on a container with `Wait.forListeningPorts()` when the
  service takes time to become ready on that port (Postgres
  especially — wait for the log line instead).
- Re-using a container across unrelated tests — state leaks, surprises
  follow.
- Mocking a real service because the container "takes too long to
  start." First-run cold start is slow, every subsequent run is fast
  (the Docker image is cached).
- Writing an integration test with `.test.ts` instead of
  `.integration.test.ts` — it will run on every commit via `pnpm verify`
  and you will pay the cost forever.
