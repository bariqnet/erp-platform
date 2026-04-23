// Integration tests for apps/kernel — Testcontainers Postgres + the
// real buildKernel factory. Two kernels share the same DB to prove
// cache invalidation propagates across a fleet.

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
