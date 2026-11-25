import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { classifyChangedFiles } from "./classify-scope.mjs";
import { analyzeLockfileChange } from "./lockfile-scope.mjs";
import { auditScope, auditTestPlanSubset } from "./scope-audit.mjs";
import { hasDaemonBabelParserCoverage } from "./test-file-profiles.mjs";
import { createTestPlan } from "./test-shard-plan.mjs";

const daemon = "@ling-stack/daemon";
const desktop = "@ling-stack/desktop";
const mobile = "@ling-stack/mobile";
const parserTests = [
  "test/codex-protocol-integrity.test.mjs",
  "test/workflow-scheduler-wiring.test.mjs",
];

const previousDaemon = {
  directory: "packages/daemon", name: daemon, dependencies: [],
  hasTestScript: true, hasTypecheckScript: true, scriptsFingerprint: "[]",
  manifest: { name: daemon, devDependencies: { "@babel/parser": "8.1.2", "verify-tool": "1.0.0" } },
};
const currentDaemon = {
  ...previousDaemon,
  manifest: { name: daemon, devDependencies: { ...previousDaemon.manifest.devDependencies, "@babel/parser": "8.1.3" } },
};
const previousDesktop = {
  directory: "apps/desktop", name: desktop, dependencies: [],
  hasTestScript: false, hasTypecheckScript: true, scriptsFingerprint: "[]",
  manifest: { name: desktop, devDependencies: { electron: "45.3.1" } },
};
const currentDesktop = {
  ...previousDesktop, manifest: { name: desktop, devDependencies: { electron: "45.4.1" } },
};
const mobilePackage = {
  directory: "apps/mobile", name: mobile, dependencies: [],
  hasTestScript: true, hasTypecheckScript: true, scriptsFingerprint: "[]",
};

function lockfile(parser: string, electron: string, mobileHelper: string, verifyHelper = "1.0.0") {
  return `lockfileVersion: '9.0'

importers:

  .: {}

  apps/desktop:
    devDependencies:
      electron:
        specifier: ${electron}
        version: ${electron}

  apps/mobile:
    dependencies:
      mobile-tool:
        specifier: 1.0.0
        version: 1.0.0

  packages/daemon:
    devDependencies:
      '@babel/parser':
        specifier: ${parser}
        version: ${parser}
      verify-tool:
        specifier: 1.0.0
        version: 1.0.0

packages:

  '@babel/parser@${parser}': {}
  electron@${electron}: {}
  helper@1.0.0: {}
  helper@1.0.1: {}
  mobile-tool@1.0.0: {}
  verify-tool@1.0.0: {}

snapshots:

  '@babel/parser@${parser}': {}
  electron@${electron}: {}
  helper@1.0.0: {}
  helper@1.0.1: {}
  mobile-tool@1.0.0:
    dependencies:
      helper: ${mobileHelper}
  verify-tool@1.0.0:
    dependencies:
      helper: ${verifyHelper}
`;
}

const before = lockfile("8.1.2", "45.3.1", "1.0.0");
const after = lockfile("8.1.3", "45.4.1", "1.0.1");
type ScopeInput = Parameters<typeof classifyChangedFiles>[0];
const input = {
  files: ["apps/desktop/package.json", "packages/daemon/package.json", "pnpm-lock.yaml"],
  packageEntries: [currentDaemon, currentDesktop, mobilePackage],
  basePackageEntries: [previousDaemon, previousDesktop, mobilePackage],
  lockfileScope: analyzeLockfileChange({ before, after }),
} satisfies ScopeInput;
const classify = (options: Partial<ScopeInput> = {}) => classifyChangedFiles({ ...input, ...options });

test("an isolated Daemon parser update runs the Linux consumers and preserves other affected checks", async () => {
  const scope = classify();
  assert.equal(scope.mode, "affected");
  assert.equal(scope.testProfile, "daemon-babel-parser");
  assert.deepEqual(scope.testPackages, [daemon, mobile]);
  assert.deepEqual(scope.typecheckPackages, [daemon, desktop, mobile]);
  assert.equal(scope.dependencyPolicy, true);
  assert.equal(scope.linuxContract, true);

  const plan = await createTestPlan(scope.testPackages, scope);
  assert.deepEqual(plan.suites["daemon-linux"].files, parserTests);
  assert.deepEqual(plan.daemonMatrix.include, [
    { suite: "daemon-linux", shard: 0, runner: "ubuntu-latest", shardCount: 1, concurrency: 2 },
  ]);
  assert.deepEqual(plan.unitMatrix.include, [{ suite: "packages", shard: 0 }]);

  const full = classify({ forceFull: true });
  const fullPlan = await createTestPlan(full.testPackages, full);
  assert.equal(full.testProfile, undefined);
  assert.equal(auditScope(scope, full).passed, true);
  assert.equal(auditTestPlanSubset(plan, fullPlan).passed, true);
});

test("another Daemon development dependency's transitive update retains both platforms", () => {
  const lockfileScope = analyzeLockfileChange({
    before, after: lockfile("8.1.3", "45.4.1", "1.0.1", "1.0.1"),
  });
  assert.equal(lockfileScope.mode, "affected");
  assert.ok(lockfileScope.directories.includes("packages/daemon"));
  assert.equal(lockfileScope.isolatedDevelopmentUpdates?.has("packages/daemon") ?? false, false);
  assert.deepEqual(classify({ lockfileScope }).daemonPlatforms, ["linux", "darwin"]);
});

test("unverified pins, a changed Daemon input, and an affected workspace dependency retain both platforms", () => {
  const changedDaemon = {
    ...currentDaemon, manifest: { name: daemon, devDependencies: { ...currentDaemon.manifest.devDependencies, "verify-tool": "1.0.1" } },
  };
  const daemonWithWorkspaceInput = { ...currentDaemon, dependencies: [mobile] };
  for (const changes of [
    { lockfileScope: { ...input.lockfileScope, isolatedDevelopmentUpdates: undefined } },
    { files: [...input.files, "packages/daemon/src/server/router.ts"] },
    { packageEntries: [changedDaemon, currentDesktop, mobilePackage] },
    { packageEntries: [daemonWithWorkspaceInput, currentDesktop, mobilePackage] },
  ]) {
    const scope = classify(changes);
    assert.equal(scope.testProfile, undefined);
    assert.deepEqual(scope.daemonPlatforms, ["linux", "darwin"]);
  }
});

test("an unregistered parser consumer invalidates the focused Daemon coverage", t => {
  const fixture = mkdtempSync(join(tmpdir(), "ling-parser-coverage-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: fixture });
  function track(filename: string) {
    const file = join(fixture, "packages/daemon", filename);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "@babel/parser\n");
    execFileSync("git", ["add", "--", file], { cwd: fixture });
  }
  for (const file of ["package.json", "scripts/import-codex-protocol.mjs", ...parserTests]) track(file);
  assert.equal(hasDaemonBabelParserCoverage(fixture), true);
  track("src/extra-parser-consumer.ts");
  assert.equal(hasDaemonBabelParserCoverage(fixture), false);
});
