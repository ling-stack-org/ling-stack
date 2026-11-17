import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditScope, renderScopeSummary } from "./scope-audit.mjs";

type Scope = {
  mode: string;
  files: string[];
  packages: string[];
  testPackages: string[];
  typecheckPackages: string[];
  dependencyPolicy: boolean;
  assurance: boolean;
  daemon: boolean;
  daemonPlatforms: string[];
  macosNative: boolean;
  macosHelper: boolean;
  nativeRelease: boolean;
  web: boolean;
  reason: string;
};

function scope(overrides: Partial<Scope> = {}): Scope {
  return {
    mode: "affected", files: ["packages/core/src/index.ts"], packages: ["@ling-stack/core"],
    testPackages: ["@ling-stack/core"], typecheckPackages: ["@ling-stack/core"], dependencyPolicy: false,
    assurance: false, daemon: false, daemonPlatforms: [], macosNative: false, macosHelper: false,
    nativeRelease: false, web: false, reason: "workspace source change with transitive consumers", ...overrides,
  };
}

test("accepts a selective scope only when it is contained by forced full scope", () => {
  const result = auditScope(scope(), scope({ mode: "full", packages: ["@ling-stack/core", "@ling-stack/daemon"],
    testPackages: ["@ling-stack/core", "@ling-stack/daemon"], typecheckPackages: ["@ling-stack/core", "@ling-stack/daemon"],
    dependencyPolicy: true, assurance: true, daemon: true, daemonPlatforms: ["linux", "darwin"], macosNative: true, macosHelper: true, web: true }));
  assert.deepEqual(result, { passed: true, issues: [], selectedPackageCount: 1, fullPackageCount: 2, omittedPackageCount: 1 });
});

test("reports package, lane, platform, and documentation-scope escapes", () => {
  const result = auditScope(scope({ mode: "docs", packages: ["@ling-stack/core"], testPackages: [], typecheckPackages: [], daemon: true,
    daemonPlatforms: ["freebsd"], web: true }), scope({ mode: "full", packages: [], testPackages: [], typecheckPackages: [] }));
  assert.equal(result.passed, false);
  assert.match(result.issues.join("\n"), /packages selects/u);
  assert.match(result.issues.join("\n"), /daemon platform freebsd/u);
  assert.match(result.issues.join("\n"), /documentation scope selected/u);
});

test("renders selected and skipped lanes with bounded changed-path details", () => {
  const selective = scope({ files: Array.from({ length: 22 }, (_, index) => `packages/core/src/${index}.ts`) });
  const full = scope({ mode: "full", packages: ["@ling-stack/core", "@ling-stack/daemon"], testPackages: ["@ling-stack/core", "@ling-stack/daemon"],
    typecheckPackages: ["@ling-stack/core", "@ling-stack/daemon"], dependencyPolicy: true, assurance: true, daemon: true, daemonPlatforms: ["linux", "darwin"],
    macosNative: true, macosHelper: true, web: true });
  const report = renderScopeSummary(selective, full, { executionTier: "complete" });
  assert.match(report, /Mode: \*\*affected\*\*/u);
  assert.match(report, /Selected package build.*selected/u);
  assert.match(report, /Daemon test shards.*skipped/u);
  assert.match(report, /…and 2 more paths/u);
  assert.match(report, /Scope audit: \*\*passed\*\*/u);
});

test("CLI writes the same report that it prints", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ling-ci-scope-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scopePath = join(directory, "scope.json");
  const fullPath = join(directory, "full.json");
  const outputPath = join(directory, "scope.md");
  await writeFile(scopePath, JSON.stringify(scope()));
  await writeFile(fullPath, JSON.stringify(scope({ mode: "full", packages: ["@ling-stack/core"], testPackages: ["@ling-stack/core"], typecheckPackages: ["@ling-stack/core"],
    dependencyPolicy: true, assurance: true, daemon: true, daemonPlatforms: ["linux", "darwin"], macosNative: true, macosHelper: true, web: true })));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["scripts/ci/scope-audit.mjs", `--scope=${scopePath}`, `--full-scope=${fullPath}`, "--execution-tier=complete", `--output=${outputPath}`]);
  const [code] = await new Promise<[number | null]>(resolve => child.on("close", status => resolve([status])));
  assert.equal(code, 0);
  assert.match(await readFile(outputPath, "utf8"), /Scope audit: \*\*passed\*\*/u);
});
