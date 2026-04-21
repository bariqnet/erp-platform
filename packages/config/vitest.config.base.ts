import { defineConfig } from "vitest/config";

// Shared Vitest base configuration.
//
// Consumers wire this up by calling `mergeConfig(baseConfig, { ... })` in their
// local vitest.config.ts, or by importing the defaults directly. Defaults are
// deliberately conservative: node environment, strict globals off (import from
// "vitest"), no watch in CI, coverage via v8 opt-in per package.

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
