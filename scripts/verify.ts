/**
 * scripts/verify.ts — the one command that gates every commit.
 *
 * Runs in sequence per CLAUDE.md §4:
 *   1. pnpm typecheck
 *   2. pnpm lint
 *   3. pnpm test
 *   4. pnpm build         (skip with --skip-build for faster iteration)
 *   5. Five custom invariants:
 *      a. Every tenant-scoped repository extends `TenantRepository`
 *      b. Every Fastify route has a Zod schema
 *      c. No `@ts-ignore` or `as any` (or undescribed `@ts-expect-error`)
 *      d. No `console.log` outside `scripts/`
 *      e. Every migration file has a `-- Rollback plan:` header block
 *
 * Exits non-zero on any failure. Always runs every check (no fast-fail)
 * so a single run surfaces every problem.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { globSync } from "tinyglobby";
import { Project, SyntaxKind, type Node, type SourceFile } from "ts-morph";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const SKIP_BUILD = args.has("--skip-build");
const ONLY_INVARIANTS = args.has("--only-invariants");

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly durationMs: number;
}

function header(text: string): void {
  console.log(`\n━━━ ${text} ${"━".repeat(Math.max(0, 70 - text.length))}`);
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function runShell(name: string, command: string): CheckResult {
  header(name);
  const start = Date.now();
  const result = spawnSync(command, {
    cwd: REPO_ROOT,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const durationMs = Date.now() - start;
  const ok = result.status === 0;
  return {
    name,
    ok,
    violations: ok ? [] : [`exit code ${result.status ?? "signal"}`],
    durationMs,
  };
}

// ── Source-tree helpers ────────────────────────────────────────────────────

function listSourceFiles(): string[] {
  return globSync(["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"], {
    cwd: REPO_ROOT,
    absolute: true,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/build/**",
    ],
  });
}

function loadProject(files: readonly string[]): Project {
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  for (const f of files) project.addSourceFileAtPath(f);
  return project;
}

function rel(p: string): string {
  return relative(REPO_ROOT, p);
}

function loc(node: Node): string {
  const sf = node.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
  return `${rel(sf.getFilePath())}:${line}:${column}`;
}

// ── Invariant 1: every Repository extends TenantRepository ─────────────────

function invariantRepositoriesExtendBase(project: Project): CheckResult {
  const start = Date.now();
  const violations: string[] = [];
  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath().includes("/test/") || sf.getFilePath().endsWith(".test.ts")) continue;
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name || !/Repository$/.test(name)) continue;
      if (name === "TenantRepository") continue;
      // Allow an explicit opt-out for vendor-level (tenant-agnostic) repos.
      const above = sf.getFullText().slice(0, cls.getStart()).split("\n").slice(-3).join("\n");
      if (/@vendor-repository/.test(above)) continue;
      const ext = cls.getExtends();
      if (!ext || ext.getText() !== "TenantRepository") {
        violations.push(
          `${loc(cls)} — class "${name}" must extend TenantRepository ` +
            `(or carry a "// @vendor-repository" comment justifying tenant-agnostic access)`,
        );
      }
    }
  }
  return {
    name: "invariant: repositories extend TenantRepository",
    ok: violations.length === 0,
    violations,
    durationMs: Date.now() - start,
  };
}

// ── Invariant 2: every Fastify route has a Zod schema ──────────────────────

const FASTIFY_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function invariantRoutesHaveZodSchema(project: Project): CheckResult {
  const start = Date.now();
  const violations: string[] = [];
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (!fp.includes("/apps/api/src/routes/")) continue;
    if (fp.endsWith(".test.ts")) continue;

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) continue;
      const member = expr.getName();
      if (!FASTIFY_VERBS.has(member) && member !== "route") continue;

      // Heuristic: the call's receiver root must look like a Fastify instance
      // (parameter named fastify/server/app). Skip otherwise.
      const root = expr.getExpression().getText();
      if (!/^(fastify|server|app)\b/.test(root)) continue;

      const args = call.getArguments();
      const optionsArg = member === "route" ? args[0] : args.length >= 3 ? args[1] : undefined;

      if (!optionsArg || !optionsArg.isKind(SyntaxKind.ObjectLiteralExpression)) {
        violations.push(`${loc(call)} — route has no options object with a schema`);
        continue;
      }
      const schemaProp = optionsArg.getProperty("schema");
      if (!schemaProp) {
        violations.push(`${loc(call)} — route options object has no "schema" property`);
      }
    }
  }
  return {
    name: "invariant: routes have a Zod schema",
    ok: violations.length === 0,
    violations,
    durationMs: Date.now() - start,
  };
}

// ── Invariant 3: no @ts-ignore / `as any` / undescribed @ts-expect-error ──

const TS_IGNORE_RE = /@ts-ignore\b/;
const TS_EXPECT_ERROR_RE = /@ts-expect-error\b\s*(.*)$/m;
const TS_NOCHECK_RE = /@ts-nocheck\b/;
const AS_ANY_RE = /\bas\s+any\b/;
const AS_UNKNOWN_AS_RE = /\bas\s+unknown\s+as\s+(?!unknown\b)/;

function invariantNoSilencingTypes(project: Project): CheckResult {
  const start = Date.now();
  const violations: string[] = [];
  for (const sf of project.getSourceFiles()) {
    const fp = rel(sf.getFilePath());
    const text = sf.getFullText();

    text.split("\n").forEach((line, idx) => {
      const lineNo = idx + 1;
      const trimmed = line.trim();
      if (TS_IGNORE_RE.test(line)) {
        violations.push(`${fp}:${lineNo} — @ts-ignore is forbidden; fix the types`);
      }
      if (TS_NOCHECK_RE.test(line)) {
        violations.push(`${fp}:${lineNo} — @ts-nocheck is forbidden; fix the types`);
      }
      const expectErrMatch = TS_EXPECT_ERROR_RE.exec(line);
      if (expectErrMatch) {
        const description = (expectErrMatch[1] ?? "").trim();
        if (description.length < 10) {
          violations.push(`${fp}:${lineNo} — @ts-expect-error needs a ≥10-char inline description`);
        }
      }
      // `as any` and `as unknown as X` checks; skip line-comment-only lines.
      if (!trimmed.startsWith("//")) {
        if (AS_ANY_RE.test(line)) {
          violations.push(`${fp}:${lineNo} — "as any" is forbidden; use unknown + Zod`);
        }
        if (AS_UNKNOWN_AS_RE.test(line)) {
          violations.push(
            `${fp}:${lineNo} — "as unknown as X" bypass is forbidden; validate with Zod`,
          );
        }
      }
    });
  }
  return {
    name: "invariant: no @ts-ignore / as any in committed code",
    ok: violations.length === 0,
    violations,
    durationMs: Date.now() - start,
  };
}

// ── Invariant 4: no console.log/.debug/.info outside scripts/ ──────────────

const FORBIDDEN_CONSOLE_METHODS = new Set(["log", "debug", "info"]);

function invariantNoConsoleLog(project: Project): CheckResult {
  const start = Date.now();
  const violations: string[] = [];
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (fp.includes("/scripts/")) continue;
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) continue;
      if (expr.getExpression().getText() !== "console") continue;
      const method = expr.getName();
      if (FORBIDDEN_CONSOLE_METHODS.has(method)) {
        violations.push(
          `${loc(call)} — console.${method} is forbidden outside scripts/; ` +
            `use the pino logger from @erp/telemetry`,
        );
      }
    }
  }
  return {
    name: "invariant: no console.log outside scripts/",
    ok: violations.length === 0,
    violations,
    durationMs: Date.now() - start,
  };
}

// ── Invariant 5: every migration has a documented rollback plan ───────────

function invariantMigrationsHaveRollback(): CheckResult {
  const start = Date.now();
  const violations: string[] = [];
  const files = globSync(["infra/migrations/**/*.sql"], {
    cwd: REPO_ROOT,
    absolute: true,
  });
  for (const fp of files) {
    const text = readFileSync(fp, "utf8");
    const upMarkerIdx = text.search(/^--\s*\+migrate up\b/m);
    if (upMarkerIdx === -1) {
      violations.push(`${rel(fp)} — missing "-- +migrate up" marker`);
      continue;
    }
    const downMarkerIdx = text.search(/^--\s*\+migrate down\b/m);
    if (downMarkerIdx === -1) {
      violations.push(`${rel(fp)} — missing "-- +migrate down" marker`);
    }
    const header = text.slice(0, upMarkerIdx);
    const rollbackHdrIdx = header.search(/^--\s*Rollback plan:/m);
    if (rollbackHdrIdx === -1) {
      violations.push(`${rel(fp)} — missing "-- Rollback plan:" header before "+migrate up"`);
      continue;
    }
    // After the "Rollback plan:" line, expect at least one non-empty `--`
    // continuation line before the up-marker.
    const afterHdr = header.slice(rollbackHdrIdx).split("\n").slice(1);
    const continuation = afterHdr.find((line) => /^--\s+\S/.test(line));
    if (!continuation) {
      violations.push(
        `${rel(fp)} — "Rollback plan:" header has no body lines before "+migrate up"`,
      );
    }
  }
  return {
    name: "invariant: every migration has a rollback plan",
    ok: violations.length === 0,
    violations,
    durationMs: Date.now() - start,
  };
}

// ── Reporter ───────────────────────────────────────────────────────────────

function printResult(r: CheckResult): void {
  const status = r.ok ? "✓" : "✗";
  console.log(`${status} ${r.name} (${fmtMs(r.durationMs)})`);
  for (const v of r.violations.slice(0, 50)) console.log(`    ${v}`);
  if (r.violations.length > 50) {
    console.log(`    … ${r.violations.length - 50} more`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))) {
    console.error("verify: must run from the repo root (pnpm-workspace.yaml not found)");
    process.exit(2);
  }

  const results: CheckResult[] = [];

  if (!ONLY_INVARIANTS) {
    results.push(runShell("pnpm typecheck", "pnpm -r --no-bail run typecheck"));
    results.push(runShell("pnpm lint", "pnpm -r --no-bail run lint"));
    // CLAUDE.md §4 lists 5 explicit checks; format:check is added because
    // ESLint does not enforce Prettier (eslint-config-prettier disables only
    // conflicting rules) and unformatted commits would otherwise pass verify.
    results.push(runShell("pnpm format:check", "pnpm format:check"));
    results.push(runShell("pnpm test", "pnpm -r --no-bail run test"));
    if (!SKIP_BUILD) {
      results.push(runShell("pnpm build", "pnpm -r run build"));
    }
  }

  header("custom invariants");
  const files = listSourceFiles();
  const project = loadProject(files);
  console.log(`scanning ${files.length} TS/TSX file(s)\n`);
  results.push(invariantRepositoriesExtendBase(project));
  results.push(invariantRoutesHaveZodSchema(project));
  results.push(invariantNoSilencingTypes(project));
  results.push(invariantNoConsoleLog(project));
  results.push(invariantMigrationsHaveRollback());

  header("summary");
  for (const r of results) printResult(r);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n✗ verify: ${failed.length} of ${results.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\n✓ verify: all ${results.length} check(s) passed`);
}

main().catch((err: unknown) => {
  console.error("verify: unexpected error");
  console.error(err);
  process.exit(2);
});
