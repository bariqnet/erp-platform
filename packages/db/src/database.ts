// Kysely connection factory.
//
// CLAUDE.md §7 non-negotiable #11: Fastify, Kysely, and Redis clients are
// instantiated only in each app's wiring entry point (apps/api/src/server.ts,
// apps/kernel/src/server.ts, etc.). That wiring calls this factory; no other
// file in the codebase instantiates `Pool` or `Kysely` directly.

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import type { Database } from "./schema.js";

// `pg` is CommonJS; Node's ESM layer cannot synthesize named exports
// for it (its internals assign onto module.exports at runtime in ways
// the static analyzer can't follow). The default-import shim below is
// the idiomatic workaround — it works in Node ESM, tsx, and vitest
// alike. The test files opt into vitest's transformer and can keep
// the `import { Pool } from "pg"` form; production code (this file)
// cannot.
const { Pool } = pg;
type PoolType = InstanceType<typeof pg.Pool>;
type PoolConfig = pg.PoolConfig;

export interface DatabaseConfig {
  /** libpq-style URL, e.g. `postgresql://erp:erp@localhost:5432/erp_dev`. */
  connectionString: string;
  /** Pool maximum; defaults to 10, enough for a single service node. */
  max?: number;
  /** Surfaced in pg_stat_activity so DBAs can see which app is connected. */
  applicationName?: string;
  /** Socket timeout in ms before the driver gives up on a connection. */
  connectionTimeoutMillis?: number;
}

export function createPool(config: DatabaseConfig): PoolType {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.max ?? 10,
    application_name: config.applicationName ?? "erp-platform",
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
  };
  return new Pool(poolConfig);
}

export function createDatabase(config: DatabaseConfig): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: createPool(config) }),
  });
}
