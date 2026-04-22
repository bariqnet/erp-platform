// TASK-02 integration smoke — proves Testcontainers can programmatically
// spin up fresh instances of every service in the local dev stack.
//
// Each test pulls an image (first run only), starts a container, runs one
// probe against it, and stops the container. The probes mirror what the
// runbook (`docs/runbooks/local-dev.md`) tells developers to check against
// the long-running compose stack.
//
// Run with:   pnpm --filter @erp/db test:integration
// Or across the monorepo:   pnpm test:integration

import Redis from "ioredis";
import { Client } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── Postgres ────────────────────────────────────────────────────────────────

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

  it("reports server_version 16.x", async () => {
    const client = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: "erp",
      password: "erp",
      database: "erp_test",
    });
    await client.connect();
    try {
      const result = await client.query<{ server_version: string }>("SHOW server_version");
      expect(result.rows[0]?.server_version).toMatch(/^16\./);
    } finally {
      await client.end();
    }
  });
});

// ── Redis ──────────────────────────────────────────────────────────────────

describe("Testcontainers — Redis 7", () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(30_000)
      .start();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("responds to PING with PONG", async () => {
    const client = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      // Fail fast if the container rejects — don't hang the test.
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    try {
      await client.connect();
      const pong = await client.ping();
      expect(pong).toBe("PONG");
    } finally {
      client.disconnect();
    }
  });

  it("round-trips a key/value", async () => {
    const client = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    try {
      await client.connect();
      await client.set("task02:probe", "ok");
      const got = await client.get("task02:probe");
      expect(got).toBe("ok");
    } finally {
      client.disconnect();
    }
  });
});

// ── OpenSearch ─────────────────────────────────────────────────────────────

describe("Testcontainers — OpenSearch 2", () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer("opensearchproject/opensearch:2.18.0")
      .withEnvironment({
        "discovery.type": "single-node",
        DISABLE_SECURITY_PLUGIN: "true",
        OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m",
      })
      .withExposedPorts(9200)
      .withWaitStrategy(Wait.forHttp("/_cluster/health", 9200).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("reports a healthy cluster", async () => {
    const host = container.getHost();
    const port = container.getMappedPort(9200);
    const response = await fetch(`http://${host}:${port}/_cluster/health`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { status: string; number_of_nodes: number };
    // A single-node cluster reports `green` or `yellow` depending on replica
    // assignment — both mean "ready for queries".
    expect(["green", "yellow"]).toContain(body.status);
    expect(body.number_of_nodes).toBe(1);
  });

  it("creates, writes, and reads an index", async () => {
    const base = `http://${container.getHost()}:${container.getMappedPort(9200)}`;
    const indexName = "task02-probe";

    await fetch(`${base}/${indexName}`, { method: "PUT" });
    const putResp = await fetch(`${base}/${indexName}/_doc/1?refresh=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(putResp.ok).toBe(true);

    const getResp = await fetch(`${base}/${indexName}/_doc/1`);
    const body = (await getResp.json()) as { _source: { hello: string } };
    expect(body._source.hello).toBe("world");
  });
});
