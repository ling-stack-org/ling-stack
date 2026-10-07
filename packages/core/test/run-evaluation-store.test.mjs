import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-09-14T00:00:00.000Z";
const later = "2026-09-14T00:01:00.000Z";
const expiredAt = "2026-09-14T00:02:00.000Z";
const afterExpiry = "2026-09-14T00:03:00.000Z";
const nextExpiry = "2026-09-14T00:05:00.000Z";

async function fixture(t, terminal = true) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-store-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    try { database.close(); } catch {}
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "Evaluation", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Evaluate", prompt: "grade" }, now);
  const run = store.createRun({
    id: "run-evaluation-1",
    cwd,
    taskId: task.id,
    providerName: "test",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    createdAt: now,
  });
  if (terminal) store.markRunSucceeded(run.id, now);
  const suite = store.createArtifact({
    id: "artifact-evaluation-suite",
    runId: run.id,
    type: "json",
    path: ".ling-stack/evaluations/suite.json",
    sealedPayload: { id: "suite-json", version: "1", cases: ["case-json"] },
    createdAt: now,
  });
  const testCase = store.createArtifact({
    id: "artifact-evaluation-case",
    runId: run.id,
    type: "json",
    path: ".ling-stack/evaluations/case.json",
    sealedPayload: {
      schemaVersion: 1,
      kind: "deterministic_json_rule",
      graderId: "json-contract",
      graderVersion: "1",
      failureSeverity: "error",
      assertions: [{ type: "deep_equal" }],
    },
    createdAt: now,
  });
  const baseline = store.createArtifact({
    id: "artifact-evaluation-baseline",
    runId: run.id,
    type: "json",
    path: ".ling-stack/evaluations/baseline.json",
    sealedPayload: { status: "ok", count: 2 },
    createdAt: now,
  });
  const candidate = store.createArtifact({
    id: "artifact-evaluation-candidate",
    runId: run.id,
    type: "json",
    path: ".ling-stack/evaluations/candidate.json",
    sealedPayload: { count: 2, status: "ok" },
    createdAt: now,
  });
  const enqueue = {
    id: "evaluation-1",
    runId: run.id,
    suiteId: "suite-json",
    suiteVersion: "1",
    suiteArtifactId: suite.id,
    caseId: "case-json",
    caseVersion: "1",
    caseArtifactId: testCase.id,
    baselineId: "baseline-json",
    baselineVersion: "1",
    baselineArtifactId: baseline.id,
    candidateArtifactId: candidate.id,
    now,
  };
  return { cwd, store, database, run, suite, testCase, baseline, candidate, enqueue };
}

test("terminal evaluation enqueue binds sealed artifact digests and replays the complete identity", async (t) => {
  const f = await fixture(t);
  const first = f.store.enqueueRunEvaluation(f.enqueue);
  const replay = f.store.enqueueRunEvaluation(f.enqueue);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.evaluation.id, first.evaluation.id);
  assert.equal(first.evaluation.suiteDigest, f.suite.contentSha256);
  assert.equal(first.evaluation.caseDigest, f.testCase.contentSha256);
  assert.equal(first.evaluation.baselineDigest, f.baseline.contentSha256);
  assert.equal(first.evaluation.candidateDigest, f.candidate.contentSha256);
  assert.match(first.evaluation.idempotencyKey, /^run-evaluation:/u);
  assert.equal(f.store.listRunEvaluations({ runId: f.run.id }).length, 1);

  assert.throws(() => f.database.prepare(
    "UPDATE run_evaluations SET state='claimed' WHERE id=?",
  ).run(first.evaluation.id), /CHECK constraint failed/u);

  assert.throws(() => f.database.prepare(
    "UPDATE run_evaluations SET case_version='2' WHERE id=?",
  ).run(first.evaluation.id), /identity is immutable/u);
});

test("a non-terminal run or unsealed cross-run artifact cannot enter the evaluation queue", async (t) => {
  const f = await fixture(t, false);
  assert.throws(() => f.store.enqueueRunEvaluation(f.enqueue), hasCode("evaluation.lineage_invalid"));
  f.store.markRunSucceeded(f.run.id, later);
  const unsealed = f.store.createArtifact({
    id: "artifact-unsealed",
    runId: f.run.id,
    type: "json",
    path: "unsealed.json",
    createdAt: later,
  });
  assert.throws(() => f.store.enqueueRunEvaluation({
    ...f.enqueue,
    candidateArtifactId: unsealed.id,
    id: "evaluation-unsealed",
  }), hasCode("evaluation.artifact_invalid"));
  assert.throws(() => f.store.enqueueRunEvaluation({
    ...f.enqueue,
    id: "evaluation-bad-time",
    now: "2026-09-14 00:00:00",
  }), /canonical UTC/u);
});

test("claim, start, and completion atomically append one immutable grade", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  const claimed = f.store.claimRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 0,
    claimOwner: "evaluation-worker",
    claimToken: "claim-1",
    claimExpiresAt: nextExpiry,
    now: later,
  });
  assert.equal(claimed.ok, true);
  const grading = f.store.startRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 1,
    claimOwner: "evaluation-worker",
    claimToken: "claim-1",
    now: later,
  });
  assert.equal(grading.ok, true);
  const unsealedRationale = f.store.createArtifact({
    id: "artifact-unsealed-rationale",
    runId: f.run.id,
    type: "json",
    path: "evaluation/unsealed-rationale.json",
    createdAt: later,
  });
  assert.throws(() => f.store.completeRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 2,
    claimOwner: "evaluation-worker",
    claimToken: "claim-1",
    grade: {
      graderType: "rule",
      graderId: "json-contract",
      graderVersion: "1",
      verdict: "pass",
      rationaleArtifactId: unsealedRationale.id,
    },
    now: later,
  }), hasCode("evaluation.artifact_invalid"));
  assert.equal(f.store.getRunEvaluation(queued.id).state, "grading");
  assert.equal(f.store.listRunEvaluationGrades(queued.id).length, 0);
  const completed = f.store.completeRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 2,
    claimOwner: "evaluation-worker",
    claimToken: "claim-1",
    grade: {
      id: "grade-1",
      graderType: "rule",
      graderId: "json-contract",
      graderVersion: "1",
      verdict: "pass",
      score: 1,
      latencyMs: 3,
    },
    now: later,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.evaluation.state, "completed");
  assert.equal(f.store.listRunEvaluationGrades(queued.id).length, 1);
  assert.throws(() => f.database.prepare(
    "UPDATE run_evaluation_grades SET verdict='fail' WHERE id='grade-1'",
  ).run(), /append-only/u);
  assert.throws(() => f.database.prepare(
    "DELETE FROM run_evaluation_grades WHERE id='grade-1'",
  ).run(), /append-only/u);
});

test("expired grading lease is reclaimed without duplicating the append-only grade", async (t) => {
  const f = await fixture(t);
  const queued = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  assert.equal(f.store.claimRunEvaluation({
    evaluationId: queued.id, expectedRevision: 0, claimOwner: "old-worker", claimToken: "old-token",
    claimExpiresAt: expiredAt, now: later,
  }).ok, true);
  assert.equal(f.store.startRunEvaluation({
    evaluationId: queued.id, expectedRevision: 1, claimOwner: "old-worker", claimToken: "old-token", now: later,
  }).ok, true);
  assert.equal(f.store.listClaimableRunEvaluations({ now: afterExpiry }).map((item) => item.id).includes(queued.id), true);
  const reclaimed = f.store.claimRunEvaluation({
    evaluationId: queued.id, expectedRevision: 2, claimOwner: "new-worker", claimToken: "new-token",
    claimExpiresAt: nextExpiry, now: afterExpiry,
  });
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.value.failureCode, "evaluation.lease_expired");
  assert.equal(f.store.startRunEvaluation({
    evaluationId: queued.id, expectedRevision: 3, claimOwner: "new-worker", claimToken: "new-token", now: afterExpiry,
  }).ok, true);
  assert.deepEqual(f.store.failRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 2,
    claimOwner: "old-worker",
    claimToken: "old-token",
    failureCode: "evaluation.result_invalid",
    now: afterExpiry,
  }), { ok: false, code: "lease_mismatch" });
  assert.deepEqual(f.store.requeueRunEvaluation({
    evaluationId: queued.id,
    expectedRevision: 2,
    claimOwner: "old-worker",
    claimToken: "old-token",
    failureCode: "evaluation.grader_unavailable",
    nextAttemptAt: nextExpiry,
    now: afterExpiry,
  }), { ok: false, code: "lease_mismatch" });
  const input = {
    evaluationId: queued.id,
    expectedRevision: 4,
    claimOwner: "new-worker",
    claimToken: "new-token",
    grade: {
      id: "grade-recovered",
      graderType: "rule",
      graderId: "json-contract",
      graderVersion: "1",
      verdict: "pass",
      score: 1,
    },
    now: afterExpiry,
  };
  const completed = f.store.completeRunEvaluation(input);
  const replay = f.store.completeRunEvaluation(input);
  assert.equal(completed.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(f.store.listRunEvaluationGrades(queued.id).length, 1);

  const conflict = f.store.appendRunEvaluationGrade({
    evaluationId: queued.id,
    grade: { ...input.grade, id: "grade-conflict", verdict: "fail" },
    now: afterExpiry,
  });
  assert.deepEqual(conflict, { ok: false, code: "grade_conflict" });
});

test("new suite, case, baseline, or grader versions append history instead of rewriting it", async (t) => {
  const f = await fixture(t);
  const original = f.store.enqueueRunEvaluation(f.enqueue).evaluation;
  const suiteV2 = f.store.createArtifact({
    id: "artifact-evaluation-suite-v2",
    runId: f.run.id,
    type: "json",
    path: ".ling-stack/evaluations/suite-v2.json",
    sealedPayload: { id: "suite-json", version: "2", cases: ["case-json"] },
    createdAt: later,
  });
  const next = f.store.enqueueRunEvaluation({
    ...f.enqueue,
    id: "evaluation-2",
    suiteVersion: "2",
    suiteArtifactId: suiteV2.id,
    now: later,
  }).evaluation;
  assert.notEqual(next.idempotencyKey, original.idempotencyKey);
  assert.equal(f.store.getRunEvaluation(original.id).suiteVersion, "1");
  assert.equal(f.store.getRunEvaluation(next.id).suiteVersion, "2");
});

function hasCode(code) {
  return (error) => error?.code === code;
}
