import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyChangedFiles } from "./classify-scope.mjs";
import { assertCiResults } from "./execution-policy.mjs";
import { createTestPlan } from "./test-shard-plan.mjs";

const reviews = ["native/office-local/reviewed-packaged-source-v1.json", "native/sandbox/reviewed-codesign-source-v1.json"];
const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

function job(id: string) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "mu").exec(workflow);
  assert.ok(match, id);
  return match[1];
}

test("native release reviews require only their build dependency and macOS publication contracts", async () => {
  for (const files of [[reviews[0]], [reviews[1]], [...reviews, "docs/release/README.md"]]) {
    const scope = classifyChangedFiles({ files });
    assert.equal(scope.mode, "affected");
    assert.deepEqual(scope.packages, ["@ling-stack/daemon"]);
    assert.deepEqual(scope.testPackages, []);
    assert.deepEqual(scope.typecheckPackages, []);
    assert.equal(scope.nativeRelease, true);
    assert.equal(scope.macosNative, true);
    assert.equal(scope.macosHelper, false);
    assert.equal(scope.daemon, false);
    assert.deepEqual(scope.daemonPlatforms, []);
    assert.equal(scope.web, false);
    assert.equal(scope.assurance, false);
    assert.equal(scope.dependencyPolicy, false);
    const plan = await createTestPlan(scope.testPackages);
    assert.deepEqual(plan.unitMatrix.include, []);
    assert.deepEqual(plan.daemonMatrix.include, []);
  }
});

test("release metadata cannot hide mixed product inputs, native source or unknown neighbors", () => {
  const web = classifyChangedFiles({ files: [...reviews, "apps/web/src/App.tsx"] });
  assert.equal(web.mode, "affected");
  assert.equal(web.web, true);
  assert.equal(web.nativeRelease, true);
  assert.equal(web.daemon, false);
  assert.ok(web.testPackages.includes("@ling-stack/web"));
  assert.ok(!web.testPackages.includes("@ling-stack/daemon"));
  const native = classifyChangedFiles({ files: [...reviews, "native/sandbox/src/main.rs"] });
  assert.equal(native.daemon, true);
  assert.equal(native.macosHelper, true);
  assert.equal(native.nativeRelease, true);
  for (const file of ["native/office-local/unknown.json", "native/office-local/src/main.cc",
    "native/office-local/reviewed-packaged-source-v1.json.backup", "pnpm-lock.yaml", ".github/workflows/ci.yml"]) {
    assert.equal(classifyChangedFiles({ files: [...reviews, file] }).mode, "full", file);
  }
  const missing = classifyChangedFiles({ files: reviews, packageEntries: [] });
  assert.equal(missing.mode, "full");
});

test("full regression retains real helper smoke and a changed review still requires its contracts", () => {
  for (const options of [{ forceFull: true }, { eventName: "schedule" }, { eventName: "workflow_dispatch" }]) {
    const scope = classifyChangedFiles({ files: reviews, ...options });
    assert.equal(scope.mode, "full");
    assert.equal(scope.macosHelper, true);
    assert.equal(scope.nativeRelease, true);
  }
  const docs = classifyChangedFiles({ files: ["docs/release/README.md"] });
  assert.equal(docs.macosNative, false);
  assert.equal(docs.macosHelper, false);
  assert.equal(docs.nativeRelease, false);
  const scheduled = classifyChangedFiles({ files: [], eventName: "schedule" });
  assert.equal(scheduled.mode, "full");
  assert.equal(scheduled.macosHelper, true);
  assert.equal(scheduled.nativeRelease, false);
});

test("the aggregate rejects skipped, failed and cancelled release contracts and required builds", () => {
  const scope = classifyChangedFiles({ files: reviews });
  const results: Record<string, string> = { SCOPE: "success", COMMON: "success", BUILD: "success", MACOS_NATIVE: "success",
    DEPENDENCY: "skipped", ASSURANCE: "skipped", TYPECHECK: "skipped", UNIT: "skipped", DAEMON: "skipped",
    LINUX_CONTRACT: "skipped", WEB_SMOKE: "skipped" };
  const check = (overrides: Record<string, string> = {}) => assertCiResults({ tier: "complete", mode: scope.mode,
    assurance: scope.assurance, build: scope.packages.length > 0, dependency: scope.dependencyPolicy,
    typecheck: scope.typecheckPackages.length > 0, unit: false, daemon: scope.daemon, macosNative: scope.macosNative,
    web: scope.web, results: { ...results, ...overrides } });
  assert.equal(check(), true);
  for (const lane of ["BUILD", "MACOS_NATIVE"]) {
    for (const result of ["skipped", "failure", "cancelled", ""]) {
      assert.throws(() => check({ [lane]: result }), new RegExp(`${lane}=`, "u"));
    }
  }
});

test("the macOS job independently gates native smoke and the complete publication test list", () => {
  const source = job("restricted-command-macos");
  assert.match(source, /if: .*!cancelled\(\).*execution-tier == 'complete'.*macos-native == 'true'.*needs\.build\.result == 'success'/u);
  assert.match(source, /runs-on: macos-26/u);
  for (const name of ["Require the actual arm64 macOS Host and fixed Seatbelt backend", "Prepare the pinned native build inputs",
    "Build a fresh helper and run real Host and channel isolation smoke"]) {
    const step = source.slice(source.indexOf(`      - name: ${name}`));
    assert.match(step, /^      - name: [^\n]+\n        if: needs\.scope\.outputs\.macos-helper == 'true'/u);
  }
  const release = source.slice(source.indexOf("      - name: Check changed native release reviews"));
  assert.match(release, /if: needs\.scope\.outputs\.native-release == 'true'/u);
  const command = /run: >-\n([\s\S]+)/u.exec(release)?.[1].trim().replace(/\s+/gu, " ");
  assert.equal(command, "node --test --test-concurrency=1 apps/desktop/tests/packaged-codesign-review-publication.test.mjs "
    + "apps/desktop/tests/packaged-office-native-publication.test.mjs apps/desktop/tests/packaged-office-daemon-source-inputs.test.mjs");
  for (const [field, property] of [["macos-helper", "macosHelper"], ["native-release", "nativeRelease"]]) {
    assert.ok(job("scope").includes(`"${field}": String(scope.${property})`));
    assert.ok(job("scope").includes(`${field}: \${{ steps.classify.outputs.${field} }}`));
  }
  assert.match(job("quality"), /MACOS_NATIVE_RESULT: \$\{\{ needs\.restricted-command-macos\.result \}\}/u);
});

test("the actual macOS selection guard rejects missing, invalid and empty selectors", () => {
  const source = job("restricted-command-macos");
  const step = source.slice(source.indexOf("      - name: Validate selected macOS work"));
  const command = /run: \|\n((?: {10}[^\n]*\n)+)/u.exec(step)?.[1].replace(/^ {10}/gmu, "");
  assert.ok(command);
  const check = (helper: string | undefined, release: string | undefined) => spawnSync("bash", ["-euo", "pipefail", "-c", command], {
    encoding: "utf8", env: { ...process.env, MACOS_HELPER_SELECTED: helper, NATIVE_RELEASE_SELECTED: release },
  });
  for (const [helper, release] of [["true", "false"], ["false", "true"], ["true", "true"]]) {
    const result = check(helper, release);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  for (const [helper, release] of [["false", "false"], [undefined, "true"], ["true", undefined],
    ["undefined", "true"], ["TRUE", "false"], ["true", " false"]]) {
    const result = check(helper, release);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Invalid or empty macOS work selection/u);
  }
});
