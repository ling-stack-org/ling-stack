import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const root = fileURLToPath(new URL("../../", import.meta.url));
const lanes = ["SCOPE", "COMMON", "DEPENDENCY", "BUILD", "TYPECHECK", "UNIT", "DAEMON"];

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
      IGNORED_LABEL_EVENT: "false", ...Object.fromEntries(lanes.map((lane) => [`${lane}_RESULT`, "success"])), ...overrides },
  });
}

test("PR transitions and full-ci labels trigger validation while full regression is weekly", () => {
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft, labeled\]/u);
  assert.match(workflow, /cron: "17 3 \* \* 1"/u);
  assert.doesNotMatch(workflow, /^  (?:push|paths|paths-ignore):/mu);
  assert.match(jobSource("scope"), /--event-file "\$GITHUB_EVENT_PATH"/u);
  assert.match(jobSource("scope"), /--base="\$BASE_SHA"/u);
  assert.match(jobSource("scope"), /execution-tier: \$\{\{ steps\.policy\.outputs\.execution-tier \}\}/u);
});

test("every expensive job requires complete execution and retains its scope selection", () => {
  for (const id of ["dependency-policy", "build", "typecheck", "unit-tests", "daemon-tests"]) {
    const source = jobSource(id);
    assert.match(source, /^    if: .*needs\.scope\.outputs\.execution-tier == 'complete'/mu, id);
    assert.match(source, id === "daemon-tests" ? /needs\.scope\.outputs\.daemon == 'true'/u : /needs\.scope\.outputs\.mode != 'docs'/u, id);
  }
  const common = jobSource("common-fast");
  assert.match(common, /run: node --test scripts\/ci\/\*\.test\.mjs/u);
  assert.match(common, /name: Scan Git history for secrets\n        if: needs\.scope\.outputs\.execution-tier == 'complete' && needs\.scope\.outputs\.mode != 'docs'/u);
});

test("unrelated labels cannot cancel validation or publish the required context", () => {
  assert.match(workflow, /group: .*github\.event\.label\.name != 'full-ci'.*github\.run_id/u);
  assert.match(workflow, /cancel-in-progress: .*github\.event\.label\.name == 'full-ci'/u);
  assert.match(jobSource("scope"), /^    if: .*github\.event\.label\.name == 'full-ci'/mu);
  assert.match(jobSource("quality"), /name: .*github\.event\.label\.name != 'full-ci'.*CI label event \(no validation\).*Typecheck, unit tests, and Web build/u);
  const ignored = runQuality({ IGNORED_LABEL_EVENT: "true", SCOPE_RESULT: "skipped", EXECUTION_TIER: "" });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.match(ignored.stdout, /Unrelated label event/u);
});

test("workflow gate requires all seven main lanes and refuses incomplete Draft validation", () => {
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
  const web = runQuality({ SCOPE_MODE: "affected", DAEMON_SELECTED: "false", DAEMON_RESULT: "skipped" });
  assert.equal(web.status, 0, web.stderr);
});
