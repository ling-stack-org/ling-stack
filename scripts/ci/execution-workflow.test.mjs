import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyChangedFiles } from "./classify-scope.mjs";
import { createTestPlan } from "./test-shard-plan.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const labelWorkflow = readFileSync(new URL("../../.github/workflows/full-ci-label.yml", import.meta.url), "utf8");
const root = fileURLToPath(new URL("../../", import.meta.url));
const lanes = ["SCOPE", "COMMON", "DEPENDENCY", "BUILD", "TYPECHECK", "UNIT", "DAEMON", "LINUX_CONTRACT", "MACOS_NATIVE"];
const platformJobs = ["daemon-tests", "daemon-linux-contracts", "restricted-command-macos"];
const selectorOutputs = { DEPENDENCY: "dependency-policy", TYPECHECK: "typecheck-selected", UNIT: "unit-selected", DAEMON: "daemon" };
const unselected = Object.fromEntries(Object.keys(selectorOutputs).map((selector) => [`${selector}_SELECTED`, "false"]));

/** Read a top-level job without matching similarly named steps. */
function jobSource(id) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "mu").exec(workflow);
  assert.ok(match, `Missing job ${id}`);
  return match[1];
}

/** Execute the actual workflow aggregation command with simulated job outcomes. */
function runQuality(overrides = {}) {
  const command = /^ {8}run: \|\n((?: {10}[^\n]*(?:\n|$)|\n)*)/mu.exec(jobSource("quality"))?.[1];
  assert.ok(command, "quality must retain an executable aggregation gate");
  return spawnSync("bash", ["-c", command.replace(/^ {10}/gmu, "")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EXECUTION_TIER: "complete", SCOPE_MODE: "full",
      ...Object.fromEntries(Object.keys(selectorOutputs).map((selector) => [`${selector}_SELECTED`, "true"])),
      ...Object.fromEntries(lanes.map((lane) => [`${lane}_RESULT`, "success"])), ...overrides },
  });
}

/** Execute the workflow's own heredoc and output redirection, without a GitHub runner. */
function runOutputTransform(variable, value) {
  const source = jobSource("scope");
  const start = source.indexOf(`          ${variable}=`);
  assert.notEqual(start, -1, `Missing ${variable} transformation`);
  const end = source.indexOf("          NODE\n", start);
  assert.notEqual(end, -1, `Missing ${variable} heredoc terminator`);
  const command = source.slice(start, end + "          NODE\n".length).replace(/^ {10}/gmu, "");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", command], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, scope_json: value, unit_matrix: value, GITHUB_OUTPUT: "/dev/stdout" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    assert.ok(separator > 0, `Invalid workflow output: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  });
  assert.equal(new Set(lines.map(([key]) => key)).size, lines.length);
  return Object.fromEntries(lines);
}

async function assertScopeOutputs(scope, { mode, packages, daemon, web, dependency = false, matrix }) {
  const outputs = runOutputTransform("SCOPE_JSON", JSON.stringify(scope));
  assert.deepEqual(outputs, {
    mode, packages: JSON.stringify(packages), "test-packages": JSON.stringify(packages),
    "typecheck-packages": JSON.stringify(packages), "dependency-policy": String(dependency),
    "typecheck-selected": String(packages.length > 0), daemon: String(daemon), web: String(web),
  });
  const plan = await createTestPlan(JSON.parse(outputs["test-packages"]));
  assert.deepEqual(plan.unitMatrix, { include: matrix });
  const selected = runOutputTransform("UNIT_MATRIX", JSON.stringify(plan.unitMatrix));
  assert.deepEqual(selected, { "unit-selected": matrix.length > 0 ? "true" : "false" });
  const gate = {
    SCOPE_MODE: outputs.mode,
    ...Object.fromEntries(Object.entries(selectorOutputs).map(([selector, output]) =>
      [`${selector}_SELECTED`, (output === "unit-selected" ? selected : outputs)[output]])),
    ...Object.fromEntries(lanes.slice(2).map((lane) => [`${lane}_RESULT`, "skipped"])),
  };
  // Expected lanes are independent of the emitted selectors: a false selector
  // must not turn a selected lane's skipped result into a passing quality gate.
  const required = ["SCOPE", "COMMON", ...(mode === "docs" ? [] : ["BUILD"]),
    ...(dependency ? ["DEPENDENCY"] : []), ...(packages.length ? ["TYPECHECK"] : []),
    ...(matrix.length ? ["UNIT"] : []), ...(daemon ? ["DAEMON", "LINUX_CONTRACT", "MACOS_NATIVE"] : [])];
  for (const lane of required) gate[`${lane}_RESULT`] = "success";
  const passed = runQuality(gate);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  for (const lane of required) {
    const skipped = runQuality({ ...gate, [`${lane}_RESULT`]: "skipped" });
    assert.equal(skipped.status, 1, `${lane}: ${skipped.stdout}${skipped.stderr}`);
    assert.match(skipped.stdout, new RegExp(`${lane}=skipped`, "u"));
  }
}

// protects: docs outputs and empty matrix; fails_when: docs selects product work;
// why_new: executes inline output conversion plus quality; seam=none;
// no_claim=hosted GitHub scheduler not executed.
test("workflow transformations preserve docs empty arrays and deselected lanes", { timeout: 90_000 }, async () => {
  await assertScopeOutputs(classifyChangedFiles({ files: ["README.md"] }), {
    mode: "docs", packages: [], daemon: false, web: false, matrix: [],
  });
});

// protects: daemon-only selection with an empty unit matrix; fails_when: daemon is hidden or unit is selected;
// why_new: joins real discovery, inline selectors and quality; seam=none;
// no_claim=hosted GitHub scheduler not executed.
test("workflow transformations keep daemon test-only work outside the unit matrix", { timeout: 90_000 }, async () => {
  await assertScopeOutputs(classifyChangedFiles({ files: ["packages/daemon/test/approval-policy-run.test.mjs"] }), {
    mode: "affected", packages: ["@ling-stack/daemon"], daemon: true, web: false, matrix: [],
  });
});

// protects: all four core unit shards; fails_when: matrix or unit selector drops core;
// why_new: executes matrix-to-selector heredoc against the real plan; seam=none;
// no_claim=hosted GitHub scheduler not executed.
test("workflow transformations select the four core shards for core test-only work", { timeout: 90_000 }, async () => {
  await assertScopeOutputs(classifyChangedFiles({ files: ["packages/core/test/example.test.ts"] }), {
    mode: "affected", packages: ["@ling-stack/core"], daemon: false, web: false,
    matrix: [0, 1, 2, 3].map((shard) => ({ suite: "core", shard })),
  });
});

// protects: web test and source package arrays and package-suite selection; fails_when: web work disappears;
// why_new: checks both classifier paths through actual workflow JS and quality; seam=none;
// no_claim=hosted GitHub scheduler not executed.
test("workflow transformations retain web test and source validation consumers", { timeout: 90_000 }, async () => {
  for (const [file, packages] of [
    ["apps/web/test/example.test.ts", ["@ling-stack/web"]],
    ["apps/web/src/example.ts", ["@ling-stack/cli", "@ling-stack/localization", "@ling-stack/web"]],
  ]) {
    await assertScopeOutputs(classifyChangedFiles({ files: [file] }), {
      mode: "affected", packages, daemon: false, web: true, matrix: [{ suite: "packages", shard: 0 }],
    });
  }
});

// protects: full-scope selectors and combined package/core matrix; fails_when: any required lane is hidden;
// why_new: bounded full classifier graph exercises inline outputs end to end; seam=none;
// no_claim=hosted GitHub scheduler not executed.
test("workflow transformations require every lane for a bounded full package graph", { timeout: 90_000 }, async () => {
  const packages = ["@ling-stack/core", "@ling-stack/daemon", "@ling-stack/web"];
  const packageEntries = packages.map((name) => ({ name,
    directory: name.endsWith("web") ? "apps/web" : `packages/${name.split("/")[1]}`,
    dependencies: [], hasTestScript: true, hasTypecheckScript: true,
  }));
  await assertScopeOutputs(classifyChangedFiles({ files: ["package.json"], packageEntries }), {
    mode: "full", packages, dependency: true, daemon: true, web: true,
    matrix: [{ suite: "packages", shard: 0 }, ...[0, 1, 2, 3].map((shard) => ({ suite: "core", shard }))],
  });
});

test("PR transitions and full-ci labels trigger validation while full regression is daily", () => {
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft\]/u);
  assert.match(labelWorkflow, /pull_request_target:\n    types: \[labeled\]/u);
  assert.match(labelWorkflow, /gh workflow run ci\.yml --ref "\$HEAD_REF" --repo "\$GITHUB_REPOSITORY"/u);
  assert.match(workflow, /cron: "17 3 \* \* \*"/u);
  assert.doesNotMatch(workflow, /^  (?:push|paths|paths-ignore):/mu);
  assert.match(jobSource("scope"), /--event-file "\$GITHUB_EVENT_PATH"/u);
  assert.match(jobSource("scope"), /--base="\$BASE_SHA"/u);
  assert.match(jobSource("scope"), /execution-tier: \$\{\{ steps\.policy\.outputs\.execution-tier \}\}/u);
  for (const id of workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^  ([a-z][a-z-]*):$/gmu)) {
    const ids = [...jobSource(id[1]).matchAll(/^        id: (\S+)$/gmu)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${id[1]} must not contain duplicate step IDs`);
  }
  assert.equal([...jobSource("scope").matchAll(/^        id: policy$/gmu)].length, 1);
});

test("every expensive job requires complete execution and retains its scope selection", () => {
  const selectedJobs = { "dependency-policy": "dependency-policy", typecheck: "typecheck-selected", "unit-tests": "unit-selected" };
  for (const id of ["dependency-policy", "build", "typecheck", "unit-tests", ...platformJobs]) {
    const source = jobSource(id);
    assert.match(source, /^    if: .*needs\.scope\.outputs\.execution-tier == 'complete'/mu, id);
    const selector = platformJobs.includes(id) ? "daemon" : selectedJobs[id];
    assert.match(source, selector ? new RegExp(`^    if: .*needs\\.scope\\.outputs\\.${selector} == 'true'`, "mu") : /^    if: .*needs\.scope\.outputs\.mode != 'docs'/mu, id);
  }
  const common = jobSource("common-fast");
  assert.match(common, /run: node --test scripts\/check-public-repo-safety\.test\.mjs scripts\/ci\/\*\.test\.mjs/u);
  assert.match(common, /name: Scan Git history for secrets\n        if: needs\.scope\.outputs\.execution-tier == 'complete'\n/u);
  const dependencyPolicy = jobSource("dependency-policy");
  assert.match(dependencyPolicy, /name: Check production dependency update policy\n        run: node --test scripts\/production-dependency-policy\.test\.mjs/u);
});

test("label events never create CI runs so the latest run always publishes the required context", () => {
  // The required gate resolves against the newest CI run on a head; a label run
  // without the gate job makes the ruleset report it as expected and block merges.
  assert.doesNotMatch(workflow, /labeled/u);
  assert.match(jobSource("quality"), /^    name: Typecheck, unit tests, and Web build$/mu);
  assert.doesNotMatch(jobSource("quality"), /IGNORED_LABEL_EVENT/u);
  assert.doesNotMatch(jobSource("scope"), /^    if:/mu);
  assert.match(labelWorkflow, /if: github\.event\.label\.name == 'full-ci'/u);
  assert.match(labelWorkflow, /actions: write/u);
  assert.match(labelWorkflow, /pull_request\.head\.ref/u);
  // The dispatch job holds a write token on pull_request_target; it must stay a
  // pure API caller and refuse forked heads that workflow_dispatch cannot address.
  assert.doesNotMatch(labelWorkflow, /actions\/checkout/u);
  assert.match(labelWorkflow, /"\$HEAD_REPO" != "\$GITHUB_REPOSITORY"/u);
});

test("long-running jobs respond to cancellation while quality still reports incomplete validation", () => {
  for (const id of ["typecheck", "unit-tests", ...platformJobs]) {
    const source = jobSource(id);
    assert.match(source, /^    if: \$\{\{ !cancelled\(\) &&/mu, id);
    assert.doesNotMatch(source, /^    if: .*always\(\)/mu, id);
    assert.match(source, /needs\.build\.result == 'success'/u, id);
  }
  assert.match(jobSource("quality"), /^    if: always\(\)/mu);
  const cancelled = runQuality({ UNIT_RESULT: "cancelled", DAEMON_RESULT: "cancelled" });
  assert.equal(cancelled.status, 1, cancelled.stderr);
  assert.match(cancelled.stdout, /UNIT=cancelled.*DAEMON=cancelled/u);
});

test("workflow gate requires all nine lanes and refuses incomplete Draft validation", () => {
  const quality = jobSource("quality");
  assert.match(quality, /^    if: always\(\)/mu);
  assert.match(quality, /EXECUTION_TIER: \$\{\{ needs\.scope\.outputs\.execution-tier \}\}/u);
  assert.match(quality, /SCOPE_MODE: \$\{\{ needs\.scope\.outputs\.mode \}\}/u);
  for (const [selector, output] of Object.entries(selectorOutputs)) {
    assert.match(jobSource("scope"), new RegExp(`^      ${output}: \\$\\{\\{ steps\\.[a-z-]+\\.outputs\\.${output} \\}\\}$`, "mu"));
    assert.match(quality, new RegExp(`${selector}_SELECTED: \\$\\{\\{ needs\\.scope\\.outputs\\.${output} \\}\\}`, "u"));
  }
  for (const lane of lanes) assert.match(quality, new RegExp(`${lane}_RESULT: \\$\\{\\{ needs\\.`, "u"));
  assert.equal(runQuality().status, 0);
  const preview = runQuality({ EXECUTION_TIER: "preview",
    ...Object.fromEntries(lanes.slice(2).map((lane) => [`${lane}_RESULT`, "skipped"])) });
  assert.equal(preview.status, 1, preview.stderr);
  assert.match(preview.stdout, /deferred_by_draft_policy/u);
});

test("workflow docs can skip product lanes but cannot hide failed common checks", () => {
  const docs = { SCOPE_MODE: "docs", ...unselected,
    ...Object.fromEntries(lanes.slice(2).map((lane) => [`${lane}_RESULT`, "skipped"])) };
  assert.equal(runQuality(docs).status, 0);
  for (const lane of ["SCOPE", "COMMON"]) {
    const check = runQuality({ ...docs, [`${lane}_RESULT`]: "skipped" });
    assert.equal(check.status, 1, check.stderr);
    assert.match(check.stdout, new RegExp(`${lane}=skipped`, "u"));
  }
});

test("workflow affected scope cannot hide skipped product work or selected Daemon failures", () => {
  for (const lane of lanes.slice(2)) {
    const check = runQuality({ SCOPE_MODE: "affected", [`${lane}_RESULT`]: "skipped" });
    assert.equal(check.status, 1, check.stderr);
    assert.match(check.stdout, new RegExp(`${lane}=skipped`, "u"));
  }
  const web = runQuality({ SCOPE_MODE: "affected", DAEMON_SELECTED: "false", DAEMON_RESULT: "skipped", LINUX_CONTRACT_RESULT: "skipped", MACOS_NATIVE_RESULT: "skipped" });
  assert.equal(web.status, 0, web.stderr);
});

test("workflow affected scope permits only explicit out-of-scope skips and still requires build", () => {
  const affected = { SCOPE_MODE: "affected", ...unselected,
    ...Object.fromEntries(lanes.slice(2).filter((lane) => lane !== "BUILD").map((lane) => [`${lane}_RESULT`, "skipped"])) };
  assert.equal(runQuality(affected).status, 0);
  for (const lane of lanes.slice(2)) {
    for (const result of ["failure", "cancelled", "", undefined, "pending", ...(lane === "BUILD" ? ["skipped"] : [])]) {
      const check = runQuality({ ...affected, [`${lane}_RESULT`]: result });
      assert.equal(check.status, 1, check.stdout + check.stderr);
      assert.match(check.stdout, new RegExp(`${lane}=`, "u"));
    }
  }
});

test("workflow selectors are mandatory strict booleans and cannot weaken docs or full scope", () => {
  for (const selector of Object.keys(selectorOutputs)) {
    const name = `${selector}_SELECTED`;
    for (const value of [undefined, "", "TRUE", "False", " true", "false ", "0", "1"]) {
      const check = runQuality({ [name]: value });
      assert.equal(check.status, 1, check.stdout + check.stderr);
      assert.match(check.stdout, new RegExp(name, "u"));
    }
    for (const tier of ["complete", "preview"]) {
      for (const overrides of [{ [name]: "false" }, { SCOPE_MODE: "docs", ...unselected, [name]: "true" }]) {
        const check = runQuality({ EXECUTION_TIER: tier, ...overrides });
        assert.equal(check.status, 1, check.stdout + check.stderr);
        assert.match(check.stdout, new RegExp(`${overrides.SCOPE_MODE ?? "full"}.*${name}`, "u"));
      }
    }
  }
});

test("workflow gate rejects failed, cancelled or missing results in every selected lane", () => {
  for (const lane of lanes) {
    for (const result of ["failure", "cancelled", "", undefined]) {
      const check = runQuality({ [`${lane}_RESULT`]: result });
      assert.equal(check.status, 1, check.stdout + check.stderr);
      assert.ok(check.stdout.includes(`${lane}=`), check.stdout);
    }
  }
});
