import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  entry("@ling-stack/localization", "packages/localization", [], true, false),
  entry("@ling-stack/desktop", "apps/desktop", ["@ling-stack/ui-react"], true, true),
  entry("@ling-stack/mobile", "apps/mobile", [], true, true),
];

function entry(name, directory, dependencies, hasTestScript, hasTypecheckScript) {
  return { name, directory, dependencies, hasTestScript, hasTypecheckScript, scriptsFingerprint: "[]" };
}

function classify(files, extra = {}) {
  return classifyChangedFiles({ files, packageEntries, basePackageEntries: packageEntries, ...extra });
}

test("documentation-only changes use the fast lane", () => {
  assert.equal(classify(["README.md", "packages/core/README.md", "docs/assets/preview.png"]).mode, "docs");
});

test("review templates and nested READMEs are documentation before broad infrastructure rules", () => {
  for (const file of ["scripts/ci/README.md", ".github/README.md", ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/PULL_REQUEST_TEMPLATE/bugfix.md", ".github/CODEOWNERS", ".github/FUNDING.yml"]) {
    const scope = classify([file]);
    assert.equal(scope.mode, "docs", file);
    assert.equal(scope.daemon, false, file);
    assert.equal(scope.web, false, file);
    assert.equal(scope.dependencyPolicy, false, file);
  }
});

test("documentation exemptions cannot hide executable infrastructure or unknown roots", () => {
  for (const file of [".github/PULL_REQUEST_TEMPLATE/build.mjs", "scripts/ci/prompt.md", "VERSION",
    ".github/workflows/ci.yml", ".gitattributes", "tsconfig.json", "unknown/package.json"]) {
    const scope = classify(["scripts/ci/README.md", file]);
    assert.equal(scope.mode, "full", file);
    assert.equal(scope.dependencyPolicy, true, file);
  }
});

test("Issue templates and allowlisted maintenance checks need no product packages", () => {
  const maintenanceFiles = [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/nested/feature.md",
    "scripts/check-markdown-links.mjs",
    "scripts/check-public-repo-safety.mjs",
    "scripts/check-public-repo-safety.test.mjs",
  ];
  for (const files of maintenanceFiles.map((file) => [file]).concat([["docs/ci.md", ...maintenanceFiles]])) {
    const scope = classify(files);
    assert.equal(scope.mode, "docs", files.join(", "));
    assert.match(scope.reason, /maintenance/u);
    assert.deepEqual(scope.packages, []);
    assert.deepEqual(scope.testPackages, []);
    assert.deepEqual(scope.typecheckPackages, []);
    assert.equal(scope.daemon, false);
    assert.equal(scope.web, false);
  }
});

test("maintenance mixed with source retains affected consumers", () => {
  const scope = classify([
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    "scripts/check-public-repo-safety.test.mjs",
    "packages/providers/src/index.ts",
  ]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/cli", "@ling-stack/daemon", "@ling-stack/providers"]);
  assert.deepEqual(scope.testPackages, scope.packages);
  assert.equal(scope.daemon, true);
  assert.equal(scope.web, false);
});

test("maintenance exceptions do not weaken unknown paths or explicit full runs", () => {
  const maintenance = "scripts/check-markdown-links.mjs";
  for (const file of [
    ".github/ISSUE_TEMPLATES/bug_report.yml",
    ".github/workflows/ci.yml",
    "scripts/check-markdown-links.test.mjs",
    "scripts/check-public-repo-safety.mjs.backup",
    "scripts/ci/check-markdown-links.mjs",
    "scripts/ci/classify-scope.mjs",
    "scripts/ci/run-packages.mjs",
    "scripts/new-check.mjs",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "patches/dependency.patch",
    "native/unknown.rs",
  ]) {
    assert.equal(classify([maintenance, file]).mode, "full", file);
  }
  assert.equal(classify([maintenance], { forceFull: true }).mode, "full");
  assert.equal(classify([maintenance], { eventName: "schedule" }).mode, "full");
  assert.equal(classify([maintenance], { eventName: "workflow_dispatch" }).mode, "full");
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
  assert.deepEqual(scope.packages, ["@ling-stack/localization", "@ling-stack/web"]);
  assert.equal(scope.web, true);
  assert.equal(scope.daemon, false);
  assert.equal(scope.dependencyPolicy, false);
  assert.ok(scope.testPackages.includes("@ling-stack/web"));
});

test("package-local manifests and tooling configurations select their own consumers, not every package", () => {
  for (const file of ["apps/web/package.json", "apps/web/tsconfig.json", "apps/web/vite.config.ts",
    "apps/web/eslint.config.mjs"]) {
    const scope = classify([file]);
    assert.equal(scope.mode, "affected", file);
    assert.deepEqual(scope.packages, ["@ling-stack/localization", "@ling-stack/web"], file);
    assert.equal(scope.daemon, false, file);
    assert.equal(scope.dependencyPolicy, file.endsWith("package.json"), file);
  }
  const core = classify(["packages/core/package.json"]);
  assert.equal(core.mode, "affected");
  assert.deepEqual(core.packages, ["@ling-stack/cli", "@ling-stack/core", "@ling-stack/daemon", "@ling-stack/web"]);
  assert.equal(core.daemon, true);
  assert.equal(core.dependencyPolicy, true);
  const desktop = classify(["apps/desktop/package.json"]);
  assert.deepEqual(desktop.packages, ["@ling-stack/desktop"]);
  assert.equal(desktop.daemon, false);
});

test("package identity changes, removal, or an unavailable baseline keep the full lane", () => {
  const renamed = packageEntries.map((entry) => entry.directory === "packages/core" ? { ...entry, name: "@ling-stack/core-v2" } : entry);
  for (const extra of [{ basePackageEntries: undefined }, { packageEntries: renamed },
    { packageEntries: packageEntries.filter((entry) => entry.directory !== "packages/core") },
    { packageEntries: packageEntries.map((entry) => entry.directory === "packages/core" ? { ...entry, hasTestScript: false } : entry) }]) {
    assert.equal(classify(["packages/core/package.json"], extra).mode, "full");
  }
});

test("a missing or changed validation-script fingerprint cannot narrow manifest edits", () => {
  for (const scriptsFingerprint of [undefined, '[[]]']) {
    const changed = packageEntries.map((entry) => entry.name === "@ling-stack/core" ? { ...entry, scriptsFingerprint } : entry);
    assert.equal(classify(["packages/core/package.json"], { packageEntries: changed }).mode, "full");
  }
});

test("test-only consumers already selected cannot stop transitive source traversal", () => {
  const scope = classify(["packages/providers/src/index.ts", "packages/daemon/test/runtime-supervisor.test.mjs"]);
  assert.deepEqual(scope.packages, ["@ling-stack/cli", "@ling-stack/daemon", "@ling-stack/providers"]);
});

test("removed dependency edges cannot erase consumers from a multi-package PR", () => {
  const changed = packageEntries.map((entry) => entry.name === "@ling-stack/web" ? { ...entry, dependencies: [] } : entry);
  const scope = classify(["packages/core/src/index.ts", "apps/web/package.json"], { packageEntries: changed });
  assert.ok(scope.packages.includes("@ling-stack/web"));
  assert.ok(scope.packages.includes("@ling-stack/localization"));
});

test("dependency regressions cannot be skipped with ordinary test-only scope", () => {
  for (const file of ["packages/daemon/test/dependency-security.test.mjs",
    "apps/mobile/test/dependency-security-patches.test.mjs", "apps/mobile/test/dependency-security-tooling.test.mjs"]) {
    assert.equal(classify([file]).dependencyPolicy, true, file);
  }
  assert.equal(classify(["packages/daemon/test/runtime-supervisor.test.mjs"]).dependencyPolicy, false);
});

test("mixed changes union all affected packages without disabling a dependency lane", () => {
  const scope = classify(["apps/web/package.json", "packages/daemon/test/runtime-supervisor.test.mjs", "scripts/ci/README.md"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/daemon", "@ling-stack/localization", "@ling-stack/web"]);
  assert.equal(scope.daemon, true);
  assert.equal(scope.web, true);
  assert.equal(scope.dependencyPolicy, true);
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

function repositoryFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-ci-scope-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (file, contents) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  git("init", "--quiet");
  git("config", "user.name", "CI scope test");
  git("config", "user.email", "ci-scope@example.invalid");
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  const script = join(root, "scripts/ci/classify-scope.mjs");
  copyFileSync(new URL("./classify-scope.mjs", import.meta.url), script);
  for (const entry of packageEntries) {
    write(`${entry.directory}/package.json`, JSON.stringify({
      name: entry.name, dependencies: Object.fromEntries(entry.dependencies.map((name) => [name, "workspace:*"])),
      scripts: { ...(entry.hasTestScript ? { test: "node --test" } : {}), ...(entry.hasTypecheckScript ? { typecheck: "tsc" } : {}) },
    }));
  }
  const commit = () => { git("add", "."); git("commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  const classify = (base) => JSON.parse(execFileSync(process.execPath, [script,
    "--event=pull_request", `--base=${base}`, "--head=HEAD"], { encoding: "utf8" }));
  return { git, write, commit, classify };
}

test("the Git boundary retains the entire PR and both sides of source-to-doc renames", (t) => {
  const repo = repositoryFixture(t);
  repo.write("packages/core/src/probe.ts", "export const probe = true;\n");
  const base = repo.commit();
  repo.write("docs/placeholder.md", "# Placeholder\n");
  repo.git("mv", "packages/core/src/probe.ts", "docs/probe.ts");
  repo.commit();
  repo.write("docs/latest.md", "# Latest commit is documentation only\n");
  repo.commit();
  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.ok(scope.files.includes("packages/core/src/probe.ts"));
  assert.ok(scope.files.includes("docs/probe.ts"));
  assert.ok(scope.packages.includes("@ling-stack/core"));
  assert.ok(scope.packages.includes("@ling-stack/daemon"));
});

test("the Git boundary verifies old manifest identity before narrowing package edits", (t) => {
  const repo = repositoryFixture(t);
  const base = repo.commit();
  const manifest = { name: "@ling-stack/core", version: "1.2.3", scripts: { test: "node --test", typecheck: "tsc" } };
  repo.write("packages/core/package.json", JSON.stringify(manifest));
  repo.commit();
  const stable = repo.classify(base);
  assert.equal(stable.mode, "affected");
  assert.equal(stable.dependencyPolicy, true);
  assert.ok(stable.packages.includes("@ling-stack/daemon"));
  assert.ok(!stable.packages.includes("@ling-stack/mobile"));
  repo.write("packages/core/package.json", JSON.stringify({ ...manifest, name: "@ling-stack/core-v2" }));
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");
  repo.git("rm", "packages/core/package.json");
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");
});

test("the Git boundary compares validation script contents and CI entrypoints, not only their presence", (t) => {
  for (const scripts of [{ test: "node --test", typecheck: "tsc", "test:ci": "node --test" },
    { test: "echo omitted", typecheck: "tsc" }, { test: "node --test", typecheck: "echo omitted" }]) {
    const repo = repositoryFixture(t);
    const base = repo.commit();
    repo.write("packages/core/package.json", JSON.stringify({ name: "@ling-stack/core", scripts }));
    repo.commit();
    assert.equal(repo.classify(base).mode, "full", JSON.stringify(scripts));
  }
});

test("the real package graph keeps Web's CLI and catalog consumers without core or daemon shards", () => {
  const scope = classifyChangedFiles({ files: ["apps/web/tsconfig.json"] });
  assert.equal(scope.mode, "affected");
  for (const name of ["@ling-stack/web", "@ling-stack/cli", "@ling-stack/localization"]) assert.ok(scope.packages.includes(name), name);
  assert.equal(scope.daemon, false);
  assert.ok(!scope.testPackages.includes("@ling-stack/core"));
});
