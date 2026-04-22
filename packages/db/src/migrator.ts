// SQL-file migration runner, wired into Kysely's built-in Migrator.
//
// Each migration is a single .sql file under `infra/migrations/` with a
// header comment (enforced by `scripts/verify.ts` invariant #5), a
// `-- +migrate up` marker separating header from up-DDL, and an optional
// `-- +migrate down` marker for the reverse. Kysely tracks applied
// migrations in its own `kysely_migration` table — that is why
// `pnpm db:migrate` is idempotent.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Migrator, sql, type Kysely, type Migration, type MigrationProvider } from "kysely";

interface ParsedMigration {
  readonly up: string;
  readonly down: string | null;
}

const UP_MARKER = /^--\s*\+migrate up\s*$/m;
const DOWN_MARKER = /^--\s*\+migrate down\s*$/m;

export function parseMigration(content: string, filename: string): ParsedMigration {
  const upMatch = UP_MARKER.exec(content);
  if (!upMatch) {
    throw new Error(`Migration ${filename}: missing "-- +migrate up" marker`);
  }
  const upStart = upMatch.index + upMatch[0].length;

  const downMatch = DOWN_MARKER.exec(content);
  if (!downMatch) {
    return { up: content.slice(upStart).trim(), down: null };
  }

  return {
    up: content.slice(upStart, downMatch.index).trim(),
    down: content.slice(downMatch.index + downMatch[0].length).trim(),
  };
}

export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly folder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const entries = await readdir(this.folder);
    const files = entries.filter((f) => f.endsWith(".sql")).sort();

    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const content = await readFile(join(this.folder, file), "utf8");
      const { up, down } = parseMigration(content, file);
      const name = file.replace(/\.sql$/, "");
      migrations[name] = {
        up: async (db: Kysely<unknown>) => {
          await sql.raw(up).execute(db);
        },
        down: async (db: Kysely<unknown>) => {
          if (down === null) {
            throw new Error(
              `Migration ${file} has no "-- +migrate down" block; refusing to roll back`,
            );
          }
          await sql.raw(down).execute(db);
        },
      };
    }
    return migrations;
  }
}

export function createMigrator(db: Kysely<unknown>, migrationFolder: string): Migrator {
  return new Migrator({
    db,
    provider: new SqlFileMigrationProvider(migrationFolder),
  });
}
