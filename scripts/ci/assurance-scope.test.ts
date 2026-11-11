import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SDK_PACKAGES } from "../framework-assurance/sdk-consumer.mjs";
import { classifyChangedFiles } from "./classify-scope.mjs";
import { createTestPlan } from "./test-shard-plan.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const lanes = ["SCOPE", "COMMON", "DEPENDENCY", "ASSURANCE", "BUILD", "TYPECHECK", "UNIT", "DAEMON",
  "LINUX_CONTRACT", "MACOS_NATIVE", "WEB_SMOKE"];

function job(id: string) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "mu").exec(workflow);
  assert.ok(match, id);
  return match[1];
}

function outputTransform(scope: ReturnType<typeof classifyChangedFiles>) {
  const source = job("scope");
  const start = source.indexOf("          SCOPE_JSON=");
  const end = source.indexOf("          NODE\n", start);
  assert.ok(start >= 0 && end > start);
  const directory = mkdtempSync(join(tmpdir(), "ling-assurance-scope-"));
  const output = join(directory, "outputs");
  try {
    const command = source.slice(start, end + "          NODE\n".length).replace(/^ {10}/gmu, "");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", command], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, scope_json: JSON.stringify(scope), GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("offline assurance changes select their own lane without product builds or shards", async () => {
  for (const file of ["scripts/framework-assurance/index.mjs", "scripts/framework-assurance/offline.test.mjs",
    "fixtures/framework-assurance/suite.json", "fixtures/framework-assurance/execution-evidence/receipt.json"]) {
    const scope = classifyChangedFiles({ files: [file, "docs/architecture.md"] });
    assert.equal(scope.mode, "affected", file);
    assert.equal(scope.assurance, true, file);
    assert.deepEqual(scope.packages, []);
    assert.deepEqual(scope.testPackages, []);
    assert.deepEqual(scope.typecheckPackages, []);
    assert.equal(scope.daemon, false);
    assert.equal(scope.web, false);
    assert.equal(scope.dependencyPolicy, false);
    const plan = await createTestPlan(scope.testPackages);
    assert.deepEqual(plan.suites, {});
    assert.deepEqual(plan.unitMatrix.include, []);
    assert.deepEqual(plan.daemonMatrix.include, []);
  }
});

test("assurance follows its real SDK producers and Core grader inputs", () => {
  for (const name of [...SDK_PACKAGES, "@ling-stack/core"]) {
    const directory = `packages/${name.split("/")[1]}`;
    assert.equal(classifyChangedFiles({ files: [`${directory}/src/index.ts`] }).assurance, true, name);
    assert.equal(classifyChangedFiles({ files: [`${directory}/test/example.test.ts`] }).assurance, false, name);
  }
  for (const file of ["apps/web/src/App.tsx", "apps/mobile/src/App.tsx", "apps/desktop/src/main.ts",
    "packages/daemon/src/index.ts", "packages/providers/src/index.ts", "packages/runner-pi/src/index.ts"]) {
    const scope = classifyChangedFiles({ files: [file] });
    assert.equal(scope.mode, "affected", file);
    assert.equal(scope.assurance, false, file);
    assert.ok(scope.packages.length > 0, file);
  }
});

test("direct and transitive assurance imports retain package validation consumers", () => {
  for (const [file, packages] of [["scripts/framework-assurance/diagnostics.mjs", ["@ling-stack/api-client", "@ling-stack/daemon"]],
    ["scripts/framework-assurance/manifest.mjs", ["@ling-stack/api-client", "@ling-stack/daemon"]],
    ["scripts/framework-assurance/execution-evidence.mjs", ["@ling-stack/daemon"]],
    ["fixtures/framework-assurance/execution-evidence/valid.json", ["@ling-stack/daemon"]]] as const) {
    const scope = classifyChangedFiles({ files: [file] });
    assert.equal(scope.mode, "affected");
    assert.equal(scope.assurance, true);
    assert.deepEqual(scope.packages, packages);
    assert.deepEqual(scope.testPackages, packages);
    assert.deepEqual(scope.typecheckPackages, packages);
    assert.equal(scope.daemon, packages.some(name => name === "@ling-stack/daemon"));
    assert.equal(scope.web, false);
  }
});

test("mixed assurance and product edits preserve product checks and full-scope fallbacks", () => {
  const assurance = "scripts/framework-assurance/report.mjs";
  const web = classifyChangedFiles({ files: [assurance, "apps/web/src/App.tsx"] });
  assert.equal(web.mode, "affected");
  assert.equal(web.assurance, true);
  assert.equal(web.web, true);
  assert.ok(web.testPackages.includes("@ling-stack/web"));
  const daemon = classifyChangedFiles({ files: [assurance, "packages/daemon/src/index.ts"] });
  assert.equal(daemon.daemon, true);
  assert.equal(daemon.assurance, true);
  for (const file of ["pnpm-lock.yaml", "package.json", ".github/workflows/ci.yml", "scripts/ci/classify-scope.mjs",
    "scripts/framework-assurance-unknown/check.mjs", "fixtures/unknown.json", "native/unknown.rs"]) {
    const scope = classifyChangedFiles({ files: [assurance, file] });
    assert.equal(scope.mode, "full", file);
    assert.equal(scope.assurance, true, file);
    assert.equal(scope.daemon, true, file);
    assert.equal(scope.web, true, file);
  }
  for (const options of [{ eventName: "schedule" }, { eventName: "workflow_dispatch" }, { forceFull: true }]) {
    assert.equal(classifyChangedFiles({ files: [assurance], ...options }).mode, "full");
  }
});

test("workflow outputs and the real aggregate command require precisely the selected work", () => {
  const command = /^ {8}run: \|\n((?: {10}[^\n]*(?:\n|$)|\n)*)/mu.exec(job("quality"))?.[1];
  assert.ok(command);
  for (const files of [["scripts/framework-assurance/report.mjs"], ["packages/daemon/test/example.test.ts"],
    ["scripts/framework-assurance/report.mjs", "apps/web/test/example.test.ts"]]) {
    const scope = classifyChangedFiles({ files });
    const outputs = outputTransform(scope);
    assert.equal(outputs["assurance-selected"], String(scope.assurance));
    assert.equal(outputs["build-selected"], String(scope.packages.length > 0));
    const required = new Set(["SCOPE", "COMMON", ...(scope.assurance ? ["ASSURANCE"] : []),
      ...(scope.packages.length ? ["BUILD"] : []), ...(scope.typecheckPackages.length ? ["TYPECHECK"] : []),
      ...(scope.testPackages.some(name => !["@ling-stack/core", "@ling-stack/daemon"].includes(name)) ? ["UNIT"] : []),
      ...(scope.daemon ? ["DAEMON", "LINUX_CONTRACT", "MACOS_NATIVE"] : []), ...(scope.web ? ["WEB_SMOKE"] : [])]);
    const env = { ...process.env, EXECUTION_TIER: "complete", SCOPE_MODE: scope.mode,
      ASSURANCE_SELECTED: outputs["assurance-selected"], BUILD_SELECTED: outputs["build-selected"],
      DEPENDENCY_SELECTED: outputs["dependency-policy"], TYPECHECK_SELECTED: outputs["typecheck-selected"],
      UNIT_SELECTED: String(required.has("UNIT")), DAEMON_SELECTED: outputs.daemon, WEB_SELECTED: outputs.web,
      ...Object.fromEntries(lanes.map(lane => [`${lane}_RESULT`, required.has(lane) ? "success" : "skipped"])) };
    const run = (overrides: Record<string, string> = {}): SpawnSyncReturns<string> => spawnSync("bash", ["-euo", "pipefail", "-c",
      command.replace(/^ {10}/gmu, "")], { cwd: root, encoding: "utf8", timeout: 10_000, env: { ...env, ...overrides } });
    const passed = run();
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    for (const lane of required) assert.equal(run({ [`${lane}_RESULT`]: "skipped" }).status, 1, lane);
    for (const lane of lanes) assert.equal(run({ [`${lane}_RESULT`]: "failure" }).status, 1, lane);
  }
  assert.match(job("framework-assurance"), /run: corepack pnpm typecheck:ci-tests/u);
});
