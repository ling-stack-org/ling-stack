import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, digestRunEvaluationGrade, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-10-08T00:00:00.000Z";
const later = "2026-10-08T00:01:00.000Z";
const expires = "2026-10-08T00:10:00.000Z";

// Real SQLite storage, synthetic grader/actor facts; no provider or human authentication.
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-grade-getter-"));
  const f = { cwd, store: createSqliteRunStore(cwd), database: undefined };
  t.after(async () => {
    try { f.database?.close(); } catch {}
    try { f.store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  f.database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  const channel = f.store.createChannel({ name: "Grade getter", boundPath: cwd }, now);
  f.task = f.store.createTask({ channelId: channel.id, title: "Grade getter", prompt: "synthetic" }, now);
  f.run = f.store.createRun({
    id: "grade-getter-run", cwd, taskId: f.task.id, providerName: "synthetic", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  f.store.markRunSucceeded(f.run.id, now);
  const artifact = (id, payload) => f.store.createArtifact({
    id, runId: f.run.id, type: "json", path: `.ling-stack/evaluations/${id}.json`,
    sealedPayload: payload, createdAt: now,
  });
  const suite = artifact("grade-getter-suite", { id: "suite", version: "1" });
  const testCase = artifact("grade-getter-case", { id: "case", version: "1" });
  const baseline = artifact("grade-getter-baseline", { answer: "ok" });
  const candidate = artifact("grade-getter-candidate", { answer: "ok" });
  f.rationale = artifact("grade-getter-rationale", { reason: "synthetic" });
  f.raw = artifact("grade-getter-raw", { output: "synthetic" });
  f.enqueue = {
    id: "grade-getter-evaluation", runId: f.run.id,
    suiteId: "suite", suiteVersion: "1", suiteArtifactId: suite.id,
    caseId: "case", caseVersion: "1", caseArtifactId: testCase.id,
    baselineId: "baseline", baselineVersion: "1", baselineArtifactId: baseline.id,
    candidateArtifactId: candidate.id, now,
  };
  f.evaluation = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  assert.equal(f.store.claimRunEvaluation({
    evaluationId: f.evaluation.id, expectedRevision: 0, claimOwner: "synthetic-worker",
    claimToken: "synthetic-claim", claimExpiresAt: expires, now,
  }).ok, true);
  assert.equal(f.store.startRunEvaluation({
    evaluationId: f.evaluation.id, expectedRevision: 1, claimOwner: "synthetic-worker",
    claimToken: "synthetic-claim", now,
  }).ok, true);
  assert.equal(f.store.completeRunEvaluation({
    evaluationId: f.evaluation.id, expectedRevision: 2, claimOwner: "synthetic-worker",
    claimToken: "synthetic-claim", now,
    grade: { id: "grade-getter-rule", graderType: "rule", graderId: "synthetic-rule", graderVersion: "1", verdict: "pass" },
  }).ok, true);
  return f;
}

function grade(f, graderType, changes = {}) {
  return {
    id: `grade-getter-${graderType}`, graderType, graderId: "synthetic-grader", graderVersion: "1",
    verdict: "pass", score: 0.75, severity: "info", rationaleArtifactId: f.rationale.id,
    rawOutputArtifactId: f.raw.id, costInputTokens: 101, costOutputTokens: 202,
    costAmountMicros: 303, latencyMs: 404,
    adjudicationStatus: graderType === "human" ? "synthetic-final-label" : "shadow",
    ...changes,
  };
}

function append(f, input, timestamp = now) {
  return f.store.appendRunEvaluationGrade({ evaluationId: f.evaluation.id, grade: input, now: timestamp });
}

test("public exact grade getter reads rule/missing IDs without listing or mutating state", async (t) => {
  const f = await fixture(t);
  const beforeRun = f.store.getRun(f.run.id);
  const beforeEvaluation = f.store.getRunEvaluation(f.evaluation.id);
  f.store.listRunEvaluationGrades = () => { throw new Error("Unbounded list is forbidden in exact reads."); };
  assert.equal(typeof f.store.getRunEvaluationGrade, "function");
  const result = f.store.getRunEvaluationGrade("grade-getter-rule");
  assert.equal(result.graderType, "rule");
  assert.equal(result.evaluationId, f.evaluation.id);
  assert.equal(f.store.getRunEvaluationGrade("missing-grade"), undefined);
  assert.equal(f.store.getRunEvaluationGrade("grade-getter-rule' OR 1=1 --"), undefined);
  assert.deepEqual(f.store.getRun(f.run.id), beforeRun);
  assert.deepEqual(f.store.getRunEvaluation(f.evaluation.id), beforeEvaluation);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM run_evaluation_grades").get().count, 1);
});

for (const graderType of ["model", "human"]) {
  test(`real SQLite ${graderType} append/getter preserves artifact, cost, latency, status and digest`, async (t) => {
    const f = await fixture(t);
    const input = grade(f, graderType);
    const beforeRun = f.store.getRun(f.run.id);
    const beforeEvaluation = f.store.getRunEvaluation(f.evaluation.id);
    const appended = append(f, input);
    assert.equal(appended.ok, true);
    assert.equal(appended.replayed, false);
    const read = f.store.getRunEvaluationGrade(input.id);
    assert.deepEqual(read, appended.grade);
    for (const [field, value] of Object.entries(input)) assert.equal(read[field], value);
    assert.equal(read.gradeDigest, digestRunEvaluationGrade(f.evaluation.id, input));
    assert.equal(read.createdAt, now);
    assert.equal(f.store.getArtifact(read.rationaleArtifactId).sealedPayload.reason, "synthetic");
    assert.equal(f.store.getArtifact(read.rawOutputArtifactId).sealedPayload.output, "synthetic");
    assert.deepEqual(f.store.getRun(f.run.id), beforeRun);
    assert.deepEqual(f.store.getRunEvaluation(f.evaluation.id), beforeEvaluation);
  });
}

test("model and human identities remain separate and replays retain original row IDs/times", async (t) => {
  const f = await fixture(t);
  for (const graderType of ["model", "human"]) {
    const input = grade(f, graderType);
    const first = append(f, input);
    const replay = append(f, { ...input, id: `${input.id}-replay` }, later);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.grade, first.grade);
    assert.deepEqual(f.store.getRunEvaluationGrade(input.id), first.grade);
    assert.equal(f.store.getRunEvaluationGrade(`${input.id}-replay`), undefined);
  }
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM run_evaluation_grades").get().count, 3);
});

test("same-version changed immutable facts conflict and getter retains the original grade", async (t) => {
  const f = await fixture(t);
  for (const graderType of ["model", "human"]) {
    const input = grade(f, graderType);
    const original = append(f, input).grade;
    for (const change of [
      { verdict: "fail" }, { score: 0.5 }, { severity: "critical" },
      { rationaleArtifactId: f.raw.id }, { rawOutputArtifactId: f.rationale.id },
      { costInputTokens: 102 }, { costOutputTokens: 203 }, { costAmountMicros: 304 },
      { latencyMs: 405 }, { adjudicationStatus: "changed-status" },
    ]) {
      const conflict = append(f, { ...input, ...change, id: `${input.id}-conflict` }, later);
      assert.deepEqual(conflict, { ok: false, code: "grade_conflict" });
      assert.deepEqual(f.store.getRunEvaluationGrade(input.id), original);
      assert.equal(f.store.getRunEvaluationGrade(`${input.id}-conflict`), undefined);
    }
  }
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM run_evaluation_grades").get().count, 3);
});

test("getter rejects invalid identity values and accepts the existing 500-character boundary", async (t) => {
  const f = await fixture(t);
  for (const id of [undefined, null, 1, {}, [], "", " ", " leading", "trailing ", "x".repeat(501)]) {
    assert.throws(() => f.store.getRunEvaluationGrade(id), /grade id is invalid/u);
  }
  const input = grade(f, "model", { id: "x".repeat(500) });
  const result = append(f, input);
  assert.equal(result.ok, true);
  assert.deepEqual(f.store.getRunEvaluationGrade(input.id), result.grade);
});

test("getter survives store reopen without manufacturing zero optional facts", async (t) => {
  const f = await fixture(t);
  const input = { id: "grade-with-missing-facts", graderType: "model", graderId: "minimal", graderVersion: "1", verdict: "abstain" };
  const before = append(f, input).grade;
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  const after = f.store.getRunEvaluationGrade(input.id);
  assert.deepEqual(after, before);
  for (const field of ["score", "severity", "rationaleArtifactId", "rawOutputArtifactId", "costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs", "adjudicationStatus"]) {
    assert.equal(after[field], undefined);
  }
});

test("model/human append still rejects unsealed or foreign-run evidence and leaves no row", async (t) => {
  const f = await fixture(t);
  const unsealed = f.store.createArtifact({ id: "unsealed-evidence", runId: f.run.id, type: "json", path: "unsealed.json", createdAt: now });
  const foreign = f.store.createRun({
    id: "foreign-run", cwd: f.cwd, taskId: f.task.id, providerName: "synthetic", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  const foreignArtifact = f.store.createArtifact({
    id: "foreign-evidence", runId: foreign.id, type: "json", path: "foreign.json", sealedPayload: { synthetic: true }, createdAt: now,
  });
  for (const graderType of ["model", "human"]) {
    for (const evidence of [unsealed, foreignArtifact]) {
      const input = grade(f, graderType, { rationaleArtifactId: evidence.id });
      assert.throws(() => append(f, input), (error) => error.code === "evaluation.artifact_invalid");
      assert.equal(f.store.getRunEvaluationGrade(input.id), undefined);
    }
  }
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM run_evaluation_grades").get().count, 1);
});

test("append to queued or missing evaluations remains forbidden and getter creates no grade", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation({ ...f.enqueue, id: "queued-evaluation", caseVersion: "2" }).evaluation;
  for (const [evaluationId, code] of [[queued.id, "invalid_transition"], ["missing-evaluation", "not_found"]]) {
    const input = grade(f, "human");
    assert.deepEqual(f.store.appendRunEvaluationGrade({ evaluationId, grade: input, now }), { ok: false, code });
    assert.equal(f.store.getRunEvaluationGrade(input.id), undefined);
  }
  assert.equal(f.store.getRunEvaluation(queued.id).state, "queued");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM run_evaluation_grades").get().count, 1);
});

test("model/human invalid cost facts still fail before insertion", async (t) => {
  const f = await fixture(t);
  for (const graderType of ["model", "human"]) {
    for (const field of ["costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"]) {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const input = grade(f, graderType, { [field]: value });
        assert.throws(() => append(f, input), /non-negative safe integer/u);
        assert.equal(f.store.getRunEvaluationGrade(input.id), undefined);
      }
    }
  }
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM run_evaluation_grades").get().count, 1);
});

test("sealed artifact payload drift still rejects model/human append without a row", async (t) => {
  const f = await fixture(t);
  f.database.prepare("UPDATE artifacts SET sealed_payload_json = ? WHERE id = ?")
    .run(JSON.stringify({ reason: "changed after sealing" }), f.rationale.id);
  for (const graderType of ["model", "human"]) {
    const input = grade(f, graderType);
    assert.throws(() => append(f, input), (error) => error.code === "evaluation.artifact_invalid");
    assert.equal(f.store.getRunEvaluationGrade(input.id), undefined);
  }
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM run_evaluation_grades").get().count, 1);
});

test("public identity validation does not silently change legacy empty-ID append behavior", async (t) => {
  const f = await fixture(t);
  const input = grade(f, "model", { id: "" });
  const appended = append(f, input);
  assert.equal(appended.ok, true); // Known legacy write boundary, deliberately not fixed here.
  assert.equal(appended.grade.id, "");
  assert.equal(f.database.prepare("SELECT id FROM run_evaluation_grades WHERE id = ?").get("").id, "");
  assert.throws(() => f.store.getRunEvaluationGrade(""), /grade id is invalid/u);
});
