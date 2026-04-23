// Vitest config for telemetry integration tests. The OTLP round-trip
// test below does not need Testcontainers — the "collector" is a
// Fastify instance in the same process — but `pnpm test` excludes the
// `.integration.test.ts` suffix globally (so the SDK's 200-300 ms
// start cost doesn't weigh down the fast unit loop). Run this with
// `pnpm --filter @erp/telemetry test:integration`.

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
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: true,
    isolate: true,
  },
});
