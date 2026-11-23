import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { classifyChangedFiles } from "./classify-scope.mjs";
import { deviceSuiteFiles } from "./device-test-profile.mjs";

type ScopeInput = Parameters<typeof classifyChangedFiles>[0];
type PackageEntry = NonNullable<ScopeInput["packageEntries"]>[number];
const packageEntries: PackageEntry[] = [
  entry("@ling-stack/contracts", "packages/contracts", [], true, true),
  entry("@ling-stack/plugin-sdk", "packages/plugin-sdk", [], true, true),
  entry("@ling-stack/core", "packages/core", ["@ling-stack/contracts", "@ling-stack/plugin-sdk"], true, true),
  entry("@ling-stack/providers", "packages/providers", ["@ling-stack/plugin-sdk"], true, true),
  entry("@ling-stack/runner-pi", "packages/runner-pi", ["@ling-stack/contracts"], true, true),
  entry("@ling-stack/daemon", "packages/daemon", ["@ling-stack/core", "@ling-stack/providers"], true, true),
  entry("@ling-stack/cli", "packages/cli", ["@ling-stack/daemon"], true, true),
  entry("@ling-stack/ui-react", "packages/ui-react", [], true, true),
  entry("@ling-stack/chrome-extension", "apps/chrome-extension", [], true, true),
  entry("@ling-stack/web", "apps/web", ["@ling-stack/core", "@ling-stack/ui-react"], true, true),
  entry("@ling-stack/localization", "packages/localization", [], true, false),
  entry("@ling-stack/desktop", "apps/desktop", ["@ling-stack/ui-react"], true, true),
  entry("@ling-stack/mobile", "apps/mobile", [], true, true),
];
const coreValidationBuildPackages = ["@ling-stack/core", "@ling-stack/daemon", "@ling-stack/runner-pi"];

function entry(name: string, directory: string, dependencies: string[], hasTestScript: boolean, hasTypecheckScript: boolean): PackageEntry {
  return { name, directory, dependencies, hasTestScript, hasTypecheckScript, scriptsFingerprint: "[]" };
}

function classify(files: string[], extra: Partial<ScopeInput> = {}) {
  return classifyChangedFiles({ files, packageEntries, basePackageEntries: packageEntries, ...extra });
}

test("documentation-only changes use the fast lane", () => {
  assert.equal(classify([
    "README.md", "README.en.md", "README.zh-CN.md", "README.sr-Latn.md", "README.es-419.md",
    "packages/core/README.md", "docs/assets/preview.png", "AGENTS.md",
  ]).mode, "docs");
});

test("repository presentation assets use the fast lane and compose with source edits", () => {
  const files = ["logo.png", "assets/diagram.svg", "images/preview.webp", "resources/demo.webm",
    "static/sans.woff2", ".github/assets/banner.avif", "output/qa/screenshot.png"];
  for (const file of files) {
    const scope = classify([file]);
    assert.equal(scope.mode, "docs", file);
    assert.deepEqual(scope.packages, [], file);
  }
  const mixed = classify([...files, "packages/providers/src/index.ts"]);
  assert.equal(mixed.mode, "affected");
  assert.deepEqual(mixed.packages, ["@ling-stack/cli", "@ling-stack/daemon", "@ling-stack/providers"]);
  assert.equal(classify(["assets/setup.mjs"]).mode, "full");
  assert.equal(classify([".github/assets/settings.yml"]).mode, "full");
});

test("package-owned image resources stay with their package without selecting the full lane", () => {
  const scope = classify(["packages/core/assets/provider-logo.png"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/cli", ...coreValidationBuildPackages]);
  assert.equal(scope.dependencyPolicy, false);
});

test("root and workspace localized READMEs accept BCP 47 language tags without accepting malformed names", () => {
  for (const file of [
    "README.en.md", "README.sr-Latn.md", "README.es-419.md", "README.zh-Hant-TW.md",
    "README.en-US-u-ca-gregory.md", "README.en-x-sample.md",
    "packages/core/README.zh-CN.md", "apps/desktop/README.en.md",
  ]) {
    assert.equal(classify([file]).mode, "docs", file);
  }
  for (const file of [
    "README.zh_CN.md", "README.中文.md", "README.1.md", "README.en.ts",
    "README.en-foo.md", "README.en-x.md", "README.en-US-u.md", "scripts/ci/README.en.md",
    "packages/unregistered/README.en.md",
  ]) {
    assert.equal(classify([file]).mode, "full", file);
  }
  assert.equal(classify(["packages/core/README.zh_CN.md"]).mode, "affected");
});

test("workspace docs classify Markdown without hiding runtime inputs or unknown paths", () => {
  const docs = ["packages/core/docs/reference/api.md", "apps/desktop/docs/start.md"];
  const documentation = classify(docs);
  assert.equal(documentation.mode, "docs");
  assert.deepEqual(documentation.packages, []);

  for (const file of ["packages/core/docs/example.mjs", "packages/core/docs/demo.mdx", "packages/core/src/docs/prompt.md"]) {
    const scope = classify([...docs, file]);
    assert.equal(scope.mode, "affected", file);
    assert.ok(scope.packages.includes("@ling-stack/core"), file);
  }
  assert.equal(classify([...docs, "packages/unregistered/docs/guide.md"]).mode, "full");
});

test("review templates and nested READMEs are documentation before broad infrastructure rules", () => {
  for (const file of ["scripts/ci/README.md", ".github/README.md", ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/PULL_REQUEST_TEMPLATE/bugfix.md", ".github/CODEOWNERS", ".github/FUNDING.yml"]) {
    const scope = classify([file]);
    assert.equal(scope.mode, "docs", file);
    assert.equal(scope.daemon, false, file);
    assert.equal(scope.macosNative, false, file);
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
  const scope = classify(["docs/ci.md", "README.zh-CN.md", "packages/providers/src/index.ts"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/cli", "@ling-stack/daemon", "@ling-stack/providers"]);
});

test("dependency, workflow, and CI script changes force full scope", () => {
  for (const file of ["package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml", "scripts/ci/new-check.mjs"]) {
    assert.equal(classify([file]).mode, "full", file);
  }
});

test("Web source changes select its non-Web validation consumers", () => {
  const scope = classify(["apps/web/src/App.tsx"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/localization"]);
  assert.equal(scope.daemon, false);
  assert.equal(scope.dependencyPolicy, false);
  assert.deepEqual(scope.testPackages, ["@ling-stack/localization"]);
  assert.deepEqual(scope.typecheckPackages, []);
});

test("package-local manifests and tooling configurations select their own consumers, not every package", () => {
  for (const file of ["apps/web/package.json", "apps/web/tsconfig.json", "apps/web/vite.config.ts",
    "apps/web/eslint.config.mjs"]) {
    const scope = classify([file]);
    assert.equal(scope.mode, "affected", file);
    assert.deepEqual(scope.packages, ["@ling-stack/localization"], file);
    assert.equal(scope.daemon, false, file);
    assert.equal(scope.dependencyPolicy, file.endsWith("package.json"), file);
  }
  const core = classify(["packages/core/package.json"]);
  assert.equal(core.mode, "affected");
  assert.deepEqual(core.packages, ["@ling-stack/cli", ...coreValidationBuildPackages]);
  assert.equal(core.daemon, true);
  assert.equal(core.dependencyPolicy, true);
  const desktop = classify(["apps/desktop/package.json"]);
  assert.deepEqual(desktop.packages, ["@ling-stack/desktop"]);
  assert.equal(desktop.daemon, false);
});

test("a new workspace module gets the same owner-only source scope after registration", () => {
  const moduleEntry = entry("@ling-stack/new-module", "packages/new-module", [], true, true);
  const entries = [...packageEntries, moduleEntry];
  const scope = classifyChangedFiles({
    files: ["packages/new-module/src/index.ts"],
    packageEntries: entries,
    basePackageEntries: entries,
  });
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/new-module"]);
  assert.deepEqual(scope.testPackages, ["@ling-stack/new-module"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/new-module"]);
  assert.equal(scope.daemon, false);
  assert.equal(scope.assurance, false);
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
  const changed = packageEntries.map((entry) => entry.name === "@ling-stack/cli" ? { ...entry, dependencies: [] } : entry);
  const scope = classify(["packages/core/src/index.ts", "docs/change.md"], { packageEntries: changed });
  assert.ok(scope.packages.includes("@ling-stack/cli"));
});

test("dependency regressions cannot be skipped with ordinary test-only scope", () => {
  for (const file of ["packages/daemon/test/dependency-security.test.mjs", "packages/daemon/test/dependency-security.test.ts",
    "apps/mobile/test/dependency-security-patches.test.mjs", "apps/mobile/test/dependency-security-patches.test.ts",
    "apps/mobile/test/dependency-security-tooling.test.mjs", "apps/mobile/test/dependency-security-tooling.test.ts"]) {
    assert.equal(classify([file]).dependencyPolicy, true, file);
  }
  assert.equal(classify(["packages/daemon/test/runtime-supervisor.test.mjs"]).dependencyPolicy, false);
});

test("mixed changes union all affected packages without disabling a dependency lane", () => {
  const scope = classify(["apps/web/package.json", "packages/daemon/test/runtime-supervisor.test.mjs", "scripts/ci/README.md"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/daemon", "@ling-stack/localization"]);
  assert.equal(scope.daemon, true);
  assert.equal(scope.dependencyPolicy, true);
});

test("core changes include daemon, CLI, and Web consumers", () => {
  const scope = classify(["packages/core/src/index.ts"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/cli", ...coreValidationBuildPackages]);
  assert.equal(scope.daemon, true);
});

test("Core test changes build cross-package fixtures and run only Core validation", () => {
  const scope = classify(["packages/core/test/provider-configuration-snapshot.test.ts"]);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, coreValidationBuildPackages);
  assert.deepEqual(scope.testPackages, ["@ling-stack/core"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/core"]);
  assert.equal(scope.assurance, false);
  assert.equal(scope.daemon, false);
  assert.deepEqual(scope.daemonPlatforms, []);
  assert.equal(scope.linuxContract, false);
  assert.equal(scope.macosNative, false);
});

test("daemon source changes include CLI but do not pull Web", () => {
  const scope = classify(["packages/daemon/src/index.ts"]);
  assert.deepEqual(scope.packages, ["@ling-stack/cli", "@ling-stack/daemon"]);
  assert.equal(scope.daemon, true);
  assert.deepEqual(scope.daemonPlatforms, ["linux", "darwin"]);
  assert.equal(scope.macosNative, false);
});

test("direct Daemon test changes use the assigned platform only", () => {
  const linux = classify(["packages/daemon/test/runtime-supervisor.test.mjs"]);
  assert.deepEqual(linux.daemonPlatforms, ["linux"]);
  const darwin = classify(["packages/daemon/test/macos-native-command.test.mjs"]);
  assert.deepEqual(darwin.daemonPlatforms, ["darwin"]);
  const mixed = classify(["packages/daemon/test/runtime-supervisor.test.mjs", "packages/daemon/test/macos-native-command.test.mjs"]);
  assert.deepEqual(mixed.daemonPlatforms, ["linux", "darwin"]);
});

test("Daemon source and shared validation inputs retain both platforms", () => {
  for (const files of [
    ["packages/daemon/src/index.ts", "packages/daemon/test/runtime-supervisor.test.mjs"],
    ["packages/daemon/test/runtime-supervisor.test.mjs", "packages/daemon/test/test-support/sqlite-workspace-fixture.ts"],
    ["packages/daemon/test/fixtures/shared-fixture.mjs"],
  ]) {
    const scope = classify(files);
    assert.deepEqual(scope.daemonPlatforms, ["linux", "darwin"], files.join(", "));
  }
});

test("macOS helper smoke follows explicit native surface paths", () => {
  for (const file of [
    "apps/desktop/native/locked-use/Sources/Broker/BrokerMain.swift",
    "apps/desktop/scripts/build-locked-use.ts",
    "native/sandbox/src/main.rs",
    "native/sandbox/tests/channel-command-smoke.mjs",
    "packages/daemon/src/runtime/sandbox/macos-sandbox-backend.ts",
    "packages/daemon/src/runtime/adapters/native-command-policy.ts",
    "packages/daemon/src/features/runs/restricted-command-dispatch.ts",
    "packages/daemon/test/platform-native-sandbox.test.mjs",
    "packages/daemon/test/restricted-command-launch-unknown.contract.mjs",
  ]) {
    const scope = classify([file]);
    assert.equal(scope.mode, "affected", file);
    assert.equal(scope.daemon, true, file);
    assert.equal(scope.macosNative, true, file);
    assert.ok(scope.packages.includes("@ling-stack/daemon"), file);
  }
  assert.equal(classify(["native/unknown.rs"]).mode, "full");
});

test("README changes under a native surface are documentation", () => {
  const readme = "apps/desktop/native/locked-use/README.md";
  const documentation = classify([readme]);
  assert.equal(documentation.mode, "docs");
  assert.equal(documentation.macosNative, false);
  assert.equal(documentation.macosHelper, false);

  const mobile = classify([readme, "apps/mobile/src/App.tsx"]);
  assert.deepEqual(mobile.packages, ["@ling-stack/mobile"]);
  assert.equal(mobile.daemon, false);
  assert.equal(mobile.macosNative, false);
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
  assert.deepEqual(scope.daemonPlatforms, ["linux"]);
  assert.equal(scope.macosNative, false);
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

function repositoryFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-ci-scope-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (file: string, contents: string) => {
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
  copyFileSync(new URL("./dependency-security.mjs", import.meta.url), join(root, "scripts/ci/dependency-security.mjs"));
  copyFileSync(new URL("./device-test-profile.mjs", import.meta.url), join(root, "scripts/ci/device-test-profile.mjs"));
  copyFileSync(new URL("./product-version-scope.mjs", import.meta.url), join(root, "scripts/ci/product-version-scope.mjs"));
  copyFileSync(new URL("./secret-scan.mjs", import.meta.url), join(root, "scripts/ci/secret-scan.mjs"));
  copyFileSync(new URL("./workflow-scope.mjs", import.meta.url), join(root, "scripts/ci/workflow-scope.mjs"));
  mkdirSync(join(root, "scripts/release"), { recursive: true });
  copyFileSync(new URL("../release/desktop-release.mjs", import.meta.url), join(root, "scripts/release/desktop-release.mjs"));
  copyFileSync(new URL("./package-validation-scope.mjs", import.meta.url), join(root, "scripts/ci/package-validation-scope.mjs"));
  for (const entry of packageEntries) {
    write(`${entry.directory}/package.json`, JSON.stringify({
      name: entry.name, dependencies: Object.fromEntries(entry.dependencies.map((name) => [name, "workspace:*"])),
      scripts: { ...(entry.hasTestScript ? { test: "node --test" } : {}), ...(entry.hasTypecheckScript ? { typecheck: "tsc" } : {}) },
    }));
  }
  const commit = () => { git("add", "."); git("commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  const classify = (base: string, ...options: string[]): ReturnType<typeof classifyChangedFiles> => JSON.parse(execFileSync(process.execPath, [script,
    "--event=pull_request", `--base=${base}`, "--head=HEAD", ...options], { encoding: "utf8" }));
  return { root, git, write, commit, classify };
}

test("shared Device recovery changes keep consumer builds and typechecks and run focused Core and Linux tests", t => {
  const repo = repositoryFixture(t);
  for (const file of ["test-shard-plan.mjs", "daemon-test-platforms.mjs"]) {
    copyFileSync(new URL(`./${file}`, import.meta.url), join(repo.root, "scripts/ci", file));
  }
  const unrelatedCore = "test/runtime-host-capacity-migration.test.ts";
  const unrelatedDaemon = "test/engine-lifecycle.test.mjs";
  for (const file of [...deviceSuiteFiles.core, unrelatedCore]) repo.write(`packages/core/${file}`, "export {};\n");
  for (const file of [...deviceSuiteFiles["daemon-linux"], unrelatedDaemon]) repo.write(`packages/daemon/${file}`, "export {};\n");
  repo.write("scripts/ci/daemon-test-platforms.json", JSON.stringify({
    version: 1, linux: deviceSuiteFiles["daemon-linux"], darwin: [unrelatedDaemon],
  }));
  repo.write("packages/contracts/test/device.test.ts", "export {};\n");
  repo.write("apps/mobile/test/standalone-device-runtime.test.ts", "export {};\n");
  for (const [name, dependency] of [["remote-protocol", "contracts"], ["remote-client", "remote-protocol"]]) {
    repo.write(`packages/${name}/package.json`, JSON.stringify({
      name: `@ling-stack/${name}`, dependencies: { [`@ling-stack/${dependency}`]: "workspace:*" },
      scripts: { test: "node --test", typecheck: "tsc" },
    }));
  }
  const base = repo.commit();
  for (const file of ["packages/contracts/src/device.ts", "packages/contracts/src/device-fabric.ts",
    "packages/core/src/device-task-trace.ts", "apps/mobile/src/device/execution.ts"]) {
    repo.write(file, "export const device = true;\n");
  }
  repo.write("docs/device.md", "# Device\n");
  repo.commit();

  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.equal(scope.testProfile, "device");
  assert.deepEqual(scope.testPackages, ["@ling-stack/contracts", "@ling-stack/core", "@ling-stack/daemon", "@ling-stack/mobile",
    "@ling-stack/remote-client", "@ling-stack/remote-protocol"]);
  assert.deepEqual(scope.daemonPlatforms, ["linux"]);
  assert.equal(scope.linuxContract, true);
  assert.equal(scope.assurance, true);
  assert.equal(scope.macosNative, false);
  assert.ok(scope.packages.includes("@ling-stack/cli"));
  assert.ok(scope.typecheckPackages.includes("@ling-stack/cli"));
  assert.ok(scope.typecheckPackages.includes("@ling-stack/runner-pi"));

  repo.write(".git/scope.json", JSON.stringify(scope));
  execFileSync(process.execPath, ["scripts/ci/test-shard-plan.mjs", "--scope=.git/scope.json", "--output=.git/plan.json"], { cwd: repo.root });
  const plan = JSON.parse(readFileSync(join(repo.root, ".git/plan.json"), "utf8"));
  assert.equal(plan.testProfile, "device");
  assert.deepEqual(Object.keys(plan.suites), ["core", "daemon-linux"]);
  assert.deepEqual(plan.suites.core.files, [...deviceSuiteFiles.core].sort());
  assert.deepEqual(plan.suites["daemon-linux"].files, [...deviceSuiteFiles["daemon-linux"]].sort());
  assert.equal(plan.suites.core.shards.length, 1);
  assert.equal(plan.daemonMatrix.include.length, 1);
  assert.equal(plan.daemonMatrix.include[0].runner, "ubuntu-latest");

  const missing = "packages/daemon/test/device-support-runtime.test.ts";
  rmSync(join(repo.root, missing));
  const fallback = repo.classify(base);
  assert.equal(fallback.testProfile, undefined);
  assert.deepEqual(fallback.daemonPlatforms, ["linux", "darwin"]);
  repo.git("restore", "--", missing);

  const full = repo.classify(base, "--force-full=true");
  assert.equal(full.mode, "full");
  assert.equal(full.testProfile, undefined);
  assert.deepEqual(full.daemonPlatforms, ["linux", "darwin"]);

  repo.write("packages/core/src/index.ts", "export {};\n");
  repo.commit();
  const mixed = repo.classify(base);
  assert.equal(mixed.testProfile, undefined);
  assert.ok(mixed.testPackages.includes("@ling-stack/cli"));
  assert.deepEqual(mixed.daemonPlatforms, ["linux", "darwin"]);
  assert.deepEqual(mixed.packages, scope.packages);
  assert.deepEqual(mixed.typecheckPackages, scope.typecheckPackages);
});

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

test("only a verified documentation history can skip the common job and merge gate runner", t => {
  const repo = repositoryFixture(t);
  repo.write("README.zh-CN.md", "# Ling\n");
  const base = repo.commit();

  repo.write("README.zh-CN.md", "# Ling Stack\n");
  repo.commit();
  repo.write("packages/core/README.zh-CN.md", "# Core\n");
  repo.write("apps/desktop/docs/guide.md", "# Guide\n");
  repo.commit();
  assert.equal(repo.classify(base).documentationOnly, true);

  repo.write("packages/core/src/temporary.ts", "export {};\n");
  repo.commit();
  repo.git("rm", "packages/core/src/temporary.ts");
  repo.commit();
  const reverted = repo.classify(base);
  assert.equal(reverted.mode, "docs");
  assert.equal(reverted.documentationOnly, false);
});

test("catalog App SHA updates select Common and retain the full fallback for workflow changes", t => {
  const repo = repositoryFixture(t);
  const first = ".github/workflows/sync-translation-catalogs.yml";
  const second = ".github/workflows/translate-pr-catalogs.yml";
  const baseline = new Map([first, second].map(file => [file, readFileSync(new URL("../../" + file, import.meta.url), "utf8")]));
  const update = (source: string) => source.replace(/(uses: actions\/create-github-app-token@)[a-f0-9]{40}(?: # v\d+\.\d+\.\d+)?/u,
    (_, prefix) => prefix + "3".repeat(40) + " # v3.99.0");
  for (const [file, source] of baseline) repo.write(file, source);
  const base = repo.commit();
  for (const [file, source] of baseline) repo.write(file, update(source));
  repo.commit();

  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.equal(scope.documentationOnly, undefined);
  assert.deepEqual(scope.files, [first, second]);
  assert.deepEqual(scope.packages, []);
  assert.deepEqual(scope.testPackages, []);
  assert.deepEqual(scope.typecheckPackages, []);
  assert.deepEqual(scope.daemonPlatforms, []);
  assert.equal(scope.dependencyPolicy, false);
  assert.equal(scope.assurance, false);
  assert.equal(scope.macosNative, false);
  assert.match(scope.reason, /catalog App action pin update/u);
  assert.equal(repo.classify(base, "--force-full=true").mode, "full");
  assert.equal(classify([first, second]).mode, "full");

  const pinUpdate = repo.git("rev-parse", "HEAD");
  const updated = update(baseline.get(second)!);
  for (const different of [
    updated.replace("permission-contents: write", "permission-contents: read"),
    updated.replace("contents: read", "contents: write"),
    updated.replace("pull_request:", "pull_request_target:"),
    updated.replace("actions/create-github-app-token@", "fork/create-github-app-token@"),
    updated.replace(/3{40} # v3\.99\.0/u, "v3"),
    baseline.get(second)!.replace(/# v\d+\.\d+\.\d+/u, "# v3.99.0"),
  ]) {
    repo.write(second, different);
    repo.commit();
    assert.equal(repo.classify(base).mode, "full");
  }

  repo.write(second, updated);
  repo.write("packages/core/src/probe.ts", "export {};\n");
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");

  repo.git("rm", "--", "packages/core/src/probe.ts", second);
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");
  assert.equal(repo.classify(pinUpdate).mode, "full");
});

test("new standard workspace packages select their own CI even with an isolated lock importer", t => {
  const repo = repositoryFixture(t);
  const directory = "packages/new-module";
  const before = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\n  example@1.0.0: {}\n";
  repo.write("pnpm-lock.yaml", before);
  const base = repo.commit();
  const manifest = { name: "@ling-stack/new-module", type: "module", scripts: {
    build: "tsc -p tsconfig.json",
    "build:ci": "tsc -p tsconfig.json",
    typecheck: "corepack pnpm build && corepack pnpm typecheck:ci",
    "typecheck:ci": "tsc -p tsconfig.json --noEmit && corepack pnpm run typecheck:tests",
    "typecheck:tests": "tsc -p tsconfig.test.json --noEmit",
    test: "corepack pnpm typecheck && corepack pnpm test:ci",
    "test:ci": "node --test test/*.test.ts",
  } };
  repo.write(`${directory}/package.json`, JSON.stringify(manifest));
  repo.write(`${directory}/src/index.ts`, "export const probe = true;\n");
  repo.write(`${directory}/tsconfig.json`, JSON.stringify({
    compilerOptions: { outDir: "dist" }, include: ["src/**/*.ts"],
  }));
  repo.write(`${directory}/tsconfig.test.json`, JSON.stringify({
    compilerOptions: { noEmit: true }, include: ["test/**/*.ts"],
  }));
  repo.write(`${directory}/test/probe.test.ts`, "import test from 'node:test'; test('probe', () => {});\n");
  const after = before.replace("\n\npackages:\n", "\n\n  packages/new-module: {}\n\npackages:\n");
  repo.write("pnpm-lock.yaml", after);
  repo.commit();

  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/new-module"]);
  assert.deepEqual(scope.testPackages, scope.packages);
  assert.deepEqual(scope.typecheckPackages, scope.packages);
  assert.equal(scope.dependencyPolicy, true);
  assert.equal(scope.daemon, false);
  assert.equal(scope.assurance, false);

  for (const lockfile of [after.replace("example@1.0.0", "example@2.0.0"), after.replace("  .: {}", "  .:\n    dependencies: {}"),
    after.replace("  packages/new-module: {}", "  packages/new-module: {}\n\n  packages/new-module: {}")]) {
    repo.write("pnpm-lock.yaml", lockfile);
    repo.commit();
    assert.equal(repo.classify(base).mode, "full");
  }
  repo.write("pnpm-lock.yaml", after);
  manifest.scripts["test:ci"] = "node --test --test-name-pattern=probe test/*.test.ts";
  repo.write(`${directory}/package.json`, JSON.stringify(manifest));
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");
});

test("verified local output deletions keep the changed paths and use the fast lane", t => {
  const repo = repositoryFixture(t);
  const report = "output/qa/result.json";
  const script = "output/qa/capture.mjs";
  const scriptSource = "export const capture = true;\n";
  repo.write(report, "{}");
  repo.write(script, scriptSource);
  const base = repo.commit();
  repo.git("rm", report, script);
  repo.commit();
  const scope = repo.classify(base);
  assert.equal(scope.mode, "docs");
  assert.deepEqual(scope.files, [script, report]);
  assert.deepEqual(scope.packages, []);
  assert.equal(scope.assurance, false);
  assert.match(scope.reason, /local artifact cleanup/u);
  assert.equal(classify([report]).mode, "full");
  assert.equal(classify([report], { deletedLocalArtifacts: [report], forceFull: true }).mode, "full");

  repo.write("packages/providers/src/capture.mjs", scriptSource);
  repo.commit();
  const moved = repo.classify(base);
  assert.equal(moved.mode, "affected");
  assert.deepEqual(moved.packages, ["@ling-stack/cli", "@ling-stack/daemon", "@ling-stack/providers"]);
  assert.deepEqual(moved.daemonPlatforms, ["linux", "darwin"]);
});

test("local output additions and modifications retain full regression", t => {
  const repo = repositoryFixture(t);
  const report = "output/qa/result.json";
  const notes = "output/qa/README.md";
  repo.write(report, "{}");
  const base = repo.commit();
  repo.write(report, '{"updated":true}');
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");

  repo.git("rm", report);
  repo.write(notes, "# QA notes\n");
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");
});

test("a Git-verified Codex environment deletion with native docs selects only common checks", t => {
  const repo = repositoryFixture(t);
  const environment = ".codex/environments/environment.toml";
  const otherConfig = ".codex/environments/other.toml";
  const readme = "apps/desktop/native/locked-use/README.md";
  repo.write(environment, 'name = "Local checks"\n');
  repo.write(otherConfig, 'name = "Other checks"\n');
  repo.write(readme, "# Local checks\n");
  const base = repo.commit();

  repo.write(environment, 'name = "Updated checks"\n');
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");

  repo.git("rm", environment);
  repo.write(readme, "# Run checks from the terminal\n");
  const cleanup = repo.commit();
  const scope = repo.classify(base);
  assert.equal(scope.mode, "docs");
  assert.notEqual(scope.documentationOnly, true);
  assert.deepEqual(scope.files, [environment, readme]);
  assert.deepEqual(scope.packages, []);
  assert.deepEqual(scope.testPackages, []);
  assert.deepEqual(scope.typecheckPackages, []);
  assert.equal(scope.daemon, false);
  assert.equal(scope.macosNative, false);
  assert.equal(scope.macosHelper, false);
  assert.equal(repo.classify(base, "--force-full=true").mode, "full");
  assert.equal(classify([environment]).mode, "full");

  repo.git("rm", otherConfig);
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");

  repo.write(environment, 'name = "Local checks"\n');
  repo.write(otherConfig, 'name = "Other checks"\n');
  repo.commit();
  assert.equal(repo.classify(cleanup).mode, "full");
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

test("the real package graph keeps Web's CLI and catalog consumers without building or testing Web", () => {
  const scope = classifyChangedFiles({ files: ["apps/web/tsconfig.json"] });
  assert.equal(scope.mode, "affected");
  for (const name of ["@ling-stack/cli", "@ling-stack/localization"]) assert.ok(scope.packages.includes(name), name);
  assert.equal(scope.daemon, false);
  assert.ok(!scope.testPackages.includes("@ling-stack/core"));
});

test("bundled provider catalog edits retain their transitive consumers", () => {
  const scope = classify(["packages/core/src/provider-model-catalog.generated.ts"]);
  assert.equal(scope.mode, "affected");
  for (const name of ["@ling-stack/core", "@ling-stack/daemon", "@ling-stack/cli"]) assert.ok(scope.packages.includes(name), name);
  assert.equal(scope.daemon, true);
  assert.equal(scope.assurance, true);
});

test("a verified root version update selects non-Web consumers without Daemon or assurance", t => {
  const repo = repositoryFixture(t);
  const manifest = { name: "ling-stack", private: true, version: "1.2.3", scripts: { build: "node build.mjs" } };
  repo.write("VERSION", "1.2.3\n");
  repo.write("package.json", JSON.stringify(manifest));
  const base = repo.commit();
  repo.write("VERSION", "1.2.4\n");
  repo.write("package.json", JSON.stringify({ ...manifest, version: "1.2.4" }));
  repo.write("docs/release-notes.md", "# Release notes\n");
  repo.commit();
  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.equal(scope.productVersion, "1.2.4");
  assert.deepEqual(scope.packages, ["@ling-stack/localization"]);
  assert.equal(scope.dependencyPolicy, false);
  assert.equal(scope.assurance, false);
  assert.equal(scope.daemon, false);

  repo.write("packages/core/src/probe.ts", "export const probe = true;\n");
  repo.commit();
  const mixed = repo.classify(base);
  assert.equal(mixed.mode, "affected");
  assert.equal(mixed.daemon, true);
  assert.equal(mixed.linuxContract, true);
  assert.equal(mixed.assurance, true);
});

test("root version files narrow only with matching valid values and an otherwise unchanged manifest", t => {
  for (const variant of ["mismatch", "invalid", "scripts", "lockfile", "missing", "override"]) {
    const repo = repositoryFixture(t);
    const manifest = { name: "ling-stack", version: "1.2.3", scripts: { build: "node build.mjs" } };
    repo.write("VERSION", "1.2.3\n");
    repo.write("package.json", JSON.stringify(manifest));
    const base = repo.commit();
    const version = variant === "invalid" ? "1.2.4-alpha.01" : "1.2.4";
    repo.write("package.json", JSON.stringify({ ...manifest, version,
      ...(variant === "scripts" ? { scripts: { build: "node different.mjs" } } : {}),
      ...(variant === "override" ? { pnpm: { overrides: { foo: "1.2.3" } } } : {}) }));
    if (variant === "missing") repo.git("rm", "VERSION");
    else if (variant !== "mismatch") repo.write("VERSION", version + "\n");
    if (variant === "lockfile") repo.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    repo.commit();
    assert.equal(repo.classify(base).mode, "full", variant);
  }
});

function validationMigration(t: TestContext, options: {
  additionalTests?: string[];
  baselineConfig?: object;
  baselineTest?: string;
  baselineTypecheck?: string;
} = {}) {
  const { additionalTests = [], baselineConfig, baselineTest, baselineTypecheck } = options;
  const repo = repositoryFixture(t);
  const manifest = {
    name: "@ling-stack/core", type: "module",
    dependencies: { "@ling-stack/contracts": "workspace:*", "@ling-stack/plugin-sdk": "workspace:*" },
    scripts: {
      build: "corepack pnpm --filter @ling-stack/contracts build && tsc -p tsconfig.json",
      "build:ci": "tsc -p tsconfig.json",
      test: baselineTest ?? "corepack pnpm --filter @ling-stack/contracts build && tsc -p tsconfig.json && node --test test/*.test.mjs",
      "test:ci": "node --test test/*.test.mjs",
      typecheck: baselineTypecheck ?? "corepack pnpm --filter @ling-stack/contracts build && tsc -p tsconfig.json --noEmit",
      "typecheck:ci": "tsc -p tsconfig.json --noEmit",
    } as Record<string, string>,
  };
  const saveManifest = () => repo.write("packages/core/package.json", JSON.stringify(manifest));
  if (baselineConfig) {
    manifest.scripts["typecheck:ci"] = "tsc -p tsconfig.test.json";
    manifest.scripts.typecheck = "corepack pnpm build && corepack pnpm typecheck:ci";
    repo.write("packages/core/tsconfig.test.json", JSON.stringify(baselineConfig));
  }
  saveManifest();
  repo.write("packages/core/test/probe.test.mjs", "import test from 'node:test'; test('probe', () => {});\n");
  for (const file of additionalTests) repo.write(`packages/core/test/${file}`, "import test from 'node:test'; test('retained', () => {});\n");
  const base = repo.commit();
  repo.git("mv", "packages/core/test/probe.test.mjs", "packages/core/test/probe.test.ts");
  Object.assign(manifest.scripts, {
    "test:ci": "node --test test/*.test.ts",
    test: "corepack pnpm build && corepack pnpm test:ci",
    "typecheck:ci": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
    typecheck: "corepack pnpm build && corepack pnpm typecheck:ci",
  });
  repo.write("packages/core/tsconfig.test.json", JSON.stringify({
    extends: "./tsconfig.json", compilerOptions: { noEmit: true }, include: ["test/**/*.ts"],
  }));
  saveManifest();
  return { ...repo, base, manifest, saveManifest };
}

test("a verified Node/TypeScript test migration retains complete owner validation without production consumers", t => {
  const repo = validationMigration(t);
  repo.commit();
  const scope = repo.classify(repo.base);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, coreValidationBuildPackages);
  assert.deepEqual(scope.testPackages, ["@ling-stack/core"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/core"]);
  assert.equal(scope.dependencyPolicy, false);
  assert.equal(scope.assurance, false);
  assert.equal(scope.daemon, false);
  assert.match(scope.reason, /test/u);
});

test("validated build and typecheck wrappers preserve package-only migration scope", t => {
  const repo = validationMigration(t, {
    baselineTest: "corepack pnpm run build && node --test test/*.test.mjs",
  });
  repo.manifest.scripts.test = "corepack pnpm typecheck && corepack pnpm test:ci";
  repo.saveManifest();
  repo.commit();
  const scope = repo.classify(repo.base);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, coreValidationBuildPackages);
  assert.deepEqual(scope.testPackages, ["@ling-stack/core"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/core"]);
  assert.equal(scope.dependencyPolicy, false);
  assert.equal(scope.assurance, false);
  assert.equal(scope.daemon, false);
});

test("CLI migrations accept verified dependency builds and the package build check", t => {
  const repo = repositoryFixture(t);
  const root = "packages/cli";
  const manifest = {
    name: "@ling-stack/cli", type: "module",
    dependencies: {
      "@ling-stack/browser-host": "workspace:*", "@ling-stack/contracts": "workspace:*",
      "@ling-stack/core": "workspace:*", "@ling-stack/daemon": "workspace:*",
    },
    scripts: {
      build: "corepack pnpm --filter @ling-stack/browser-host build && tsc -p tsconfig.json",
      "build:ci": "tsc -p tsconfig.json",
      typecheck: "corepack pnpm --filter @ling-stack/browser-host build && tsc -p tsconfig.json --noEmit",
      "typecheck:ci": "tsc -p tsconfig.json --noEmit",
      test: "corepack pnpm --filter @ling-stack/core build && corepack pnpm --filter @ling-stack/browser-host build && corepack pnpm --filter @ling-stack/daemon build && tsc -p tsconfig.json && node --test test/*.test.mjs",
      "test:ci": "node --test test/*.test.mjs",
    } as Record<string, string>,
  };
  const saveManifest = () => repo.write(`${root}/package.json`, JSON.stringify(manifest));
  saveManifest();
  repo.write(`${root}/test/probe.test.mjs`, "import test from 'node:test'; test('probe', () => {});\n");
  const base = repo.commit();

  repo.git("mv", `${root}/test/probe.test.mjs`, `${root}/test/probe.test.ts`);
  Object.assign(manifest.scripts, {
    "typecheck:ci": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
    typecheck: "corepack pnpm --filter @ling-stack/daemon... run build:ci && corepack pnpm build:ci && corepack pnpm typecheck:ci",
    test: "corepack pnpm --filter @ling-stack/core build && corepack pnpm --filter @ling-stack/browser-host build && corepack pnpm --filter @ling-stack/daemon build && tsc -p tsconfig.json && corepack pnpm test:ci",
    "test:ci": "node --test test/*.test.ts",
  });
  repo.write(`${root}/tsconfig.test.json`, JSON.stringify({ compilerOptions: { noEmit: true }, include: ["test/**/*.ts"] }));
  saveManifest();
  repo.commit();

  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/cli"]);
  assert.deepEqual(scope.testPackages, ["@ling-stack/cli"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/cli"]);
  assert.equal(scope.dependencyPolicy, false);
  assert.equal(scope.assurance, false);
  assert.equal(scope.daemon, false);
});

test("Browser Host test migration builds Daemon for the shared broker fixture", t => {
  const repo = repositoryFixture(t);
  const host = "packages/browser-host";
  const fixture = "packages/daemon/test/support/a01-browser-descriptor-fixture";
  const manifest = { name: "@ling-stack/browser-host", type: "module",
    dependencies: { "@ling-stack/contracts": "workspace:*" }, scripts: {
      build: "corepack pnpm --filter @ling-stack/contracts build && tsc -p tsconfig.json",
      "build:ci": "tsc -p tsconfig.json",
      test: "corepack pnpm build && node scripts/test.mjs",
      "test:ci": "node scripts/test.mjs",
      typecheck: "corepack pnpm --filter @ling-stack/contracts build && tsc -p tsconfig.json --noEmit",
      "typecheck:ci": "tsc -p tsconfig.json --noEmit",
    } };
  const writeManifest = () => repo.write(host + "/package.json", JSON.stringify(manifest));
  writeManifest();
  repo.write(host + "/scripts/test.mjs", "export {};\n");
  repo.write(host + "/test/broker.test.mjs", "import '../../daemon/test/support/a01-browser-descriptor-fixture.mjs';\n");
  repo.write(fixture + ".mjs", "export {};\n");
  const base = repo.commit();

  repo.git("mv", host + "/test/broker.test.mjs", host + "/test/broker.test.ts");
  repo.write(host + "/scripts/test.d.mts", "export {};\n");
  repo.write(host + "/tsconfig.test.json", JSON.stringify({ compilerOptions: { noEmit: true }, include: ["test/**/*.ts"] }));
  manifest.scripts.typecheck = "corepack pnpm --filter @ling-stack/daemon... run build:ci && corepack pnpm typecheck:ci";
  manifest.scripts["typecheck:ci"] = "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json";
  manifest.scripts.test = "corepack pnpm typecheck && corepack pnpm test:ci";
  writeManifest();
  repo.commit();

  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/browser-host", "@ling-stack/daemon"]);
  assert.deepEqual(scope.testPackages, ["@ling-stack/browser-host"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/browser-host"]);
  assert.equal(scope.daemon, false);
  assert.equal(scope.assurance, false);
  assert.equal(scope.dependencyPolicy, false);

  repo.write(fixture + ".d.mts", "export {};\n");
  repo.commit();
  assert.deepEqual(repo.classify(base).testPackages, ["@ling-stack/browser-host", "@ling-stack/daemon"]);

  manifest.scripts.typecheck = manifest.scripts.typecheck.replace("@ling-stack/daemon", "@ling-stack/mobile");
  writeManifest();
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");
});

test("Localization test migrations retain catalog checks and scope private declarations to the package", t => {
  const repo = repositoryFixture(t);
  const root = "packages/localization";
  const audit = "node scripts/check-catalogs.mjs && ";
  const compile = "node scripts/compile-catalogs.mjs && ";
  const manifest = { name: "@ling-stack/localization", type: "module", scripts: {
    build: compile + "tsc -p tsconfig.json",
    "test:ci": audit + "node --test test/*.test.mjs",
    "typecheck:ci": compile + "tsc -p tsconfig.json --noEmit",
    test: audit + compile + "tsc -p tsconfig.json && node --test test/*.test.mjs",
    typecheck: compile + "tsc -p tsconfig.json --noEmit",
  } };
  const saveManifest = () => repo.write(`${root}/package.json`, JSON.stringify(manifest));
  const runtime = "export const probe = true;\n";
  saveManifest();
  repo.write(`${root}/scripts/catalog-utils.mjs`, runtime);
  repo.write(`${root}/test/probe.test.mjs`, "import { probe } from '../scripts/catalog-utils.mjs'; void probe;\n");
  const base = repo.commit();

  repo.git("mv", `${root}/test/probe.test.mjs`, `${root}/test/probe.test.ts`);
  Object.assign(manifest.scripts, {
    "test:ci": audit + "node --test test/*.test.ts",
    "typecheck:ci": compile + "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
    test: "corepack pnpm typecheck && corepack pnpm test:ci",
    typecheck: "corepack pnpm build && corepack pnpm typecheck:ci",
  });
  saveManifest();
  repo.write(`${root}/scripts/catalog-utils.d.mts`, "export declare const probe: boolean;\n");
  repo.write(`${root}/tsconfig.test.json`, JSON.stringify({
    compilerOptions: { noEmit: true }, include: ["test/**/*.ts"],
  }));
  repo.commit();
  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/localization"]);
  assert.deepEqual(scope.testPackages, ["@ling-stack/localization"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/localization"]);
  assert.equal(scope.dependencyPolicy, false);
  assert.equal(scope.assurance, false);
  assert.deepEqual(scope.daemonPlatforms, []);

  repo.write(`${root}/scripts/catalog-utils.mjs`, "export const probe = false;\n");
  repo.commit();
  assert.equal(repo.classify(base).assurance, true);

  repo.write(`${root}/scripts/catalog-utils.mjs`, runtime);
  manifest.scripts["test:ci"] = "node --test test/*.test.ts";
  saveManifest();
  repo.commit();
  assert.equal(repo.classify(base).mode, "full");
});

test("UI React migrations accept the existing strip-types runner and test typecheck wrapper", t => {
  const repo = repositoryFixture(t);
  const root = "packages/ui-react";
  const manifest = {
    name: "@ling-stack/ui-react", type: "module",
    scripts: {
      build: "tsc -p tsconfig.json",
      "build:ci": "tsc -p tsconfig.json",
      "typecheck:ci": "tsc -p tsconfig.json --noEmit && corepack pnpm typecheck:tests",
      "typecheck:tests": "tsc -p tsconfig.test.json",
      typecheck: "tsc -p tsconfig.json --noEmit && corepack pnpm typecheck:tests",
      test: "corepack pnpm build && node --experimental-strip-types --test test/*.test.mjs test/*.test.ts",
      "test:ci": "node --experimental-strip-types --test test/*.test.mjs test/*.test.ts",
    },
  };
  repo.write(`${root}/package.json`, JSON.stringify(manifest));
  repo.write(`${root}/tsconfig.test.json`, JSON.stringify({
    compilerOptions: { noEmit: true }, include: ["test/**/*.ts"],
  }));
  repo.write(`${root}/test/probe.test.mjs`, "import test from 'node:test'; test('probe', () => {});\n");
  const base = repo.commit();

  repo.git("mv", `${root}/test/probe.test.mjs`, `${root}/test/probe.test.ts`);
  Object.assign(manifest.scripts, {
    "test:ci": "node --test test/*.test.ts",
    typecheck: "corepack pnpm build && corepack pnpm typecheck:ci",
    test: "corepack pnpm typecheck && corepack pnpm test:ci",
  });
  repo.write(`${root}/package.json`, JSON.stringify(manifest));
  repo.commit();
  const scope = repo.classify(base);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.packages, ["@ling-stack/ui-react"]);
  assert.deepEqual(scope.testPackages, ["@ling-stack/ui-react"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/ui-react"]);
  assert.equal(scope.dependencyPolicy, false);
  assert.equal(scope.assurance, false);
  assert.equal(scope.daemon, false);
});

test("workspace dependency builds and the owning package build closure retain package-only validation", t => {
  const repo = validationMigration(t, {
    baselineTypecheck: "corepack pnpm --filter @ling-stack/plugin-sdk build && corepack pnpm --filter @ling-stack/contracts build && tsc -p tsconfig.json --noEmit",
  });
  repo.manifest.scripts.test = "corepack pnpm typecheck && corepack pnpm test:ci";
  for (const name of ["@ling-stack/core", "@ling-stack/contracts", "@ling-stack/daemon"]) {
    repo.manifest.scripts.typecheck = "corepack pnpm --filter " + name + "... run build:ci && corepack pnpm typecheck:ci";
    repo.saveManifest();
    repo.commit();
    const scope = repo.classify(repo.base);
    assert.equal(scope.mode, "affected");
    assert.deepEqual(scope.packages, coreValidationBuildPackages);
    assert.deepEqual(scope.testPackages, ["@ling-stack/core"]);
    assert.deepEqual(scope.typecheckPackages, ["@ling-stack/core"]);
    assert.equal(scope.dependencyPolicy, false);
    assert.equal(scope.assurance, false);
    assert.equal(scope.daemon, false);
  }
});

test("validation migrations cannot discard baseline test entrypoints", t => {
  for (const replacement of [undefined, "different.test.ts"]) {
    const repo = validationMigration(t, { additionalTests: ["retained.test.mjs"] });
    rmSync(join(repo.root, "packages/core/test/retained.test.mjs"));
    if (replacement) repo.write(`packages/core/test/${replacement}`, "import test from 'node:test'; test('different', () => {});\n");
    repo.commit();
    const scope = repo.classify(repo.base);
    assert.equal(scope.mode, "full", replacement ?? "deleted test");
    assert.equal(scope.daemon, true);
  }
});

test("validation migrations cannot reinterpret an existing TypeScript configuration", t => {
  for (const baselineConfig of [
    { compilerOptions: { noEmit: true }, include: ["src/**/*.ts", "test/**/*.ts"] },
    { compilerOptions: { noEmit: false }, include: ["test/**/*.ts"] },
    { compilerOptions: { noEmit: true }, include: ["test/**/*"] },
  ]) {
    const repo = validationMigration(t, { baselineConfig });
    repo.commit();
    const scope = repo.classify(repo.base);
    assert.equal(scope.mode, "full", JSON.stringify(baselineConfig));
    assert.equal(scope.daemon, true);
  }
});

test("validation migrations can reuse an unchanged isolated TypeScript configuration", t => {
  const baselineConfig = {
    extends: "./tsconfig.json", compilerOptions: { noEmit: true }, include: ["test/**/*"],
  };
  const repo = validationMigration(t, { baselineConfig });
  repo.write("packages/core/tsconfig.test.json", JSON.stringify(baselineConfig));
  repo.commit();
  const scope = repo.classify(repo.base);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.testPackages, ["@ling-stack/core"]);
  assert.deepEqual(scope.typecheckPackages, ["@ling-stack/core"]);
  assert.equal(scope.daemon, false);
});

test("isolated test config compiler options stay scoped with and without a test migration", t => {
  const baselineConfig = {
    extends: "./tsconfig.json",
    compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, target: "ES2022" },
    include: ["test/**/*.ts"],
  };
  for (const { migrating, options } of [
    { migrating: true, options: { target: "ES2024" } },
    { migrating: false, options: { allowImportingTsExtensions: true, lib: ["ES2022"] } },
  ]) {
    const repo = validationMigration(t, { baselineConfig });
    repo.write("packages/core/tsconfig.test.json", JSON.stringify(baselineConfig));
    const base = migrating ? repo.base : repo.commit();
    const change = { ...baselineConfig, compilerOptions: { ...baselineConfig.compilerOptions, ...options } };
    repo.write("packages/core/tsconfig.test.json", JSON.stringify(change));
    repo.commit();
    const scope = repo.classify(base);
    assert.equal(scope.mode, "affected");
    assert.deepEqual(scope.packages, coreValidationBuildPackages);
    assert.deepEqual(scope.testPackages, ["@ling-stack/core"]);
    assert.deepEqual(scope.typecheckPackages, ["@ling-stack/core"]);
    assert.equal(scope.dependencyPolicy, false);
    assert.equal(scope.assurance, false);
    assert.equal(scope.daemon, false);
  }
});

test("test config discovery and module boundaries retain broader validation", t => {
  const baselineConfig = {
    extends: "./tsconfig.json",
    compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, target: "ES2022" },
    include: ["test/**/*.ts"],
  };
  for (const change of [
    { ...baselineConfig, include: ["src/**/*.ts", "test/**/*.ts"] },
    { ...baselineConfig, files: ["test/probe.test.ts"] },
    { ...baselineConfig, exclude: ["test/probe.test.ts"] },
    { ...baselineConfig, references: [{ path: "../contracts" }] },
    { ...baselineConfig, extends: "./tsconfig.other.json" },
    { ...baselineConfig, compilerOptions: { ...baselineConfig.compilerOptions, moduleResolution: "Bundler" } },
    { ...baselineConfig, compilerOptions: { ...baselineConfig.compilerOptions, noEmit: false } },
  ]) {
    const repo = validationMigration(t, { baselineConfig });
    repo.write("packages/core/tsconfig.test.json", JSON.stringify(baselineConfig));
    const base = repo.commit();
    repo.write("packages/core/tsconfig.test.json", JSON.stringify(change));
    repo.commit();
    const scope = repo.classify(base);
    assert.equal(scope.reason, "workspace source change with transitive consumers", JSON.stringify(change));
    assert.ok(scope.testPackages.includes("@ling-stack/daemon"), JSON.stringify(change));
  }
});

test("an existing test config referenced from another workspace keeps its source scope", t => {
  const baselineConfig = { compilerOptions: { noEmit: true }, include: ["test/**/*.ts"] };
  const repo = validationMigration(t, { baselineConfig });
  repo.write("packages/core/tsconfig.test.json", JSON.stringify(baselineConfig));
  const consumerConfig = "packages/daemon/tsconfig.json";
  repo.write(consumerConfig, JSON.stringify({ extends: "../core/tsconfig.test" }));
  const base = repo.commit();
  repo.write("packages/core/tsconfig.test.json", JSON.stringify({
    ...baselineConfig, compilerOptions: { ...baselineConfig.compilerOptions, allowImportingTsExtensions: true },
  }));
  repo.commit();
  const scope = repo.classify(base);
  assert.equal(scope.reason, "workspace source change with transitive consumers");
  assert.ok(scope.testPackages.includes("@ling-stack/daemon"));

  repo.write(consumerConfig, JSON.stringify({ extends: "@ling-stack/core/tsconfig.test.json" }));
  const consumerBase = repo.commit();
  repo.write("packages/core/tsconfig.test.json", JSON.stringify(baselineConfig));
  repo.commit();
  assert.ok(repo.classify(consumerBase).testPackages.includes("@ling-stack/daemon"));
});

test("a validation migration mixed with source or production config still selects transitive consumers", t => {
  for (const file of ["packages/core/src/probe.ts", "packages/core/tsconfig.json"]) {
    const repo = validationMigration(t);
    repo.write(file, file.endsWith(".json") ? "{}" : "export const probe = true;\n");
    repo.commit();
    repo.write("docs/latest.md", "# Latest commit\n");
    repo.commit();
    const scope = repo.classify(repo.base);
    assert.equal(scope.mode, "affected", file);
    for (const name of ["@ling-stack/core", "@ling-stack/daemon", "@ling-stack/cli"]) {
      assert.ok(scope.packages.includes(name), `${file}: ${name}`);
    }
    assert.equal(scope.assurance, true);
  }
});

test("validation migrations retain shared test-support importers", t => {
  const repo = validationMigration(t);
  repo.write("packages/core/test/helpers.ts", "export const probe = true;\n");
  repo.write("packages/daemon/test/probe.test.ts", "import { probe } from '../../core/test/helpers.ts';\n");
  repo.commit();
  const scope = repo.classify(repo.base);
  assert.deepEqual(scope.testPackages, ["@ling-stack/core", "@ling-stack/daemon"]);
  assert.equal(scope.daemon, true);
  assert.deepEqual(scope.daemonPlatforms, ["linux", "darwin"]);
});

test("opaque commands, build hooks, metadata changes and incomplete test discovery retain full regression", t => {
  const mutations: ((repo: ReturnType<typeof validationMigration>) => void)[] = [
    repo => { repo.manifest.scripts["test:ci"] = "echo omitted"; },
    repo => { repo.manifest.scripts.typecheck = "echo omitted"; },
    repo => { repo.manifest.scripts.typecheck = "corepack pnpm --filter @ling-stack/daemon build && corepack pnpm typecheck:ci"; },
    repo => { repo.manifest.scripts.typecheck = "corepack pnpm --filter @ling-stack/mobile... run build:ci && corepack pnpm typecheck:ci"; },
    repo => {
      repo.manifest.scripts.test = "corepack pnpm typecheck && corepack pnpm test:ci";
      repo.manifest.scripts.typecheck = "corepack pnpm test && corepack pnpm typecheck:ci";
    },
    repo => { repo.manifest.scripts.test = "corepack pnpm typecheck && corepack pnpm test:ci && node ../../scripts/check.mjs"; },
    repo => {
      repo.manifest.scripts["typecheck:ci"] = "tsc -p tsconfig.json --noEmit";
      repo.manifest.scripts.typecheck = "corepack pnpm build && corepack pnpm typecheck:ci";
    },
    repo => { repo.manifest.scripts["test:ci"] = "node --test --test-name-pattern=probe test/*.test.ts"; },
    repo => { repo.manifest.scripts["test:ci"] += " && node ../../scripts/check.mjs"; },
    repo => { repo.manifest.scripts["build:ci"] = "echo omitted"; },
    repo => { repo.manifest.scripts.pretest = "node prepare.mjs"; },
    repo => { repo.manifest.scripts["typecheck:tests"] = "node prepare.mjs"; },
    repo => {
      repo.manifest.scripts["typecheck:ci"] = "tsc -p tsconfig.test.json";
      repo.manifest.scripts.typecheck = "corepack pnpm typecheck:ci";
    },
    repo => { delete repo.manifest.scripts["typecheck:ci"]; },
    repo => { repo.manifest.dependencies["@ling-stack/contracts"] = "workspace:^"; },
    repo => { repo.write("packages/core/test/retained.test.mjs", "// Retained test entry\n"); },
    repo => {
      rmSync(join(repo.root, "packages/core/test/probe.test.ts"));
      repo.write("packages/core/test/helpers.ts", "export {};\n");
    },
    repo => { repo.write("packages/core/tsconfig.test.json", JSON.stringify({ include: ["test/**/*.ts"] })); },
    repo => { repo.write("packages/core/tsconfig.test.json", JSON.stringify({ compilerOptions: { noEmit: true }, include: ["test/other.ts"] })); },
    repo => { repo.write("unknown/input.json", "{}"); },
  ];
  for (const mutate of mutations) {
    const repo = validationMigration(t);
    mutate(repo);
    repo.saveManifest();
    repo.commit();
    const scope = repo.classify(repo.base);
    assert.equal(scope.mode, "full", String(mutate));
    assert.equal(scope.daemon, true);
  }
});

test("a validation config covering source remains a production input", t => {
  const repo = validationMigration(t);
  repo.write("packages/core/tsconfig.test.json", JSON.stringify({ compilerOptions: { noEmit: true }, include: ["src/**/*.ts", "test/**/*.ts"] }));
  repo.commit();
  const scope = repo.classify(repo.base);
  assert.equal(scope.mode, "full");
  assert.equal(scope.daemon, true);
});

test("validation configs consumed by root or nested production configs retain full regression", t => {
  for (const [file, contents] of [
    ["tsconfig.prod.server.json", { extends: "./tsconfig.test" }],
    ["config/tsconfig.build.json", { extends: "../tsconfig.test.json" }],
    ["config/tsconfig.build.json", { references: [{ path: "../tsconfig.test" }] }],
  ] as const) {
    const repo = validationMigration(t);
    repo.write(`packages/core/${file}`, JSON.stringify(contents));
    repo.commit();
    const scope = repo.classify(repo.base);
    assert.equal(scope.mode, "full", file);
    assert.equal(scope.daemon, true);
  }
});
