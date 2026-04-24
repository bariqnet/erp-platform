// Playwright config — TASK-14.4.
//
// Scope: one Chromium browser, two scenarios, local + CI.
//
// Running model:
//
//   Local (developer laptop):
//     1. pnpm dev:services     # api (3000), kernel (3100), worker
//     2. pnpm --filter @erp/console test:e2e
//
//   Playwright owns the console lifecycle via `webServer` below. The
//   upstream services (api/kernel/worker) must already be running —
//   the tests hit `/healthz` before any assertion so they fail fast
//   with a clear error if the stack is down.
//
//   CI: the workflow does `docker compose up -d` for postgres + redis
//   + opensearch, runs migrations + seed, starts api/kernel/worker in
//   the background, then `pnpm --filter @erp/console test:e2e`.
//
// URLs come from env — CI can override if ports shift.
//
//   CONSOLE_URL   http://localhost:3003   (Next.js dev server —
//                                          separate port from the
//                                          `pnpm dev` default (3002)
//                                          so the E2E harness can
//                                          spawn its own instance
//                                          without colliding with a
//                                          running dev session)
//   API_URL       http://localhost:4000   (Fastify apps/api — matches
//                                          the root .env PORT=4000 so
//                                          dev co-exists with other
//                                          localhost:3000 projects)
//
// Phase-1 auth is the dev JSON-cookie; the login scenario tests the
// real form submission. A follow-up shared-state project pre-injects
// that cookie so the locale scenario doesn't re-login every run.

import { defineConfig, devices } from "@playwright/test";

const CONSOLE_URL = process.env.CONSOLE_URL ?? "http://localhost:3003";
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const IS_CI = process.env.CI === "true";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // Scenarios share one seeded tenant; keep ordering stable.
  retries: IS_CI ? 1 : 0,
  workers: 1,
  reporter: IS_CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: CONSOLE_URL,
    extraHTTPHeaders: {
      "x-e2e": "playwright",
    },
    // On failure, grab a screenshot + trace so the CI artifact is
    // enough to diagnose without re-running locally.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },

  // Pass-through env so fixtures can read the API URL for direct
  // HTTP calls (used by the seed-check + reset helpers).
  globalSetup: "./test/e2e/global-setup.ts",

  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        // Reuse the signed-in cookie state the setup project writes.
        storageState: "./test/e2e/.auth/session.json",
      },
    },
  ],

  // Boot the Next.js dev server before any spec runs. The upstream
  // services (api + kernel + worker) must already be listening —
  // globalSetup pings /readyz and bails out if they're not.
  //
  // We always spawn our own console instance on port 3003 rather
  // than reusing `pnpm dev` (which runs on 3002) — `reuseExistingServer`
  // would latch onto whatever non-ERP process happens to be bound to
  // that port on the developer's laptop.
  webServer: {
    command: "next dev --port 3003",
    url: CONSOLE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      API_URL,
      NODE_ENV: "development",
      // The Server Action forwards Better Auth sign-in as a Node
      // fetch. Set Origin explicitly so Better Auth's CSRF check
      // (trustedOrigins) allows the call. Matches the Next dev
      // port below.
      CONSOLE_URL,
    },
  },
});
