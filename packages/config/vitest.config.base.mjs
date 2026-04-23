// Shared Vitest base configuration.
//
// Consumers wire this up by importing the defaults directly:
//   import baseConfig from "@erp/config/vitest.base";
//   export default baseConfig;
//
// Or by merging with their own options:
//   import { mergeConfig } from "vitest/config";
//   import baseConfig from "@erp/config/vitest.base";
//   export default mergeConfig(baseConfig, { ... });
//
// This file is `.mjs` (not `.ts`) so Node ESM can load it directly across
// package boundaries — Vitest's config loader does not run a TS transform
// when resolving cross-package imports.

import { defineConfig } from "vitest/config";

export const baseConfig = defineConfig({
  test: {
    environment: "node",
    globals: false,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    passWithNoTests: false,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // *.integration.test.ts runs via `pnpm test:integration`, not the default
    // `pnpm test`, because integration tests spin up real containers and are
    // too slow for every-commit verify.
    //
    // *.bench.test.ts runs via `pnpm test:bench` — perf assertions are
    // sensitive to parallel-test contention; running them under load
    // produces flaky failures unrelated to real regressions. The bench
    // file's own assertions still hold under stable conditions.
    exclude: [
      "node_modules",
      "dist",
      ".turbo",
      "coverage",
      "**/*.integration.test.ts",
      "**/*.bench.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "src/**/types.ts"],
    },
  },
});

export default baseConfig;
