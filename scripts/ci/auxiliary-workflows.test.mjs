import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const installerInputs = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/desktop/package.json",
  "apps/desktop/build/installer.nsh",
  "apps/desktop/build/icon.ico",
  "scripts/release/verify-nsis-plugins.mjs",
  "scripts/release/nsis-extractor.mjs",
  "scripts/ci/desktop-bun-entry.test.mjs",
  "scripts/gstack/packaged-browse-build.mjs",
  "apps/desktop/tests/distribution-nsis-native.test.mjs",
  "apps/desktop/scripts/distribution/installer-builder.mjs",
  "apps/desktop/scripts/distribution/LingShell.nsh",
  "apps/desktop/scripts/distribution/vendor-notices/nsis-plugins/sources.json",
  ".github/workflows/installer-contracts.yml",
];
const modelInputs = [
  "scripts/gstack/testsavant-model-cache.mjs",
  "scripts/gstack/testsavant-model-cache.test.mjs",
  "scripts/gstack/testsavant-model-state.test.mjs",
  "scripts/gstack/testsavant-model-pin.json",
  "scripts/gstack/testsavant-gs-client.mjs",
  "scripts/gstack/testsavant-client.mjs",
  ".github/workflows/model-cache-contracts.yml",
];

function pullRequestPaths(workflow) {
  const block = /^on:\n  pull_request:\n    paths:\n((?:      - [^\n]+\n)+)  workflow_dispatch:/mu.exec(workflow);
  assert.ok(block, "native workflows must retain a PR path allowlist and manual dispatch");
  return [...block[1].matchAll(/^      - (\S+)$/gmu)].map(match => match[1]);
}

for (const [name, patterns, positive, negative] of [
  ["installer-contracts", installerInputs, installerInputs, [
    "apps/desktop/src/main.ts",
    "apps/desktop/build/icon.icns",
    "apps/desktop/build/entitlements.cua-driver.plist",
    "apps/desktop/scripts/cua-driver-signing/after-pack.mjs",
    "apps/desktop/tests/other.test.mjs",
    "scripts/gstack/testsavant-client.mjs",
    ".github/workflows/model-cache-contracts.yml",
  ]],
  ["model-cache-contracts", [
    "scripts/gstack/testsavant-model-*.mjs",
    "scripts/gstack/testsavant-model-pin.json",
    "scripts/gstack/testsavant-gs-client.mjs",
    "scripts/gstack/testsavant-client.mjs",
    ".github/workflows/model-cache-contracts.yml",
  ], modelInputs, [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/desktop/package.json",
    "scripts/gstack/testsavant-model-cache.ts",
    "scripts/gstack/testsavant-model-other.json",
    "scripts/gstack/testsavant-model-fixtures/worker.mjs",
    "scripts/gstack/testsavant-client.test.mjs",
    "scripts/gstack/packaged-browse-build.mjs",
    ".github/workflows/installer-contracts.yml",
  ]],
]) {
  const workflow = readFileSync(new URL(`.github/workflows/${name}.yml`, root), "utf8");
  const paths = pullRequestPaths(workflow);
  const selected = path => paths.some(pattern => posix.matchesGlob(path, pattern));

  test(`${name} watches only its native contract inputs`, () => {
    assert.deepEqual([...paths].sort(), [...patterns].sort());
    for (const path of positive) assert.equal(selected(path), true, `must select ${path}`);
    assert.match(workflow, /runs-on: windows-2025/u);
  });

  test(`${name} excludes documentation and unrelated changes`, () => {
    for (const path of [
      "README.md", "docs/architecture.md", "apps/desktop/README.md",
      "scripts/gstack/testsavant-model-cache.md", "scripts/ci/README.md",
      "apps/web/src/App.tsx", "packages/daemon/src/index.ts", ...negative,
    ]) assert.equal(selected(path), false, `must not select ${path}`);
  });
}
