import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditScope, auditTestPlanSubset, renderScopeSummary } from "./scope-audit.mjs";

type Scope = {
  mode: "docs" | "affected" | "full";
  files: string[];
  packages: string[];
  testPackages: string[];
  typecheckPackages: string[];
  dependencyPolicy: boolean;
  assurance: boolean;
  daemon: boolean;
  daemonPlatforms: string[];
  linuxContract: boolean;
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
    assurance: false, daemon: false, daemonPlatforms: [], linuxContract: false, macosNative: false, macosHelper: false,
    nativeRelease: false, web: false, reason: "workspace source change with transitive consumers", ...overrides,
  };
}

test("accepts a selective scope only when it is contained by forced full scope", () => {
  const result = auditScope(scope(), scope({ mode: "full", packages: ["@ling-stack/core", "@ling-stack/daemon"],
    testPackages: ["@ling-stack/core", "@ling-stack/daemon"], typecheckPackages: ["@ling-stack/core", "@ling-stack/daemon"],
    dependencyPolicy: true, assurance: true, daemon: true, daemonPlatforms: ["linux", "darwin"], linuxContract: true, macosNative: true, macosHelper: true, web: true }));
  assert.deepEqual(result, { passed: true, issues: [], selectedPackageCount: 1, fullPackageCount: 2, omittedPackageCount: 1 });
});

test("reports package, lane, platform, and documentation-scope escapes", () => {
  const result = auditScope(scope({ mode: "docs", packages: ["@ling-stack/core"], testPackages: [], typecheckPackages: [], daemon: true,
    daemonPlatforms: ["freebsd"], linuxContract: true, web: true }), scope({ mode: "full", packages: [], testPackages: [], typecheckPackages: [], linuxContract: true }));
  assert.equal(result.passed, false);
  assert.match(result.issues.join("\n"), /packages selects/u);
  assert.match(result.issues.join("\n"), /daemon platform freebsd/u);
  assert.match(result.issues.join("\n"), /documentation scope selected/u);
});

test("accepts selected test files only when they are covered by the forced full plan", () => {
  const full = {
    version: 1,
    suites: {
      core: { platform: "linux", files: ["test/a.test.ts", "test/b.test.ts"] },
      daemon: { platform: "darwin", files: ["test/native.test.mjs"] },
    },
    unitMatrix: { include: [{ suite: "core" }] },
    daemonMatrix: { include: [{ suite: "daemon" }] },
  };
  const selected = {
    version: 1,
    suites: { core: { platform: "linux", files: ["test/a.test.ts"] } },
    unitMatrix: { include: [{ suite: "core" }] },
    daemonMatrix: { include: [] },
  };
  assert.deepEqual(auditTestPlanSubset(selected, full), {
    passed: true, issues: [], selectedSuiteCount: 1, fullSuiteCount: 2,
    selectedTestFileCount: 1, fullTestFileCount: 3, omittedTestFileCount: 2,
  });
});

test("reports test files, platforms, and matrix suites outside the forced full plan", () => {
  const result = auditTestPlanSubset({
    version: 1,
    suites: { core: { platform: "darwin", files: ["test/missing.test.ts"] }, other: { platform: "linux", files: [] } },
    unitMatrix: { include: [{ suite: "other" }] },
    daemonMatrix: { include: [] },
  }, {
    version: 1,
    suites: { core: { platform: "linux", files: ["test/known.test.ts"] } },
    unitMatrix: { include: [{ suite: "core" }] },
    daemonMatrix: { include: [] },
  });
  assert.equal(result.passed, false);
  assert.match(result.issues.join("\n"), /changes platform/u);
  assert.match(result.issues.join("\n"), /test file core:test\/missing\.test\.ts/u);
  assert.match(result.issues.join("\n"), /test suite other is outside/u);
  assert.match(result.issues.join("\n"), /unitMatrix selects other outside/u);
});

test("renders selected and skipped lanes with bounded changed-path details", () => {
  const selective = scope({ files: Array.from({ length: 22 }, (_, index) => `packages/core/src/${index}.ts`) });
  const full = scope({ mode: "full", packages: ["@ling-stack/core", "@ling-stack/daemon"], testPackages: ["@ling-stack/core", "@ling-stack/daemon"],
    typecheckPackages: ["@ling-stack/core", "@ling-stack/daemon"], dependencyPolicy: true, assurance: true, daemon: true, daemonPlatforms: ["linux", "darwin"], linuxContract: true,
    macosNative: true, macosHelper: true, web: true });
  const report = renderScopeSummary(selective, full, { executionTier: "complete" });
  assert.match(report, /Mode: \*\*affected\*\*/u);
  assert.match(report, /Selected package build.*selected/u);
  assert.match(report, /Daemon test shards.*skipped/u);
  assert.match(report, /…and 2 more paths/u);
  assert.match(report, /Scope audit: \*\*passed\*\*/u);
  assert.match(renderScopeSummary(selective, full, {
    executionTier: "complete",
    planAudit: { passed: true, issues: [], selectedSuiteCount: 1, fullSuiteCount: 2,
      selectedTestFileCount: 1, fullTestFileCount: 4, omittedTestFileCount: 3 },
  }), /Test plan audit: \*\*passed\*\*; 1\/4 planned test files selected/u);
});

test("CLI writes the same report that it prints", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ling-ci-scope-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scopePath = join(directory, "scope.json");
  const fullPath = join(directory, "full.json");
  const planPath = join(directory, "plan.json");
  const fullPlanPath = join(directory, "full-plan.json");
  const outputPath = join(directory, "scope.md");
  await writeFile(scopePath, JSON.stringify(scope()));
  await writeFile(fullPath, JSON.stringify(scope({ mode: "full", packages: ["@ling-stack/core"], testPackages: ["@ling-stack/core"], typecheckPackages: ["@ling-stack/core"],
    dependencyPolicy: true, assurance: true, daemon: true, daemonPlatforms: ["linux", "darwin"], linuxContract: true, macosNative: true, macosHelper: true, web: true })));
  await writeFile(planPath, JSON.stringify({ version: 1, suites: { core: { platform: "linux", files: ["test/a.test.ts"] } }, unitMatrix: { include: [{ suite: "core" }] }, daemonMatrix: { include: [] } }));
  await writeFile(fullPlanPath, JSON.stringify({ version: 1, suites: { core: { platform: "linux", files: ["test/a.test.ts", "test/b.test.ts"] } }, unitMatrix: { include: [{ suite: "core" }] }, daemonMatrix: { include: [] } }));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["scripts/ci/scope-audit.mjs", `--scope=${scopePath}`, `--full-scope=${fullPath}`, `--plan=${planPath}`, `--full-plan=${fullPlanPath}`, "--execution-tier=complete", `--output=${outputPath}`]);
  const [code] = await new Promise<[number | null]>(resolve => child.on("close", status => resolve([status])));
  assert.equal(code, 0);
  assert.match(await readFile(outputPath, "utf8"), /Scope audit: \*\*passed\*\*/u);
  assert.match(await readFile(outputPath, "utf8"), /Test plan audit: \*\*passed\*\*/u);
});
