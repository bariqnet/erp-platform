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
