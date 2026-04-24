// Playwright global setup — runs ONCE before any spec.
//
// Two jobs:
//   1. Ping `${API_URL}/readyz` and bail with a clear error if the
//      upstream stack isn't listening. Playwright spins up the
//      Next.js console itself via `webServer`, but api/kernel/worker
//      live outside this harness (CLAUDE.md §3).
//   2. Confirm the seed + demo user landed. The Better Auth sign-in
//      flow the specs exercise requires both the demo tenant's rows
//      AND the demo user's auth.user + user_tenant mapping to be
//      present. Sign-in against `/api/auth/sign-in/email` with the
//      demo credentials — fail fast if 401 or 400.
//
// Both checks share a 10 s budget. Beyond that the stack is
// genuinely down and the test run is no-go.

import { request, type FullConfig } from "@playwright/test";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_EMAIL = process.env.E2E_EMAIL ?? "demo@erp.local";
const DEMO_PASSWORD = process.env.E2E_PASSWORD ?? "erp-demo-pass-2026!";
const TENANT = process.env.E2E_TENANT_ID ?? "t_demo_retail";
const READINESS_TIMEOUT_MS = 10_000;

export default async function globalSetup(_: FullConfig): Promise<void> {
  const ctx = await request.newContext({
    baseURL: API_URL,
    timeout: READINESS_TIMEOUT_MS,
  });

  try {
    // 1. Readiness — DB + migrations.
    const ready = await ctx.get("/readyz");
    if (!ready.ok()) {
      throw new Error(
        `[e2e] ${API_URL}/readyz returned ${ready.status()} — is apps/api running? ` +
          "Run `pnpm dev:services` and make sure migrations + seed completed.",
      );
    }

    // 2. Demo user exists — we sign in against Better Auth as a
    // readiness probe. A 401 here means `pnpm db:seed` never ran or
    // the Better Auth tables are empty.
    const signIn = await ctx.post("/api/auth/sign-in/email", {
      data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      headers: { "content-type": "application/json" },
    });
    if (!signIn.ok()) {
      const body = await signIn.text();
      throw new Error(
        `[e2e] POST /api/auth/sign-in/email → ${signIn.status()}\n` +
          `body: ${body}\n` +
          "Check that apps/api is listening and `pnpm db:seed` provisioned " +
          `the demo user (${DEMO_EMAIL}).`,
      );
    }

    // 3. Seed sanity — we rely on ${TENANT} having at least one
    // customer. Use the cookie we just got so the tenant-context
    // plugin doesn't 401 us.
    const setCookie = signIn.headers()["set-cookie"] ?? "";
    const cookie = setCookie.match(/erp\.session_token=[^;,\s]+/)?.[0] ?? "";
    const customers = await ctx.get("/v1/ent.customer?limit=1", {
      headers: {
        cookie,
        "x-tenant-id": TENANT,
      },
    });
    if (!customers.ok()) {
      const body = await customers.text();
      throw new Error(
        `[e2e] GET /v1/ent.customer → ${customers.status()}\n` +
          `body: ${body}\n` +
          `Did \`pnpm db:seed\` run against ${TENANT}?`,
      );
    }
    const payload = (await customers.json()) as {
      items?: readonly unknown[];
    };
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error(
        `[e2e] /v1/ent.customer returned an empty list — run \`pnpm db:seed\` first.`,
      );
    }
  } finally {
    await ctx.dispose();
  }
}
