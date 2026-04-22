// Shared ESLint configuration for the ERP Platform monorepo.
//
// Consumers wire this up via a one-line re-export:
//   module.exports = require("@erp/config/eslintrc");
//
// The rules here are the non-negotiable guardrails from CLAUDE.md §5:
// no `any`, no `@ts-ignore` without description, no non-null assertions,
// no default exports (except Next.js routing files), no `console.log`
// outside scripts. Violations fail CI via `pnpm verify`.

/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  env: {
    node: true,
    es2022: true,
  },
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:import/recommended",
    "plugin:import/typescript",
    "prettier",
  ],
  settings: {
    "import/resolver": {
      typescript: { alwaysTryTypes: true },
      node: true,
    },
  },
  rules: {
    // Forbidden TypeScript patterns (CLAUDE.md §5).
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/ban-ts-comment": [
      "error",
      {
        "ts-ignore": true,
        "ts-expect-error": "allow-with-description",
        "ts-nocheck": true,
        "ts-check": false,
        minimumDescriptionLength: 10,
      },
    ],
    "@typescript-eslint/consistent-type-assertions": [
      "error",
      {
        assertionStyle: "as",
        objectLiteralTypeAssertions: "never",
      },
    ],
    "@typescript-eslint/consistent-type-imports": [
      "error",
      { prefer: "type-imports", fixStyle: "separate-type-imports" },
    ],
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],

    // No default exports (§5). Next.js routing files opt out via overrides.
    "import/no-default-export": "error",
    "no-restricted-syntax": [
      "error",
      {
        selector: "ExportDefaultDeclaration",
        message:
          "Use named exports. Next.js pages, layouts, and routing files are exempt via an override.",
      },
    ],

    // No console.log outside scripts (§15). warn/error still allowed.
    "no-console": ["error", { allow: ["warn", "error"] }],

    // Import hygiene.
    "import/order": [
      "error",
      {
        groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
        "newlines-between": "always",
        alphabetize: { order: "asc", caseInsensitive: true },
      },
    ],
    "import/no-cycle": ["error", { maxDepth: 5 }],
    "import/newline-after-import": "error",

    // Prefer const, no vars.
    "prefer-const": "error",
    "no-var": "error",
  },
  overrides: [
    {
      // Scripts are allowed to log to the console.
      files: ["scripts/**/*.ts", "scripts/**/*.mjs", "scripts/**/*.cjs"],
      rules: {
        "no-console": "off",
      },
    },
    {
      // Config files often need default exports or console use.
      files: [
        "**/*.config.ts",
        "**/*.config.js",
        "**/*.config.cjs",
        "**/*.config.mjs",
        "**/.*rc.cjs",
        "**/.*rc.js",
      ],
      rules: {
        "no-console": "off",
        "import/no-default-export": "off",
        "no-restricted-syntax": "off",
        "@typescript-eslint/no-var-requires": "off",
      },
    },
    {
      // Next.js App Router files must use default exports.
      // Matched by basename so the rule fires regardless of whether ESLint runs
      // from the repo root (`pnpm lint`) or from inside the app (`next build`).
      files: [
        "**/app/**/{page,layout,loading,error,not-found,template,default,route}.{ts,tsx,js,jsx}",
        "**/next.config.*",
      ],
      rules: {
        "import/no-default-export": "off",
        "no-restricted-syntax": "off",
      },
    },
    {
      // Tests: loosen a couple of rules.
      files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**/*.ts", "**/test/**/*.tsx"],
      rules: {
        "@typescript-eslint/no-non-null-assertion": "off",
      },
    },
  ],
  ignorePatterns: [
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
    "node_modules",
    "playwright-report",
    "test-results",
    "*.min.js",
  ],
};
