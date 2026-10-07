import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertCiResults, selectExecutionTier } from "./execution-policy.mjs";

const script = fileURLToPath(new URL("./execution-policy.mjs", import.meta.url));
const lanes = ["SCOPE", "COMMON", "DEPENDENCY", "BUILD", "TYPECHECK", "UNIT", "DAEMON"];

function prEvent(action, { draft = false, labels = [], label } = {}) {
  return { action, pull_request: { draft, labels: labels.map((name) => ({ name })) }, ...(label === undefined ? {} : { label: { name: label } }) };
}

function tier(action, options) {
  return selectExecutionTier({ eventName: "pull_request", event: prEvent(action, options) });
}

function results(overrides = {}) {
  return Object.fromEntries(lanes.map((lane) => [lane, overrides[lane] ?? "success"]));
}

function quality(overrides = {}) {
  return assertCiResults({ tier: "complete", mode: "full", daemon: true, results: results(), ...overrides });
}

test("every Draft update previews while opened and ready PR updates run complete checks", () => {
  for (const action of ["opened", "synchronize", "reopened", "converted_to_draft"]) {
    assert.equal(tier(action, { draft: true }), "preview", action);
    assert.equal(tier(action), "complete", action);
  }
  assert.equal(tier("ready_for_review"), "complete");
});

test("full-ci opts a Draft into complete checks when applied and on later pushes", () => {
  assert.equal(tier("labeled", { draft: true, labels: ["full-ci"], label: "full-ci" }), "complete");
  assert.equal(tier("synchronize", { draft: true, labels: ["full-ci", "bug"] }), "complete");
  assert.equal(tier("ready_for_review", { labels: ["full-ci"] }), "complete");
});

test("full-ci label matching agrees with case-insensitive GitHub expressions", () => {
  assert.equal(tier("labeled", { draft: true, labels: ["Full-CI"], label: "FULL-CI" }), "complete");
  assert.equal(tier("synchronize", { draft: true, labels: ["Full-CI", "bug"] }), "complete");
  assert.equal(tier("labeled", { draft: true, labels: ["Full-CI", "bug"], label: "bug" }), "ignore");
});

test("unrelated label changes are ignored even on ready PRs or existing full-ci Drafts", () => {
  for (const draft of [true, false]) {
    assert.equal(tier("labeled", { draft, label: "bug", labels: ["bug"] }), "ignore");
    assert.equal(tier("labeled", { draft, label: "bug", labels: ["full-ci", "bug"] }), "ignore");
    assert.equal(tier("unlabeled", { draft, labels: [], label: "full-ci" }), "ignore");
  }
  assert.equal(tier("synchronize", { draft: true, labels: [] }), "preview");
});

test("scheduled and manual runs always select complete checks", () => {
  for (const eventName of ["schedule", "workflow_dispatch", "push"]) {
    assert.equal(selectExecutionTier({ eventName, event: {} }), "complete", eventName);
  }
});

test("malformed PR data cannot silently select a cheaper execution tier", () => {
  for (const event of [
    {}, null, [],
    { action: "synchronize" },
    { ...prEvent("synchronize"), pull_request: { draft: "true", labels: [] } },
    { ...prEvent("synchronize"), pull_request: { draft: true } },
    { ...prEvent("synchronize"), pull_request: { draft: true, labels: ["full-ci"] } },
    prEvent("labeled", { draft: true, labels: ["full-ci"] }),
    prEvent("labeled", { draft: true, labels: [], label: "full-ci" }),
  ]) {
    assert.throws(() => selectExecutionTier({ eventName: "pull_request", event }), Error);
  }
  assert.throws(() => selectExecutionTier({ event: {} }), /eventName/u);
});

test("complete scope succeeds only after all applicable results succeed", () => {
  assert.equal(quality(), true);
  assert.equal(quality({ mode: "affected" }), true);
});

for (const lane of lanes) {
  for (const result of ["failure", "cancelled", "skipped", "", undefined, "pending"]) {
    test(`complete execution rejects required ${lane}=${String(result)}`, () => {
      assert.throws(() => quality({ results: { ...results(), [lane]: result } }), new RegExp(`${lane}=`, "u"));
    });
  }
}

test("documentation scope requires scope and common but permits every product lane to skip", () => {
  const skipped = results(Object.fromEntries(lanes.slice(2).map((lane) => [lane, "skipped"])));
  assert.equal(quality({ mode: "docs", daemon: false, results: skipped }), true);
  for (const lane of ["SCOPE", "COMMON"]) {
    assert.throws(() => quality({ mode: "docs", daemon: false, results: { ...skipped, [lane]: "skipped" } }), new RegExp(`${lane}=skipped`, "u"));
  }
  for (const lane of lanes.slice(2)) {
    for (const result of ["failure", "cancelled"]) {
      assert.throws(() => quality({ mode: "docs", daemon: false, results: { ...skipped, [lane]: result } }), new RegExp(`${lane}=${result}`, "u"));
    }
  }
});

test("Web-only scope can skip Daemon but requires every selected product lane", () => {
  const daemonSkip = results({ DAEMON: "skipped" });
  assert.equal(quality({ mode: "affected", daemon: false, results: daemonSkip }), true);
  for (const lane of ["DEPENDENCY", "BUILD", "TYPECHECK", "UNIT"]) {
    assert.throws(() => quality({ mode: "affected", daemon: false, results: { ...daemonSkip, [lane]: "skipped" } }), new RegExp(`${lane}=skipped`, "u"));
  }
});

test("Draft common-check success is explicitly deferred instead of certifying an incomplete merge gate", () => {
  const draftResults = results(Object.fromEntries(lanes.slice(2).map((lane) => [lane, "skipped"])));
  for (const mode of ["docs", "affected", "full"]) {
    assert.throws(() => quality({ tier: "preview", mode, results: draftResults }), /deferred_by_draft_policy/u);
  }
  for (const lane of ["SCOPE", "COMMON"]) {
    for (const result of ["failure", "cancelled", "skipped", "", undefined]) {
      assert.throws(() => quality({ tier: "preview", results: { ...draftResults, [lane]: result } }), new RegExp(`${lane}=`, "u"));
    }
  }
});

test("ignore and malformed scope inputs cannot pass the required quality gate", () => {
  assert.throws(() => quality({ tier: "ignore" }), /ignored_event_not_quality_gate/u);
  assert.throws(() => quality({ tier: "" }), /EXECUTION_TIER/u);
  assert.throws(() => quality({ mode: "" }), /SCOPE_MODE/u);
  assert.throws(() => quality({ daemon: "false" }), /DAEMON_SELECTED/u);
  assert.throws(() => quality({ results: null }), /results/u);
});

test("event-file CLI emits only the tier and rejects unreadable, invalid or ambiguous inputs", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ling-ci-policy-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventFile = join(directory, "event.json");
  writeFileSync(eventFile, JSON.stringify(prEvent("synchronize", { draft: true })));
  const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", ...extra } });
  const preview = run(["--event-file", eventFile]);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(preview.stdout, "preview\n");
  assert.equal(run([`--event-file=${eventFile}`, "--event-name=workflow_dispatch"]).stdout, "complete\n");
  for (const [event, expected] of [
    [prEvent("ready_for_review"), "complete"],
    [prEvent("labeled", { draft: true, labels: ["Full-CI"], label: "FULL-CI" }), "complete"],
    [prEvent("labeled", { labels: ["bug"], label: "bug" }), "ignore"],
  ]) {
    writeFileSync(eventFile, JSON.stringify(event));
    const check = run(["--event-file", eventFile]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.equal(check.stdout, `${expected}\n`);
  }
  for (const args of [[], ["--event-file"], ["--unknown"], ["--event-file", eventFile, "--event-file", eventFile], ["--check-quality", "--event-file", eventFile], ["--event-file", join(directory, "missing.json")]]) {
    assert.equal(run(args).status, 1, args.join(" "));
  }
  writeFileSync(eventFile, "{");
  assert.equal(run(["--event-file", eventFile]).status, 1);
});

test("quality CLI enforces environment types and reports failures in the workflow log", () => {
  const env = { ...process.env, EXECUTION_TIER: "complete", SCOPE_MODE: "full", DAEMON_SELECTED: "true",
    ...Object.fromEntries(lanes.map((lane) => [`${lane}_RESULT`, "success"])) };
  const run = (overrides = {}) => spawnSync(process.execPath, [script, "--check-quality"], { encoding: "utf8", env: { ...env, ...overrides } });
  assert.equal(run().status, 0);
  for (const lane of lanes) {
    for (const result of ["failure", "cancelled", "skipped", "", undefined]) {
      const check = run({ [`${lane}_RESULT`]: result });
      assert.equal(check.status, 1, check.stdout + check.stderr);
      assert.ok(check.stdout.includes(`${lane}=`), check.stdout);
    }
  }
  const skippedProducts = Object.fromEntries(lanes.slice(2).map((lane) => [`${lane}_RESULT`, "skipped"]));
  assert.equal(run({ SCOPE_MODE: "docs", DAEMON_SELECTED: "false", ...skippedProducts }).status, 0);
  assert.equal(run({ SCOPE_MODE: "affected", DAEMON_SELECTED: "false", DAEMON_RESULT: "skipped" }).status, 0);
  for (const mode of ["docs", "affected", "full"]) {
    const preview = run({ EXECUTION_TIER: "preview", SCOPE_MODE: mode, ...skippedProducts });
    assert.equal(preview.status, 1, preview.stdout + preview.stderr);
    assert.match(preview.stdout, /deferred_by_draft_policy/u);
  }
  assert.equal(run({ DAEMON_SELECTED: "" }).status, 1);
  assert.equal(run({ EXECUTION_TIER: "" }).status, 1);
  assert.equal(run({ SCOPE_MODE: "" }).status, 1);
});
