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
    exclude: ["node_modules", "dist", ".turbo", "coverage"],
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
