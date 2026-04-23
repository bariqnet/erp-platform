// Playwright global setup — runs ONCE before any spec.
//
// Two jobs:
//   1. Ping `${API_URL}/readyz` and bail out with a clear error if
//      the upstream stack isn't listening. Playwright spins up the
//      Next.js console itself via `webServer`, but api/kernel/worker
//      live outside this harness (CLAUDE.md §3: they're separate
//      services — the console runs in-process only for unit tests).
//   2. Confirm the seed is in place: GET /v1/ent.customer returns
//      at least one row under `t_demo_retail`. If the list is empty
//      we fail fast rather than let scenarios time out searching
//      for a non-existent row.
//
// Both checks have a 10 s budget. Beyond that the stack is
// genuinely down and the test run is no-go.

import { request, type FullConfig } from "@playwright/test";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const TENANT = process.env.E2E_TENANT_ID ?? "t_demo_retail";
const USER = process.env.E2E_USER_ID ?? "u_demo";
const ROLES = process.env.E2E_ROLES ?? "prm.admin";
const READINESS_TIMEOUT_MS = 10_000;

export default async function globalSetup(_: FullConfig): Promise<void> {
  const ctx = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: {
      "x-tenant-id": TENANT,
      "x-user-id": USER,
      "x-user-roles": ROLES,
    },
    timeout: READINESS_TIMEOUT_MS,
  });

  try {
    // 1. Readiness — DB + migrations.
    const ready = await ctx.get("/readyz");
    if (!ready.ok()) {
      throw new Error(
        `[e2e] ${API_URL}/readyz returned ${ready.status()} — is api running? ` +
          "Run `pnpm dev:services` and make sure migrations + seed completed.",
      );
    }

    // 2. Seed sanity — we rely on t_demo_retail having at least one
    //    customer. The seed script is idempotent; rerunning is cheap.
    const customers = await ctx.get("/v1/ent.customer?limit=1");
    if (!customers.ok()) {
      const body = await customers.text();
      throw new Error(
        `[e2e] GET /v1/ent.customer → ${customers.status()}\n` +
          `body: ${body}\n` +
          "Check that apps/api is listening and the demo tenant is seeded.",
      );
    }
    const payload = (await customers.json()) as {
      items?: readonly unknown[];
    };
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error("[e2e] /v1/ent.customer returned an empty list — run `pnpm db:seed` first.");
    }
  } finally {
    await ctx.dispose();
  }
}
