import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths, digestRunEvaluationValue } from "@ling-stack/core";

const moduleUrl = new URL("../dist/features/harness/evaluations/storage-projection.js", import.meta.url);
const feature = await import(moduleUrl.href).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== moduleUrl.href) throw error;
  return null;
});
const now = "2026-10-08T00:00:00.000Z";
const digest = digestRunEvaluationValue;
const byteDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ref = (artifact) => ({ artifactId: artifact.id, contentSha256: artifact.contentSha256 });
const frozenGrader = {
  graderId: "stored-grader", graderVersion: "1", modelId: "fixture-model", modelVersion: "exact-1",
  promptDigest: digest("prompt"), samplingDigest: digest("sampling"), rubricDigest: digest("rubric"),
};
const frozenGraderDigest = digest(frozenGrader);

async function fixture(t, { observations = 2, human = true, model = true, costs = true,
  changeObservation = (value) => value, changeRaw = (value) => value, changeFrozen = (value) => value,
  caseCount = 1 } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-h09-storage-projection-"));
  let store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    database.close(); store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "H09 projection fixture", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Stored fixture", prompt: "No model call" }, now);
  function run(id, parentRunId) {
    const result = store.createRun({ id, cwd, taskId: task.id, parentRunId, providerName: "fixture",
      providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    store.markRunSucceeded(id, now);
    return result;
  }
  run("root"); run("child", "root"); run("sibling", "root"); run("foreign");
  function artifact(id, payload, runId = "child") {
    return store.createArtifact({ id, runId, type: "json", path: `${id}.json`, sealedPayload: payload, createdAt: now });
  }
  const suite = artifact("suite", { id: "suite", version: "1" }, "root");
  const caseArtifact = artifact("case", { id: "case", version: "1" });
  const baseline = artifact("baseline", { expected: true }, "root");
  const candidate = artifact("candidate", { actual: true });
  const evaluation = store.enqueueRunEvaluation({ id: "evaluation", runId: "child", rootRunId: "root",
    suiteId: "suite", suiteVersion: "1", suiteArtifactId: suite.id, caseId: "case", caseVersion: "1",
    caseArtifactId: caseArtifact.id, baselineId: "baseline", baselineVersion: "1",
    baselineArtifactId: baseline.id, candidateArtifactId: candidate.id, now }).evaluation;
  store.claimRunEvaluation({ evaluationId: evaluation.id, expectedRevision: 0, claimOwner: "fixture", claimToken: "lease",
    claimExpiresAt: "2026-10-08T01:00:00.000Z", now });
  store.startRunEvaluation({ evaluationId: evaluation.id, expectedRevision: 1, claimOwner: "fixture", claimToken: "lease", now });
  const completed = store.completeRunEvaluation({ evaluationId: evaluation.id, expectedRevision: 2,
    claimOwner: "fixture", claimToken: "lease", now,
    grade: { id: "rule-grade", graderType: "rule", graderId: "rule", graderVersion: "1", verdict: "pass" } });
  assert.equal(completed.ok, true);
  const observationArtifacts = Array.from({ length: observations }, (_, index) => artifact(`observation-${index}`, changeObservation({
    schemaVersion: 1, kind: "shadow_model_observation", evaluationId: evaluation.id,
    evaluationKey: evaluation.idempotencyKey, frozenGraderDigest,
    invocationId: `invocation-${index}`, providerRequestId: `request-${index}`, verdict: "pass",
    ...(costs ? { costInputTokens: 10, costOutputTokens: 5, costAmountMicros: 3, latencyMs: 7 } : {}),
  }, index)));
  const raw = artifact("model-raw", changeRaw({ schemaVersion: 1, kind: "shadow_model_observations",
    evaluationId: evaluation.id, evaluationKey: evaluation.idempotencyKey, frozenGraderDigest,
    observations: observationArtifacts.map(ref) }));
  const gradeRef = (grade) => ({ gradeId: grade.id, gradeDigest: grade.gradeDigest,
    ...(grade.rawOutputArtifactId ? { rawOutputArtifact: ref(store.getArtifact(grade.rawOutputArtifactId)) } : {}) });
  const row = { evaluationId: evaluation.id, evaluationKey: evaluation.idempotencyKey };
  if (model) row.modelGrade = gradeRef(store.appendRunEvaluationGrade({ evaluationId: evaluation.id, now, grade: {
    id: "model-grade", graderType: "model", graderId: frozenGrader.graderId, graderVersion: "1", verdict: "pass",
    rawOutputArtifactId: raw.id,
  } }).grade);
  if (human) {
    const humanRaw = artifact("human-raw", { claimedHuman: true, adjudicationStatus: "authenticated" });
    row.humanGrade = gradeRef(store.appendRunEvaluationGrade({ evaluationId: evaluation.id, now, grade: {
      id: "human-grade", graderType: "human", graderId: "self-claimed-human", graderVersion: "1",
      verdict: "pass", adjudicationStatus: "authenticated", rawOutputArtifactId: humanRaw.id,
    } }).grade);
  }
  const frozen = artifact("frozen", changeFrozen(structuredClone(frozenGrader)), "root");
  const manifestPayload = { schemaVersion: 1, kind: "shadow_promotion_corpus", rootRunId: "root",
    frozenGraderArtifact: ref(frozen), frozenGraderDigest, cases: [row] };
  for (let index = 1; index < caseCount; index += 1) {
    const caseArtifact = artifact(`case-${index}`, { case: index, version: "1" });
    const candidate = artifact(`candidate-${index}`, { actual: index });
    const e = store.enqueueRunEvaluation({ id: `evaluation-${index}`, runId: "child", rootRunId: "root",
      suiteId: "suite", suiteVersion: "1", suiteArtifactId: suite.id, caseId: `case-${index}`, caseVersion: "1",
      caseArtifactId: caseArtifact.id, baselineId: "baseline", baselineVersion: "1", baselineArtifactId: baseline.id,
      candidateArtifactId: candidate.id, now }).evaluation;
    store.claimRunEvaluation({ evaluationId: e.id, expectedRevision: 0, claimOwner: "fixture", claimToken: "lease",
      claimExpiresAt: "2026-10-08T01:00:00.000Z", now });
    store.startRunEvaluation({ evaluationId: e.id, expectedRevision: 1, claimOwner: "fixture", claimToken: "lease", now });
    store.completeRunEvaluation({ evaluationId: e.id, expectedRevision: 2, claimOwner: "fixture", claimToken: "lease", now,
      grade: { id: `rule-${index}`, graderType: "rule", graderId: "rule", graderVersion: "1", verdict: "pass" } });
    const refs = Array.from({ length: 2 }, (_, repeat) => ref(artifact(`obs-${index}-${repeat}`, {
      schemaVersion: 1, kind: "shadow_model_observation", evaluationId: e.id, evaluationKey: e.idempotencyKey,
      frozenGraderDigest, invocationId: `invocation-${index}-${repeat}`, providerRequestId: `request-${index}-${repeat}`, verdict: "pass",
    })));
    const raw = artifact(`raw-${index}`, { schemaVersion: 1, kind: "shadow_model_observations", evaluationId: e.id,
      evaluationKey: e.idempotencyKey, frozenGraderDigest, observations: refs });
    const modelGrade = store.appendRunEvaluationGrade({ evaluationId: e.id, now, grade: {
      id: `model-${index}`, graderType: "model", graderId: frozenGrader.graderId, graderVersion: "1", verdict: "pass", rawOutputArtifactId: raw.id,
    } }).grade;
    const humanGrade = store.appendRunEvaluationGrade({ evaluationId: e.id, now, grade: {
      id: `human-${index}`, graderType: "human", graderId: "self-claimed-human", graderVersion: "1", verdict: "pass", adjudicationStatus: "authenticated",
    } }).grade;
    manifestPayload.cases.push({ evaluationId: e.id, evaluationKey: e.idempotencyKey,
      modelGrade: gradeRef(modelGrade), humanGrade: gradeRef(humanGrade) });
  }
  const manifest = artifact("manifest", manifestPayload, "root");
  const input = { schemaVersion: 1, rootRunId: "root", manifestArtifact: ref(manifest) };
  const ports = () => Object.freeze({
    getRun: (id) => store.getRun(id), getArtifact: (id) => store.getArtifact(id),
    getRunEvaluation: (id) => store.getRunEvaluation(id),
    getRunEvaluationGrade: (id) => store.getRunEvaluationGrade(id),
  });
  return { cwd, database, artifact, input, ports, manifestPayload,
    get store() { return store; },
    reopen() { store.close(); store = createSqliteRunStore(cwd); },
    repin(payload, id = "manifest-changed", runId = "root") {
      return { ...input, manifestArtifact: ref(artifact(id, payload, runId)) };
    } };
}

function project(ports, input) {
  assert.equal(typeof feature?.projectStoredShadowPromotionReport, "function", "Storage bridge does not exist yet.");
  return feature.projectStoredShadowPromotionReport(ports, input);
}
const codes = (result) => result.diagnostics.map((item) => item.code);
const rejected = (ports, input, expectedCode) => {
  const result = project(ports, input);
  assert.equal(result.report, null);
  assert.equal(result.assessment, "not_assessed");
  assert.ok(codes(result).includes(expectedCode), JSON.stringify(result.diagnostics));
};
const override = (ports, key, change) => ({ ...ports, [key]: (id) => change(ports[key](id), id) });

test("FEATURE RED: bounded storage bridge is available", () => {
  assert.equal(typeof feature?.projectStoredShadowPromotionReport, "function");
});
test("real SQLite roundtrip preserves declared facts without minting human/repeat authority", async (t) => {
  const f = await fixture(t);
  f.reopen();
  // data_version observes commits from the separate Core store connection;
  // total_changes() on this observer would not detect writes by that connection.
  const version = f.database.prepare("PRAGMA data_version").get().data_version;
  const before = f.store.getRun("child");
  const result = project(f.ports(), f.input);
  assert.equal(result.assessment, "not_assessed");
  assert.equal(result.report.evidenceKind, "projected-evidence");
  assert.equal(result.report.authority, "report-only");
  assert.equal(result.report.enforcementAuthorized, false);
  assert.equal(result.report.humanEvidenceAuthenticated, false);
  assert.equal(result.report.uniqueCaseCount, 1);
  assert.equal(result.report.adjudicatedCaseCount, 0);
  assert.equal(result.report.independentObservationCount, 0);
  assert.equal(result.verifiedCaseCount, 1);
  assert.equal(result.declaredModelGradeCount, 1);
  assert.equal(result.declaredHumanGradeCount, 1);
  assert.equal(result.declaredObservationCount, 2);
  assert.deepEqual(result.declaredCosts.costAmountMicros, { knownCount: 2, missingCount: 0, sum: 6 });
  assert.ok(codes(result).includes("human_source_unavailable"));
  assert.ok(codes(result).includes("invocation_source_unavailable"));
  assert.deepEqual(f.store.getRun("child"), before);
  assert.equal(f.database.prepare("PRAGMA data_version").get().data_version, version);
  assert.equal(JSON.stringify(result).includes("claimedHuman"), false);
});
test("the same frozen corpus is deterministic after reopen and performs only exact reads", async (t) => {
  const f = await fixture(t);
  const first = project(f.ports(), f.input);
  f.reopen();
  const allowed = new Set(["getRun", "getRunEvaluation", "getRunEvaluationGrade", "getArtifact"]);
  const guarded = new Proxy(f.ports(), { get(target, key) {
    assert.ok(allowed.has(key), `Unexpected port ${String(key)}`); return target[key];
  } });
  assert.deepEqual(project(guarded, f.input), first);
});
test("missing model/human/repeat and money remain missing rather than manufactured", async (t) => {
  const f = await fixture(t, { human: false, model: false });
  const result = project(f.ports(), f.input);
  assert.equal(result.report.assessment, "not_assessed");
  assert.equal(result.declaredObservationCount, 0);
  assert.ok(codes(result).includes("model_grade_missing"));
  assert.ok(codes(result).includes("human_grade_missing"));
  const unknown = await fixture(t, { costs: false });
  assert.deepEqual(project(unknown.ports(), unknown.input).declaredCosts.costAmountMicros,
    { knownCount: 0, missingCount: 2, sum: null });
});
test("missing manifest, frozen artifact or corpus member never creates a partial report", async (t) => {
  const f = await fixture(t);
  for (const id of ["manifest", "frozen", "case", "model-raw", "observation-1"]) {
    const ports = override(f.ports(), "getArtifact", (value, foundId) => foundId === id ? undefined : value);
    rejected(ports, f.input, "artifact_missing");
  }
  rejected(override(f.ports(), "getRunEvaluation", () => undefined), f.input, "evaluation_missing");
  rejected(override(f.ports(), "getRunEvaluationGrade", () => undefined), f.input, "grade_missing");
});
test("root, sibling, candidate and manifest owners are checked against actual Run lineage", async (t) => {
  const f = await fixture(t);
  rejected(f.ports(), { ...f.input, rootRunId: "foreign" }, "artifact_invalid");
  for (const id of ["candidate", "model-raw", "observation-0"]) {
    rejected(override(f.ports(), "getArtifact", (value, foundId) => foundId === id ? { ...value, runId: "sibling" } : value),
      f.input, "artifact_invalid");
  }
  rejected(override(f.ports(), "getRun", (value, id) => id === "child" ? { ...value, parentRunId: "foreign" } : value),
    f.input, "lineage_invalid");
  rejected(override(f.ports(), "getRun", (value, id) => id === "root" ? { ...value, parentRunId: "child" } : value),
    f.input, "lineage_invalid");
});
test("completed evaluation and terminal Run are mandatory", async (t) => {
  const f = await fixture(t);
  rejected(override(f.ports(), "getRunEvaluation", (row) => ({ ...row, state: "grading" })), f.input, "evaluation_incomplete");
  rejected(override(f.ports(), "getRun", (row, id) => id === "child" ? { ...row, status: "running" } : row),
    f.input, "lineage_invalid");
});
test("artifact byte hash, expected manifest hash and canonical grade hash are separate", async (t) => {
  const f = await fixture(t);
  rejected(f.ports(), { ...f.input, manifestArtifact: { ...f.input.manifestArtifact, contentSha256: digest("other") } }, "artifact_invalid");
  rejected(override(f.ports(), "getArtifact", (row, id) => id === "candidate" ? { ...row, sealedPayload: { changed: true } } : row),
    f.input, "artifact_invalid");
  rejected(override(f.ports(), "getRunEvaluationGrade", (row) => ({ ...row, verdict: "fail" })), f.input, "grade_invalid");
});
test("stored same-version definition drift cannot change a pinned evaluation key", async (t) => {
  const f = await fixture(t);
  for (const field of ["suiteVersion", "caseDigest", "baselineVersion", "candidateArtifactId", "idempotencyKey"]) {
    rejected(override(f.ports(), "getRunEvaluation", (row) => ({ ...row, [field]: field.endsWith("Digest") ? digest("changed") : "changed" })),
      f.input, "evaluation_invalid");
  }
});
test("wrong grader identity, evaluation or grade manifest cannot be selected as latest", async (t) => {
  const f = await fixture(t);
  for (const field of ["evaluationId", "graderType", "graderVersion"]) {
    rejected(override(f.ports(), "getRunEvaluationGrade", (row) => ({ ...row, [field]: "other" })), f.input, "grade_invalid");
  }
  const payload = structuredClone(f.manifestPayload);
  payload.cases[0].modelGrade.gradeDigest = digest("other");
  rejected(f.ports(), f.repin(payload), "grade_invalid");
});
test("replayed evaluation or artifact references cannot inflate corpus or repeat counts", async (t) => {
  const f = await fixture(t);
  const payload = structuredClone(f.manifestPayload);
  payload.cases.push(structuredClone(payload.cases[0]));
  rejected(f.ports(), f.repin(payload), "manifest_invalid");
  const raw = f.store.getArtifact("model-raw");
  rejected(override(f.ports(), "getArtifact", (row, id) => {
    if (id !== "model-raw") return row;
    const sealedPayload = structuredClone(raw.sealedPayload);
    sealedPayload.observations[1] = sealedPayload.observations[0];
    return { ...row, sealedPayload, contentSha256: byteDigest(sealedPayload) };
  }), f.input, "artifact_invalid");
});
test("bound and accessor request inputs are rejected before any store access", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const ports = Object.fromEntries(Object.keys(f.ports()).map((key) => [key, () => { reads += 1; throw new Error("unexpected read"); }]));
  assert.throws(() => project(ports, { ...f.input, authenticated: true }), /input|field/u);
  const invalid = { ...f.input };
  Object.defineProperty(invalid, "rootRunId", { enumerable: true, get() { throw new Error("accessor invoked"); } });
  assert.throws(() => project(ports, invalid), /data property/u);
  assert.equal(reads, 0);
  const payload = structuredClone(f.manifestPayload);
  payload.cases = Array.from({ length: 501 }, () => structuredClone(payload.cases[0]));
  rejected(f.ports(), f.repin(payload), "manifest_invalid");
});
test("inherited optional manifest getter is refused without executing it", async (t) => {
  const f = await fixture(t, { model: false, human: false });
  let calls = 0;
  Object.defineProperty(Object.prototype, "modelGrade", { configurable: true, get() {
    calls += 1; throw new Error("untrusted optional getter executed");
  } });
  try {
    rejected(f.ports(), f.input, "manifest_invalid");
    assert.equal(calls, 0);
  } finally { delete Object.prototype.modelGrade; }
});
for (const identity of ["invocationId", "providerRequestId"]) {
  test(`renamed observation artifacts cannot disguise reused ${identity}`, async (t) => {
    const f = await fixture(t, { changeObservation(value) { value[identity] = "copied-identity"; return value; } });
    rejected(f.ports(), f.input, "observation_invalid");
  });
}
test("duplicate pinned observations and excess repeat count are refused, not truncated", async (t) => {
  const f = await fixture(t, { changeRaw(value) { value.observations[1] = value.observations[0]; return value; } });
  rejected(f.ports(), f.input, "observation_invalid");
  const large = await fixture(t, { observations: 65 });
  rejected(large.ports(), large.input, "observation_invalid");
});
test("observation source configuration/evaluation drift is refused", async (t) => {
  for (const field of ["frozenGraderDigest", "evaluationKey", "evaluationId"]) {
    const f = await fixture(t, { changeObservation(value) { value[field] = "changed"; return value; } });
    rejected(f.ports(), f.input, "observation_invalid");
  }
});
test("frozen grader and pinned repeat manifest cannot mix rubric/model versions", async (t) => {
  const f = await fixture(t, { changeFrozen(value) { value.modelVersion = "other-version"; return value; } });
  rejected(f.ports(), f.input, "frozen_invalid");
  const raw = await fixture(t, { changeRaw(value) { value.frozenGraderDigest = digest("other"); return value; } });
  rejected(raw.ports(), raw.input, "observation_invalid");
});
test("unsafe cost facts and aggregate overflow are refused; zero remains a known fact", async (t) => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const f = await fixture(t, { changeObservation(row) { row.costAmountMicros = value; return row; } });
    rejected(f.ports(), f.input, "observation_invalid");
  }
  const overflow = await fixture(t, { changeObservation(row) { row.costAmountMicros = Number.MAX_SAFE_INTEGER; return row; } });
  rejected(overflow.ports(), overflow.input, "observation_invalid");
  const zero = await fixture(t, { changeObservation(row) { row.costAmountMicros = 0; return row; } });
  assert.deepEqual(project(zero.ports(), zero.input).declaredCosts.costAmountMicros, { knownCount: 2, missingCount: 0, sum: 0 });
});
test("artifact processing bound and read errors produce sanitized diagnostics", async (t) => {
  const f = await fixture(t);
  const big = f.store.getArtifact("candidate");
  const payload = "x".repeat(1_048_577);
  rejected(override(f.ports(), "getArtifact", (row, id) => id === big.id ? { ...row, sealedPayload: payload, contentSha256: byteDigest(payload) } : row),
    f.input, "artifact_invalid");
  const result = project({ ...f.ports(), getRun() { throw new Error("SECRET provider/path/raw-value"); } }, f.input);
  assert.ok(codes(result).includes("read_failed"));
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});
test("end-of-read Run/evaluation drift invalidates the complete snapshot", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  rejected(override(f.ports(), "getRun", (row, id) => id === "child" && ++reads > 1 ? { ...row, status: "cancelled" } : row),
    f.input, "snapshot_changed");
  reads = 0;
  rejected(override(f.ports(), "getRunEvaluation", (row) => ++reads > 1 ? { ...row, revision: row.revision + 1 } : row),
    f.input, "snapshot_changed");
});
test("100 stored fabricated labels and 200 claimed calls never meet promotion thresholds", async (t) => {
  const f = await fixture(t, { caseCount: 100 });
  f.reopen();
  const result = project(f.ports(), f.input);
  assert.equal(result.assessment, "not_assessed");
  assert.equal(result.verifiedCaseCount, 100);
  assert.equal(result.declaredHumanGradeCount, 100);
  assert.equal(result.declaredObservationCount, 200);
  assert.equal(result.report.uniqueCaseCount, 100);
  assert.equal(result.report.assessment, "not_assessed");
  assert.equal(result.report.adjudicatedCaseCount, 0);
  assert.equal(result.report.independentObservationCount, 0);
  assert.equal(result.report.thresholdsSatisfied, false);
});
test("root owner is valid for definitions but never for candidate or observations", async (t) => {
  const f = await fixture(t);
  assert.equal(project(f.ports(), f.input).verifiedCaseCount, 1);
  for (const id of ["candidate", "observation-0"]) {
    rejected(override(f.ports(), "getArtifact", (row, foundId) => foundId === id ? { ...row, runId: "root" } : row),
      f.input, "artifact_invalid");
  }
});
test("payload and stored hash changed together cannot bypass an external byte pin", async (t) => {
  const f = await fixture(t);
  const payload = { altered: true };
  rejected(override(f.ports(), "getArtifact", (row, id) => id === "candidate"
    ? { ...row, sealedPayload: payload, contentSha256: byteDigest(payload) } : row), f.input, "artifact_invalid");
});
test("artifact ending reread drift or removal clears every partial counter", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const result = project(override(f.ports(), "getArtifact", (row, id) => id === "observation-0" && ++reads > 1 ? undefined : row), f.input);
  assert.equal(result.report, null);
  assert.equal(result.verifiedCaseCount, 0);
  assert.equal(result.declaredHumanGradeCount, 0);
  assert.equal(result.declaredModelGradeCount, 0);
  assert.equal(result.declaredObservationCount, 0);
  assert.deepEqual(result.declaredCosts.costAmountMicros, { knownCount: 0, missingCount: 0, sum: null });
  assert.ok(codes(result).includes("snapshot_changed"));
});
