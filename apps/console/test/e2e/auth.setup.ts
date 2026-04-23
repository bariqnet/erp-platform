// Setup project — runs ONCE before the scenario specs.
//
// Visits /login, fills the dev form (default values already match
// t_demo_retail + u_demo + prm.admin), submits, and on successful
// redirect to /entities/ent.customer saves the browser state to
// `.auth/session.json`. Every scenario project reuses that file via
// `storageState`, so login isn't paid per-test.
//
// When Better Auth lands (TASK-10.1b.1) the cookie format changes;
// this file is the one place the e2e harness needs updating.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test as setup } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_FILE = resolve(__dirname, ".auth/session.json");

const TENANT = process.env.E2E_TENANT_ID ?? "t_demo_retail";
const USER = process.env.E2E_USER_ID ?? "u_demo";
const ROLES = process.env.E2E_ROLES ?? "prm.admin";

setup("sign in the demo user", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // The form's default values already match our E2E tenant. Replace
  // them if the env points elsewhere.
  await page.locator("#tenant_id").fill(TENANT);
  await page.locator("#user_id").fill(USER);
  await page.locator("#roles").fill(ROLES);

  await page.getByRole("button", { name: "Sign in" }).click();

  // Successful login redirects to the Customer list.
  await page.waitForURL("**/entities/ent.customer", { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: /ent\.customer/ })).toBeVisible();

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  await page.context().storageState({ path: STATE_FILE });
});
