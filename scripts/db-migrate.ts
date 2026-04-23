/**
 * scripts/db-migrate.ts — apply every unapplied migration, in order, idempotent.
 *
 * Reads `DATABASE_URL` from the environment (copy from `.env.example` into
 * `.env`). Safe to run repeatedly — Kysely's Migrator keeps a
 * `kysely_migration` table that records which files have already executed.
 *
 * Usage:
 *   pnpm db:migrate                 # apply every unapplied up-migration
 *   pnpm db:migrate -- --down       # roll back the most recent migration
 *   pnpm db:migrate -- --down-to <name>
 *   pnpm db:migrate -- --down-all   # roll back everything (dev only)
 *
 * NOTE: rollbacks in production are performed by WAL restore, not by running
 * the `-- +migrate down` block. See individual migration headers.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, Migrator, NO_MIGRATIONS, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { SqlFileMigrationProvider } from "../packages/db/src/migrator.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "infra/migrations");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "db-migrate: DATABASE_URL is required. Copy .env.example to .env and fill it in, " +
      "or export the variable before running.",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const hasFlag = (name: string): boolean => args.includes(name);
const flagValue = (name: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
};

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    application_name: "db-migrate",
    max: 2,
  });

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool }),
  });

  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(MIGRATIONS_DIR),
  });

  try {
    let result;
    if (hasFlag("--down-all")) {
      console.log("db-migrate: rolling back every applied migration");
      result = await migrator.migrateTo(NO_MIGRATIONS);
    } else if (hasFlag("--down-to")) {
      const target = flagValue("--down-to");
      if (!target) {
        console.error("db-migrate: --down-to requires a migration name");
        process.exit(2);
      }
      console.log(`db-migrate: rolling back to migration "${target}"`);
      result = await migrator.migrateTo(target);
    } else if (hasFlag("--down")) {
      console.log("db-migrate: rolling back the most recent migration");
      result = await migrator.migrateDown();
    } else {
      console.log("db-migrate: applying every unapplied migration");
      result = await migrator.migrateToLatest();
    }

    if (result.error) {
      console.error("db-migrate: failed");
      console.error(result.error);
      process.exit(1);
    }

    const applied = result.results ?? [];
    if (applied.length === 0) {
      console.log("db-migrate: already up-to-date — nothing to do");
    } else {
      for (const r of applied) {
        const mark = r.status === "Success" ? "✓" : r.status === "Error" ? "✗" : "-";
        console.log(`  ${mark} ${r.direction.padEnd(4)} ${r.migrationName}`);
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error("db-migrate: unexpected error");
  console.error(err);
  process.exit(2);
});
