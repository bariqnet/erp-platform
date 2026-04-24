// Setup project — runs ONCE before the scenario specs.
//
// Visits /login, fills the Better Auth sign-in form with the demo
// credentials (provisioned by `pnpm db:seed`), and on successful
// redirect to /entities/ent.customer saves the browser state to
// `.auth/session.json`. Every scenario project reuses that file via
// `storageState`, so login isn't paid per-test.
//
// This replaces the placeholder dev-cookie login that TASK-14.4
// shipped; TASK-10.1b.2 completes the Better Auth migration
// (ADR-0004).

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test as setup } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_FILE = resolve(__dirname, ".auth/session.json");

const EMAIL = process.env.E2E_EMAIL ?? "demo@erp.local";
const PASSWORD = process.env.E2E_PASSWORD ?? "erp-demo-pass-2026!";
const TENANT = process.env.E2E_TENANT_ID ?? "t_demo_retail";

setup("sign in the demo user", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#tenant_id").fill(TENANT);

  await page.getByRole("button", { name: "Sign in" }).click();

  // Successful login redirects to the Customer list.
  await page.waitForURL("**/entities/ent.customer", { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: /ent\.customer/ })).toBeVisible();

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  await page.context().storageState({ path: STATE_FILE });
});
