// Vitest config for integration tests — Testcontainers + a fresh
// Postgres per test file. Mirrors @erp/db's vitest.integration.config.ts;
// see writing-a-test.md for the rationale on why this is standalone
// rather than mergeConfig'd with the shared base.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    passWithNoTests: false,
    include: ["**/*.integration.test.ts"],
    exclude: ["node_modules", "dist", ".turbo", "coverage"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    isolate: true,
  },
});
