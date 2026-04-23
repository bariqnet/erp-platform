// apps/worker — async background process for the ERP platform.
//
// Phase 1 responsibility list (CLAUDE.md §3 + apps/worker/CLAUDE.md):
//
//   ✓ outbox pump        — drains metadata.meta_outbox, dispatches to
//                           in-process subscribers via OutboxBus.
//   ☐ automations        — as event consumers come online
//   ☐ custom-field migs  — RFC §6.1 / §11.3
//   ☐ compatibility harness — RFC §7.4 (Phase 2+)
//
// Single entry point: createWorker() returns the Worker handle. Apps
// or tests construct one, call `start()`, and `stop()` on shutdown.
// All wiring lives here per CLAUDE.md §7 #11.

import { createDatabase, type Database } from "@erp/db";
import { OutboxBus, OutboxPump } from "@erp/events";
import { createLogger, registerOtelSdkFromEnv } from "@erp/telemetry";
import { type Kysely } from "kysely";

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly pump?: {
    readonly batchSize?: number;
    readonly idlePollMs?: number;
    readonly maxAttempts?: number;
  };
}

export interface Worker {
  readonly bus: OutboxBus;
  readonly pump: OutboxPump;
  readonly db: Kysely<Database>;
  start(): void;
  stop(): Promise<void>;
}

export function createWorker(config: WorkerConfig): Worker {
  const db = createDatabase({
    connectionString: config.databaseUrl,
    applicationName: "erp-worker",
  });
  const bus = new OutboxBus(db);
  const pump = new OutboxPump(db, bus, config.pump);

  return {
    bus,
    pump,
    db,
    start: () => pump.start(),
    stop: async () => {
      await pump.stop();
      await db.destroy();
    },
  };
}

// ── Script entry (dev + production) ──────────────────────────────

async function main(): Promise<void> {
  const otel = registerOtelSdkFromEnv("erp-worker");

  const logger = createLogger({ service: "erp-worker" });
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    logger.error("erp-worker: DATABASE_URL is required");
    await otel.shutdown();
    process.exit(2);
  }

  const worker = createWorker({ databaseUrl });
  worker.start();
  logger.info({ otel_active: otel.active }, "erp-worker: outbox pump started");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "erp-worker: shutting down");
    try {
      await worker.stop();
      await otel.shutdown();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "erp-worker: error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const invokedAsScript = Boolean(
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")),
);
if (invokedAsScript) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("erp-worker: fatal", err);
    process.exit(1);
  });
}
