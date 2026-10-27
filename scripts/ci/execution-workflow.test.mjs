import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const labelWorkflow = readFileSync(new URL("../../.github/workflows/full-ci-label.yml", import.meta.url), "utf8");
const root = fileURLToPath(new URL("../../", import.meta.url));
const lanes = ["SCOPE", "COMMON", "DEPENDENCY", "BUILD", "TYPECHECK", "UNIT", "DAEMON", "LINUX_CONTRACT", "MACOS_NATIVE"];
const platformJobs = ["daemon-tests", "daemon-linux-contracts", "restricted-command-macos"];

/** Read a top-level job without matching similarly named steps. */
function jobSource(id) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "mu").exec(workflow);
  assert.ok(match, `Missing job ${id}`);
  return match[1];
}

/** Execute the actual workflow aggregation command with simulated job outcomes. */
function runQuality(overrides = {}) {
  const command = jobSource("quality").split("        run: |\n")[1];
  assert.ok(command, "quality must retain an executable aggregation gate");
  return spawnSync("bash", ["-c", command.replace(/^ {10}/gmu, "")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EXECUTION_TIER: "complete", SCOPE_MODE: "full", DAEMON_SELECTED: "true",
      ...Object.fromEntries(lanes.map((lane) => [`${lane}_RESULT`, "success"])), ...overrides },
  });
}

test("PR transitions and full-ci labels trigger validation while full regression is daily", () => {
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft\]/u);
  assert.match(labelWorkflow, /pull_request_target:\n    types: \[labeled\]/u);
  assert.match(labelWorkflow, /gh workflow run ci\.yml --ref "\$HEAD_REF"/u);
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
  for (const id of ["dependency-policy", "build", "typecheck", "unit-tests", ...platformJobs]) {
    const source = jobSource(id);
    assert.match(source, /^    if: .*needs\.scope\.outputs\.execution-tier == 'complete'/mu, id);
    assert.match(source, platformJobs.includes(id) ? /needs\.scope\.outputs\.daemon == 'true'/u : /needs\.scope\.outputs\.mode != 'docs'/u, id);
  }
  const common = jobSource("common-fast");
  assert.match(common, /run: node --test scripts\/check-public-repo-safety\.test\.mjs scripts\/ci\/\*\.test\.mjs/u);
  assert.match(common, /name: Scan Git history for secrets\n        if: needs\.scope\.outputs\.execution-tier == 'complete' && needs\.scope\.outputs\.mode != 'docs'/u);
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
  assert.match(quality, /DAEMON_SELECTED: \$\{\{ needs\.scope\.outputs\.daemon \}\}/u);
  for (const lane of lanes) assert.match(quality, new RegExp(`${lane}_RESULT: \\$\\{\\{ needs\\.`, "u"));
  assert.equal(runQuality().status, 0);
  const preview = runQuality({ EXECUTION_TIER: "preview",
    ...Object.fromEntries(lanes.slice(2).map((lane) => [`${lane}_RESULT`, "skipped"])) });
  assert.equal(preview.status, 1, preview.stderr);
  assert.match(preview.stdout, /deferred_by_draft_policy/u);
});

test("workflow docs can skip product lanes but cannot hide failed common checks", () => {
  const docs = { SCOPE_MODE: "docs", DAEMON_SELECTED: "false",
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

test("workflow gate rejects failed, cancelled or missing results in every selected lane", () => {
  for (const lane of lanes) {
    for (const result of ["failure", "cancelled", "", undefined]) {
      const check = runQuality({ [`${lane}_RESULT`]: result });
      assert.equal(check.status, 1, check.stdout + check.stderr);
      assert.ok(check.stdout.includes(`${lane}=`), check.stdout);
    }
  }
});
