import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MAX_JSON_BYTES, artifactRef, parseJson, parseSuite, parseTask, readArtifact, readBoundFile, safeRelativePath, sha256 } from "./manifest.mjs";
import { loadCoreGrader } from "./grader.mjs";
import { assessControl, DEFAULT_SUITE, preflight } from "./preflight.mjs";
import { calibrate, compareObservations, parseObservation } from "./evidence.mjs";
import { buildReport, compareBundles, observationBundle, renderReportMarkdown } from "./report.mjs";
import { prepareOutputDir, publishFile } from "./output.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = resolve(repoRoot, "fixtures/framework-assurance");
const checked = await preflight({ repoRoot });
const calibration = await calibrate({ repoRoot, invocationId: "unit-calibration" });
const clone = value => structuredClone(value);
const code = expected => error => error.code === expected;
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "ling-assurance-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fixtureCopy(t) {
  const root = await temporary(t);
  for (const directory of ["cases", "controls", "suites"]) await cp(join(fixtureRoot, directory), join(root, directory), { recursive: true });
  return root;
}
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }

test("three source-pinned tasks and nine controls calibrate without a live task", () => {
  assert.equal(checked.tasks.length, 3);
  assert.equal(calibration.passed, true);
  assert.equal(calibration.controls.length, 9);
  assert.equal(calibration.controls.filter(item => item.observedAssessment === "pass").length, 3);
  assert.equal(calibration.controls.filter(item => item.observedAssessment === "fail").length, 3);
  assert.equal(calibration.controls.filter(item => item.observedAssessment === "invalid_evidence").length, 3);
  assert.equal(calibration.externalProviderCalls, 0);
  assert.equal(calibration.ordinaryRunsDispatched, 0);
  assert.equal(calibration.userStoresInitialized, 0);
  assert.equal(calibration.taskCodeExecuted, false);
  assert.deepEqual(checked.tasks.map(item => item.task.provenance.kind), ["source_analysis", "fault_injection", "fault_injection"]);
});

for (const mutate of [value => value.schemaVersion = 2, value => value.extra = true,
  value => value.tasks.push(clone(value.tasks[0])), value => value.tasks = Array(101).fill(value.tasks[0]),
  value => value.tasks[0].task.sha256 = "a".repeat(63)]) {
  test(`suite rejects invalid schema/identity/limits: ${mutate.toString()}`, () => {
    const suite = clone(checked.suite); mutate(suite);
    assert.throws(() => parseSuite(suite), code("invalid_manifest"));
  });
}

for (const path of ["../secret.json", "/tmp/secret.json", "a/../../secret", "a//b", "a/./b", "a\\..\\b", "C:/secret", "a/%2e%2e/b", "https://example.test/a", "a/", ""]) {
  test(`portable path guard rejects ${JSON.stringify(path)}`, () => assert.throws(() => safeRelativePath(path), code("path_outside_fixture_root")));
}

test("task schema rejects unknown fields, duplicate pins and absent controls", () => {
  for (const mutate of [value => value.taskId = "bad/task", value => value.unknown = true,
    value => value.source.commit = [value.source.commit], value => value.limits.currency = [value.limits.currency],
    value => value.source.files.push(clone(value.source.files[0])), value => delete value.controls.missing,
    value => value.limits.maxRequests = -1, value => value.limits.unknownUsagePolicy = "continue",
    value => value.requiredEvidence.push(value.requiredEvidence[0]), value => value.provenance.injection = null]) {
    const task = clone(checked.tasks[1].task); mutate(task);
    assert.throws(() => parseTask(task), code("invalid_manifest"));
  }
  assert.throws(() => artifactRef({ path: "a", sha256: "a".repeat(64), mediaType: "application/javascript" }), code("invalid_manifest"));
});

test("JSON limits reject oversized, malformed, non-finite and deeply nested input", async t => {
  const root = await temporary(t);
  await writeFile(join(root, "large.json"), " ".repeat(MAX_JSON_BYTES + 1));
  await assert.rejects(readBoundFile(root, "large.json"), code("invalid_manifest"));
  for (const input of ["{", "1e309", "[".repeat(66) + "0" + "]".repeat(66)]) {
    assert.throws(() => parseJson(Buffer.from(input)), code("invalid_manifest"));
  }
});

test("artifact reads reject leaf/ancestor symlinks and byte tampering", async t => {
  const root = await temporary(t); const outside = await temporary(t);
  await writeFile(join(outside, "secret.json"), "{}");
  await symlink(join(outside, "secret.json"), join(root, "link.json"));
  await symlink(outside, join(root, "alias"), "dir");
  await assert.rejects(readBoundFile(root, "link.json"), code("path_outside_fixture_root"));
  await assert.rejects(readBoundFile(root, "alias/secret.json"), code("path_outside_fixture_root"));
  await writeFile(join(root, "value.json"), "{\"a\":1}\n");
  await assert.rejects(readArtifact(root, { path: "value.json", sha256: sha256('{"a":1}'), mediaType: "application/json" }), code("artifact_digest_mismatch"));
});

test("rule metadata stays closed and canonical JSON digest is not a byte digest", async () => {
  const core = await loadCoreGrader(repoRoot);
  const { task, rule, expected } = checked.tasks[0];
  assert.throws(() => core.grade({ caseDefinition: { ...rule, taskId: task.taskId }, baseline: expected, candidate: expected }), /unsupported fields/);
  assert.equal(core.valueDigest({ b: 2, a: 1 }), core.valueDigest({ a: 1, b: 2 }));
  assert.notEqual(sha256('{"b":2,"a":1}'), sha256('{"a":1,"b":2}'));
  const arrayRule = { ...rule, assertions: [{ type: "contains" }] };
  assert.equal(core.grade({ caseDefinition: arrayRule, baseline: [1], candidate: [2, 1] }).verdict, "fail");
  assert.equal(core.grade({ caseDefinition: arrayRule, baseline: [1], candidate: [1, 2] }).verdict, "pass");
});

test("uncommitted or symlinked grader is rejected before its code can execute", async t => {
  const root = await temporary(t);
  const harness = join(root, "packages/core/src/harness");
  await mkdir(harness, { recursive: true });
  for (const name of ["evaluation-rule-grader.ts", "evaluation-json.ts"]) {
    await cp(join(repoRoot, "packages/core/src/harness", name), join(harness, name));
  }
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["add", "packages"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Frozen grader fixture"], { cwd: root });
  const target = join(harness, "evaluation-rule-grader.ts");
  await writeFile(target, "globalThis.assuranceUntrustedGraderExecuted = true;\nexport {};\n");
  await assert.rejects(loadCoreGrader(root), code("artifact_digest_mismatch"));
  assert.equal(globalThis.assuranceUntrustedGraderExecuted, undefined);
  await rm(target);
  await symlink(join(repoRoot, "packages/core/src/harness/evaluation-rule-grader.ts"), target);
  await assert.rejects(loadCoreGrader(root), code("path_outside_fixture_root"));
});

test("frozen injection patches apply to their source without changing the checkout", () => {
  for (const id of ["T02", "T03"]) execFileSync("git", ["apply", "--check", join(fixtureRoot, "cases", id, "injection.patch")], { cwd: repoRoot, stdio: "pipe" });
});

test("both one-sided T03 repairs and missing evidence fail calibration assessment", async () => {
  const core = await loadCoreGrader(repoRoot); const item = checked.tasks[2];
  for (const checks of [{ schemaVersionOne: true, cwdForwarded: false }, { schemaVersionOne: false, cwdForwarded: true }]) {
    assert.equal(assessControl({ core, ...item, candidate: { checks } }).assessment, "fail");
  }
  assert.equal(assessControl({ core, ...item, candidate: {} }).assessment, "invalid_evidence");
});

test("changed artifact, task identity and locally unavailable source cannot pass preflight", async t => {
  const root = await fixtureCopy(t);
  await writeFile(join(root, "controls/T01-correct.json"), "{}\n");
  await assert.rejects(preflight({ repoRoot, fixtureRoot: root }), code("artifact_digest_mismatch"));
  const suite = clone(checked.suite);
  suite.tasks[0].taskId = "different";
  await writeJson(join(root, DEFAULT_SUITE), suite);
  await assert.rejects(preflight({ repoRoot, fixtureRoot: root }), code("invalid_manifest"));
  const task = clone(checked.tasks[0].task); task.source.commit = "0".repeat(40);
  const taskPath = checked.suite.tasks[0].task.path;
  await writeJson(join(root, taskPath), task);
  suite.tasks[0].taskId = task.taskId;
  suite.tasks[0].task.sha256 = sha256(await readFile(join(root, taskPath)));
  await writeJson(join(root, DEFAULT_SUITE), suite);
  await assert.rejects(preflight({ repoRoot, fixtureRoot: root }), code("source_unavailable"));
});

test("re-pinned false negative control produces a failed calibration, not a passing suite", async t => {
  const root = await fixtureCopy(t);
  const task = clone(checked.tasks[1].task); const suite = clone(checked.suite);
  await writeJson(join(root, "controls/T02-incorrect.json"), checked.tasks[1].expected);
  task.controls.incorrect.candidate.sha256 = sha256(await readFile(join(root, "controls/T02-incorrect.json")));
  const taskPath = checked.suite.tasks[1].task.path;
  await writeJson(join(root, taskPath), task);
  suite.tasks[1].task.sha256 = sha256(await readFile(join(root, taskPath)));
  await writeJson(join(root, DEFAULT_SUITE), suite);
  const result = await calibrate({ repoRoot, fixtureRoot: root, invocationId: "bad-control" });
  assert.equal(result.passed, false);
  assert.equal(result.controls.find(item => item.taskId === "T02" && item.caseId === "incorrect").matched, false);
});

test("reports distinguish controls from live tasks and Markdown matches JSON", () => {
  const report = buildReport(observationBundle(calibration)); const md = renderReportMarkdown(report);
  assert.equal(report.requested, 9); assert.equal(report.assessed, 6); assert.equal(report.passed, 3);
  assert.equal(report.liveTaskRequested, 0); assert.equal(report.liveTaskPassed, 0);
  assert.match(md, /Live tasks executed: 0/); assert.match(md, /assessed: 6/);
  for (const item of report.observations) assert.ok(md.includes(`| ${item.taskIdentity.taskId} | ${item.caseId} |`));
  assert.equal(report.timings.gradingMs.p95Ms, null);
  const empty = buildReport({ schemaVersion: 1, kind: "offline_observations", requestedCount: 0, observations: [] });
  assert.equal(empty.assessedPassRate, null); assert.equal(empty.endToEndSuccessRate, null);
});

test("duplicates are not independent trials even if object property order changes", () => {
  const bundle = observationBundle(calibration); const duplicate = clone(bundle.observations[0]);
  duplicate.taskIdentity = Object.fromEntries(Object.entries(duplicate.taskIdentity).reverse());
  bundle.observations.push(duplicate);
  const report = buildReport(bundle);
  assert.equal(report.observed, 9); assert.equal(report.duplicateExportsIgnored, 1);
  duplicate.assessment = "fail";
  assert.throws(() => buildReport(bundle), code("conflicting_observation"));
});

// Value: protects=timing median and p95 sample boundaries; fails_when=p95 appears below 20 samples or uses the wrong rank;
// why_new=the existing median assertions did not exercise the p95 threshold; seam=none; no_claim=live latency or statistical significance
test("timing medians avoid overflow and p95 requires 20 samples with nearest-rank selection", () => {
  const bundle = observationBundle(calibration); bundle.observations = bundle.observations.slice(0, 2); bundle.requestedCount = 2;
  bundle.observations[0].timings.gradingMs = 1;
  bundle.observations[1].timings.gradingMs = 9;
  assert.equal(buildReport(bundle).timings.gradingMs.medianMs, 5);
  bundle.observations.forEach(item => item.timings.gradingMs = Number.MAX_VALUE);
  assert.equal(buildReport(bundle).timings.gradingMs.medianMs, Number.MAX_VALUE);
  const samples = Array.from({ length: 20 }, (_, index) => {
    const observation = clone(calibration.observations[0]);
    observation.invocationId = `timing-${index}`;
    observation.observationId = sha256(observation.invocationId);
    observation.timings.gradingMs = (20 - index) * 10;
    return observation;
  });
  const nineteen = buildReport({ schemaVersion: 1, kind: "offline_observations", requestedCount: 19, observations: samples.slice(0, 19) });
  assert.equal(nineteen.timings.gradingMs.sampleCount, 19);
  assert.equal(nineteen.timings.gradingMs.p95Ms, null);
  const twenty = buildReport({ schemaVersion: 1, kind: "offline_observations", requestedCount: 20, observations: samples });
  assert.equal(twenty.timings.gradingMs.sampleCount, 20);
  assert.equal(twenty.timings.gradingMs.p95Ms, 190);
});

// Value: protects=usage settlement deduplication across observations; fails_when=shared requests double-count or conflicting settlements pass;
// why_new=the existing usage assertions contained no repeated request across observations; seam=none; no_claim=live billing reconciliation
test("unknown costs and different currencies remain separate; usage identities deduplicate", () => {
  const observation = clone(calibration.observations[0]); observation.evidenceKind = "fixture_replay";
  observation.usage = [
    { requestId: "request-1", scope: "task", status: "known", amount: 0.5, currency: "USD", source: "fixture" },
    { requestId: "request-2", scope: "task", status: "known", amount: 2, currency: "CNY", source: "fixture" },
    { requestId: "request-3", scope: "grader", status: "unknown", amount: null, currency: null, source: "fixture" },
  ];
  const report = buildReport({ schemaVersion: 1, kind: "offline_observations", requestedCount: 2, observations: [observation] });
  assert.deepEqual(report.costs.task.knownSubtotals, { USD: 0.5, CNY: 2 });
  assert.equal(report.costs.grader.unknownCount, 1); assert.deepEqual(report.costs.grader.knownSubtotals, {});
  assert.equal(report.unobserved, 1);
  const second = clone(observation);
  second.caseId = "shared-usage";
  second.observationId = sha256("shared-usage-observation");
  const shared = { schemaVersion: 1, kind: "offline_observations", requestedCount: 2, observations: [observation, second] };
  const deduplicated = buildReport(shared);
  assert.equal(deduplicated.observed, 2);
  assert.equal(deduplicated.duplicateExportsIgnored, 0);
  assert.deepEqual(deduplicated.costs, report.costs);
  second.usage[0].amount = 0.75;
  assert.throws(() => buildReport(shared), error => error.code === "conflicting_observation"
    && error.message === "Usage identity has conflicting settlements.");
  observation.usage[2].amount = 0;
  assert.throws(() => parseObservation(observation), code("invalid_manifest"));
});

test("live self-attestation, partial execution and unknown effects cannot report a pass", () => {
  for (const mutate of [item => item.evidenceKind = "live_execution", item => item.executionStatus = "cancelled", item => item.effectStatus = "unknown",
    item => item.sourceCommit = [item.sourceCommit],
    item => item.artifacts = [], item => item.limitations = [], item => item.comparison.node = "/private/path"]) {
    const observation = clone(calibration.observations[0]); mutate(observation);
    assert.throws(() => parseObservation(observation));
  }
  const item = clone(calibration.observations[0]); item.executionStatus = "not_started"; item.assessment = "not_assessed";
  const report = buildReport({ schemaVersion: 1, kind: "offline_observations", requestedCount: 1, observations: [item] });
  assert.equal(report.passed, 0); assert.equal(report.assessed, 0); assert.equal(report.assessedPassRate, null);
});

test("comparisons require identical pins and non-variable environment, including missing cases", () => {
  const first = clone(calibration.observations[0]), second = clone(first);
  assert.equal(compareObservations(first, second).comparable, true);
  second.comparison.model = "other-model";
  assert.equal(compareObservations(first, second).comparable, false);
  assert.equal(compareObservations(first, second, "model").comparable, true);
  second.inputDigests.profileBytes = "f".repeat(64);
  assert.equal(compareObservations(first, second, "model").comparable, false);
  const left = observationBundle(calibration), right = clone(left);
  right.observations.pop();
  assert.equal(compareBundles(left, right).comparable, false);
  assert.throws(() => compareObservations(first, first, "unrestricted"), code("invalid_manifest"));
});

test("comparisons deduplicate exports and require equal, homogeneous invocation cohorts", () => {
  const left = observationBundle(calibration), right = observationBundle(calibration);
  left.observations.push(clone(left.observations[0]));
  assert.equal(compareBundles(left, right).comparable, true);
  assert.equal(compareBundles(left, right).pairs.length, 9);
  const extra = clone(left.observations[0]);
  extra.invocationId = "second-invocation"; extra.observationId = sha256("second-invocation");
  left.observations.push(extra); left.requestedCount += 1; right.requestedCount += 1;
  const unequal = compareBundles(left, right);
  assert.equal(unequal.comparable, false);
  assert.ok(unequal.pairs[0].reasons.includes("invocation_counts_differ"));
  right.observations.push(clone(extra));
  assert.equal(compareBundles(left, right).comparable, true);
  extra.comparison.node = "other-version";
  assert.equal(compareBundles(left, right).comparable, false);
  assert.throws(() => compareBundles(left, right, "unrestricted"), code("invalid_manifest"));
});

test("outputs are external, atomic, idempotent and never overwrite different data", async t => {
  const outside = await temporary(t);
  const directory = await prepareOutputDir(repoRoot, outside);
  await publishFile(directory, "result.json", "{}\n");
  await publishFile(directory, "result.json", "{}\n");
  await assert.rejects(publishFile(directory, "result.json", "[]\n"), code("output_already_exists"));
  assert.equal(await readFile(join(directory, "result.json"), "utf8"), "{}\n");
  assert.deepEqual(await readdir(directory), ["result.json"]);
  await assert.rejects(prepareOutputDir(repoRoot, join(repoRoot, "fixtures", "results")), code("unsafe_output_directory"));
  await assert.rejects(prepareOutputDir(repoRoot, join(outside, ".ling-stack")), code("unsafe_output_directory"));
  await symlink(repoRoot, join(outside, "checkout-alias"), "dir");
  await assert.rejects(prepareOutputDir(repoRoot, join(outside, "checkout-alias", "must-not-create")), code("unsafe_output_directory"));
  await assert.rejects(access(join(repoRoot, "must-not-create")));
  const state = join(outside, ".ling-stack");
  await mkdir(state);
  await symlink(state, join(outside, "state-alias"), "dir");
  await assert.rejects(prepareOutputDir(repoRoot, join(outside, "state-alias", "must-not-create")), code("unsafe_output_directory"));
  await assert.rejects(access(join(state, "must-not-create")));
});
