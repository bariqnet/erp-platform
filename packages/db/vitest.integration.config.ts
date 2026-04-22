// Vitest config for integration tests — spins up real containers via
// Testcontainers and exercises the database, cache, and search-index layers
// against them. Runs with `pnpm test:integration`, not the default
// `pnpm test` (which excludes `*.integration.test.ts` via the shared base).
//
// This config is standalone (does NOT merge with @erp/config/vitest.base)
// because the base excludes `*.integration.test.ts` — merging would
// concatenate the exclude array and keep filtering these tests out.

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
    // Container pulls on a cold machine can take two minutes per image.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // Each integration test file gets its own worker process so containers
    // from one test never leak into another.
    fileParallelism: true,
    isolate: true,
  },
});
