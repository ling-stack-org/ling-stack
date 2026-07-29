import { access, readFile, readdir } from "node:fs/promises";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const packagesDirectory = fileURLToPath(new URL("../../../packages/", import.meta.url));
const appShellSourcePath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const importGuardPath = fileURLToPath(new URL("../scripts/check-ui2-imports.mjs", import.meta.url));

const deadClassTokens = [
  "workspace-readiness",
  "readiness-title",
  "readiness-summary",
  "readiness-grid",
  "readiness-item",
  "readiness-icon",
  "readiness-copy",
  "runtime-state-panel",
  "runtime-list",
  "runtime-list-row",
  "check-result",
  "check-result-status",
  "policy-tool-row",
  "settings-toggle",
  "tool-event-meta",
  "capability-list",
] as const;

const protectedClassTokens = [
  "first-run-flow",
  "first-run-step",
  "event-count",
  "runtime-kpi-grid",
  "runtime-policy-summary",
  "runtime-audit-block",
  "meta-list",
  "meta-row",
  "tool-row",
  "provider-run-notice",
  "status-badge",
  "plugin-capability-list",
] as const;

test("T13-P.4 removes only the frozen readiness and runtime prototype families", async () => {
  expect(deadClassTokens).toHaveLength(16);
  const files = await readSourceFiles();
  const productionFiles = files.filter((file) => file.kind === "production");
  const cssFiles = files.filter((file) => file.kind === "css");

  for (const token of deadClassTokens) {
    expect(
      findExactTokenOccurrences(productionFiles, token),
      `${token} must have no production emitter`,
    ).toEqual([]);
    expect(
      findExactClassSelectorOccurrences(cssFiles, token),
      `.${token} must have no CSS writer`,
    ).toEqual([]);
  }
});

test("T13-P.4 preserves adjacent First Run, runtime, metadata, tool and status owners", async () => {
  const files = await readSourceFiles();
  const productionFiles = files.filter((file) => file.kind === "production");
  const cssFiles = files.filter((file) => file.kind === "css");

  for (const token of protectedClassTokens) {
    expect(
      findExactTokenOccurrences(productionFiles, token).length,
      `${token} must retain a production emitter`,
    ).toBeGreaterThan(0);
    expect(
      findExactClassSelectorOccurrences(cssFiles, token).length,
      `.${token} must retain a CSS writer`,
    ).toBeGreaterThan(0);
  }

  const [appShellSource, importGuard] = await Promise.all([
    readFile(appShellSourcePath, "utf8"),
    readFile(importGuardPath, "utf8"),
  ]);
  expect(appShellSource.match(/<StatusBadge\b/gu)).toHaveLength(1);
  expect(importGuard).toMatch(/StatusBadge:\s*1,/u);
});

interface SourceFile {
  readonly content: string;
  readonly kind: "css" | "production";
  readonly path: string;
}

async function readSourceFiles(): Promise<readonly SourceFile[]> {
  const roots = [webSourceDirectory, ...await packageSourceDirectories()];
  const paths = (await Promise.all(roots.map((root) => collectSourcePaths(root)))).flat();
  return Promise.all(paths.map(async (path) => ({
    content: await readFile(path, "utf8"),
    kind: extname(path) === ".css" ? "css" as const : "production" as const,
    path: relative(repositoryDirectory, path),
  })));
}

async function packageSourceDirectories(): Promise<readonly string[]> {
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = fileURLToPath(new URL(`../../../packages/${entry.name}/src/`, import.meta.url));
    if (await pathExists(directory)) directories.push(directory);
  }
  return directories;
}

async function collectSourcePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}${directory.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) return collectSourcePaths(path);
    return /\.(css|html|ts|tsx)$/u.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function findExactTokenOccurrences(files: readonly SourceFile[], token: string): readonly string[] {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(token)}(?![A-Za-z0-9_-])`, "u");
  return files.filter((file) => pattern.test(file.content)).map((file) => file.path);
}

function findExactClassSelectorOccurrences(files: readonly SourceFile[], token: string): readonly string[] {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])\\.${escapeRegex(token)}(?![A-Za-z0-9_-])`, "u");
  return files.filter((file) => extractSelectorBranches(file.content).some((selector) => pattern.test(selector)))
    .map((file) => file.path);
}

function extractSelectorBranches(css: string): readonly string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((prelude) => prelude && !prelude.startsWith("@"))
    .flatMap((prelude) => prelude.split(",").map((branch) => branch.trim()))
    .filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
