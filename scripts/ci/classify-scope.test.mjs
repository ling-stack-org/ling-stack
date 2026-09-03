import assert from "node:assert/strict";
import test from "node:test";
import { classifyChangedFiles } from "./classify-scope.mjs";

const packageEntries = [
  entry("@ling-stack/contracts", "packages/contracts", [], true, true),
  entry("@ling-stack/plugin-sdk", "packages/plugin-sdk", [], true, true),
  entry("@ling-stack/core", "packages/core", ["@ling-stack/contracts", "@ling-stack/plugin-sdk"], true, true),
  entry("@ling-stack/providers", "packages/providers", ["@ling-stack/plugin-sdk"], true, true),
  entry("@ling-stack/daemon", "packages/daemon", ["@ling-stack/core", "@ling-stack/providers"], true, true),
  entry("@ling-stack/cli", "packages/cli", ["@ling-stack/daemon"], true, true),
  entry("@ling-stack/ui-react", "packages/ui-react", [], true, true),
  entry("@ling-stack/chrome-extension", "apps/chrome-extension", [], true, true),
  entry("@ling-stack/web", "apps/web", ["@ling-stack/core", "@ling-stack/ui-react"], true, true),
  entry("@ling-stack/desktop", "apps/desktop", ["@ling-stack/ui-react"], true, true),
  entry("@ling-stack/mobile", "apps/mobile", [], true, true),
];

function entry(name, directory, dependencies, hasTestScript, hasTypecheckScript) {
  return { name, directory, dependencies, hasTestScript, hasTypecheckScript };
}

function classify(files, extra = {}) {
  return classifyChangedFiles({ files, packageEntries, ...extra });
}

test("documentation-only changes use the fast lane", () => {
  assert.equal(classify(["README.md", "packages/core/README.md", "docs/assets/preview.png"]).mode, "docs");
});

test("documentation mixed with source changes uses affected packages", () => {
  const scope = classify(["docs/ci.md", "packages/providers/src/index.ts"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/cli", "@ling-stack/daemon", "@ling-stack/providers"]);
});

test("dependency, workflow, and CI script changes force full scope", () => {
  for (const file of ["package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml", "scripts/ci/new-check.mjs"]) {
    assert.equal(classify([file]).mode, "full", file);
  }
});

test("Web changes stay in Web and its transitive consumers", () => {
  const scope = classify(["apps/web/src/App.tsx"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/web"]);
  assert.equal(scope.web, true);
  assert.equal(scope.daemon, false);
  assert.ok(scope.testPackages.includes("@ling-stack/web"));
});

test("core changes include daemon, CLI, and Web consumers", () => {
  const scope = classify(["packages/core/src/index.ts"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/cli", "@ling-stack/core", "@ling-stack/daemon", "@ling-stack/web"]);
  assert.equal(scope.daemon, true);
  assert.equal(scope.web, true);
});

test("daemon source changes include CLI but do not pull Web", () => {
  const scope = classify(["packages/daemon/src/index.ts"]);
  assert.deepEqual(scope.packages, ["@ling-stack/cli", "@ling-stack/daemon"]);
  assert.equal(scope.daemon, true);
  assert.equal(scope.web, false);
});

test("Chrome extension and Mobile changes select their own checks", () => {
  const chrome = classify(["apps/chrome-extension/src/background.js"]);
  assert.deepEqual(chrome.packages, ["@ling-stack/chrome-extension"]);
  assert.deepEqual(chrome.testPackages, ["@ling-stack/chrome-extension"]);
  assert.ok(chrome.typecheckPackages.includes("@ling-stack/chrome-extension"));

  const mobile = classify(["apps/mobile/src/App.tsx"]);
  assert.deepEqual(mobile.packages, ["@ling-stack/mobile"]);
  assert.deepEqual(mobile.testPackages, ["@ling-stack/mobile"]);
  assert.ok(mobile.typecheckPackages.includes("@ling-stack/mobile"));
});

test("test-only changes keep the direct package scope", () => {
  const scope = classify(["packages/daemon/test/runtime-supervisor.test.mjs"]);
  assert.deepEqual(scope.packages, ["@ling-stack/daemon"]);
  assert.deepEqual(scope.testPackages, ["@ling-stack/daemon"]);
  assert.match(scope.reason, /test/);
});

test("shared test fixtures expand the importing package", () => {
  const scope = classify(["packages/ui-react/test/fixtures/theme-package-fixtures.mjs"]);
  assert.equal(scope.mode, "affected");
  assert.ok(scope.packages.includes("@ling-stack/ui-react"));
  assert.ok(scope.packages.includes("@ling-stack/desktop"));
});

test("unknown paths and non-PR events use full scope", () => {
  assert.equal(classify(["CONTRIBUTORS.txt"]).mode, "full");
  assert.equal(classify(["packages/core/src/index.ts"], { eventName: "schedule" }).mode, "full");
});
