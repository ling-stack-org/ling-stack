import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  FrameworkAssuranceBudgetEvidence,
  FrameworkAssuranceLifecycleEvidence,
  RunnerContinuationV1,
  RunEvaluationGradeV1,
  RunEvaluationV1,
} from "@ling-stack/contracts";
import type {
  DelegationBudgetCharge,
  DelegationCompletionEvidenceV1,
  RunSession,
  RunStore,
  WorkUnit,
  WorkUnitAttempt,
} from "@ling-stack/core";
import {
  projectEvaluationEvidence,
  projectPolicyEvidence,
  projectRecoveryEvidence,
} from "../dist/features/runs/assurance-evidence.js";
import { runtimeRunQueueFixture } from "../../core/test/support/runtime-run-queue-fixture.ts";

const runId = "run-assurance-extended";
const workUnitId = "work-unit-assurance-extended";
const sourceAttemptId = "attempt-assurance-source";
const targetAttemptId = "attempt-assurance-target";

function recoveryFixture() {
  const source = { id: sourceAttemptId, attemptNumber: 1, runtimeInstanceId: "runtime-source", status: "lost" } as unknown as WorkUnitAttempt;
  const target = { id: targetAttemptId, attemptNumber: 2, runtimeInstanceId: "runtime-target", status: "succeeded" } as unknown as WorkUnitAttempt;
  const workUnit = { id: workUnitId, linkedRunId: runId, activeAttemptId: targetAttemptId } as unknown as WorkUnit;
  const lifecycle = { currentAttemptId: targetAttemptId } as unknown as FrameworkAssuranceLifecycleEvidence;
  const sourceStop = { attemptId: sourceAttemptId, localExecution: "drained" as const, effects: "settled" as const };
  const targetStop = { attemptId: targetAttemptId, localExecution: "drained" as const, effects: "settled" as const };
  const continuation = {
    schemaVersion: 1,
    id: "continuation-assurance-1",
    runId,
    workUnitId,
    sourceAttemptId,
    targetAttemptId,
    origin: "daemon_recovery",
    state: "succeeded",
    generation: 2,
    revision: 1,
  } as unknown as RunnerContinuationV1;
  const store = {
    listRunnerContinuations: () => [continuation],
  } as unknown as RunStore;
  return { source, target, workUnit, lifecycle, sourceStop, targetStop, continuation, store };
}

test("recovery evidence verifies a drained source, one daemon continuation and the current target", () => {
  const f = recoveryFixture();
  const evidence = projectRecoveryEvidence(f.store, f.workUnit, [f.source, f.target], [f.sourceStop, f.targetStop], f.lifecycle);
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.source?.attemptId, sourceAttemptId);
  assert.equal(evidence.target?.attemptId, targetAttemptId);
  assert.equal(evidence.continuation?.continuationId, f.continuation.id);
  assert.deepEqual(evidence.blockers, []);
});

test("recovery evidence blocks missing continuation and unconfirmed source stop", () => {
  const f = recoveryFixture();
  const missing = {
    ...f.store,
    listRunnerContinuations: () => [],
  } as unknown as RunStore;
  const missingEvidence = projectRecoveryEvidence(missing, f.workUnit, [f.source, f.target], [f.sourceStop, f.targetStop], f.lifecycle);
  assert.equal(missingEvidence.status, "blocked");
  assert.ok(missingEvidence.blockers.includes("recovery.continuation_missing"));

  const drainingEvidence = projectRecoveryEvidence(f.store, f.workUnit, [f.source, f.target], [
    { ...f.sourceStop, localExecution: "draining" }, f.targetStop,
  ], f.lifecycle);
  assert.equal(drainingEvidence.status, "blocked");
  assert.ok(drainingEvidence.blockers.includes("recovery.source_not_drained"));
});

test("recovery evidence detects duplicate dispatches for one source across generations", () => {
  const f = recoveryFixture();
  const duplicate = { ...f.continuation, id: "continuation-assurance-2", generation: 3 } as RunnerContinuationV1;
  const store = { listRunnerContinuations: () => [f.continuation, duplicate] } as unknown as RunStore;
  const evidence = projectRecoveryEvidence(store, f.workUnit, [f.source, f.target], [f.sourceStop, f.targetStop], f.lifecycle);
  assert.equal(evidence.status, "blocked");
  assert.equal(evidence.duplicateDispatch.status, "detected");
  assert.ok(evidence.blockers.includes("recovery.duplicate_dispatch"));
});

test("policy evidence distinguishes current, drifted, missing and unavailable snapshots", async (t: TestContext) => {
  const f = await runtimeRunQueueFixture(t);
  const prepared = f.prepare("assurance-policy");
  const current = projectPolicyEvidence(f.store, prepared.run);
  assert.equal(current.status, "current");
  assert.equal(current.stored.fingerprint, current.current.fingerprint);

  f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, "2026-11-12T08:00:01.000Z");
  const drifted = projectPolicyEvidence(f.store, prepared.run);
  assert.equal(drifted.status, "drifted");
  assert.ok(drifted.blockers.includes("policy.snapshot_drift"));

  const missingRun = {
    ...prepared.run,
    requestSnapshot: { ...(prepared.run.requestSnapshot as Record<string, unknown>), effectivePolicySnapshot: undefined },
  } as RunSession;
  const missing = projectPolicyEvidence(f.store, missingRun);
  assert.equal(missing.status, "missing");
  assert.ok(missing.blockers.includes("policy.stored_snapshot_missing"));

  const unavailableStore = { getApprovalPolicy: () => { throw new Error("policy_unavailable"); } } as unknown as RunStore;
  const unavailable = projectPolicyEvidence(unavailableStore, prepared.run);
  assert.equal(unavailable.status, "unavailable");
  assert.ok(unavailable.blockers.includes("policy.current_snapshot_unavailable"));
});

function evaluationFixture(options: {
  readonly charges?: readonly DelegationBudgetCharge[];
  readonly rootBudget?: boolean;
  readonly grade?: Partial<RunEvaluationGradeV1>;
  readonly budgetStatus?: FrameworkAssuranceBudgetEvidence["status"];
} = {}) {
  const charge: DelegationBudgetCharge = {
    id: "charge-assurance-evaluation-1",
    rootRunId: runId,
    runId,
    attemptId: targetAttemptId,
    invocationId: "invocation-assurance-evaluation-1",
    requestDigest: "request-digest",
    state: "measured",
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    actualCostMicros: 20,
    idempotencyKey: "charge-assurance-1",
    revision: 1,
    createdAt: "2026-11-12T08:00:00.000Z",
    updatedAt: "2026-11-12T08:00:01.000Z",
  };
  const evaluation = {
    schemaVersion: 1,
    id: "evaluation-assurance-1",
    rootRunId: runId,
    runId,
    suiteId: "suite-assurance",
    suiteVersion: "1",
    suiteArtifactId: "artifact-suite",
    suiteDigest: "a".repeat(64),
    caseId: "case-assurance",
    caseVersion: "1",
    caseArtifactId: "artifact-case",
    caseDigest: "b".repeat(64),
    baselineId: "baseline-assurance",
    baselineVersion: "1",
    baselineArtifactId: "artifact-baseline",
    baselineDigest: "c".repeat(64),
    candidateArtifactId: "artifact-candidate",
    candidateDigest: "d".repeat(64),
    idempotencyKey: "eval-a",
    state: "completed",
    revision: 2,
    createdAt: "2026-11-12T08:00:00.000Z",
    updatedAt: "2026-11-12T08:00:01.000Z",
  } as RunEvaluationV1;
  const grade = {
    schemaVersion: 1,
    id: "grade-assurance-1",
    evaluationId: evaluation.id,
    graderType: "model",
    graderId: "fixture-grader",
    graderVersion: "1",
    verdict: "pass",
    score: 1,
    gradeDigest: "e".repeat(64),
    costInputTokens: 10,
    costOutputTokens: 5,
    costAmountMicros: 20,
    ...options.grade,
  } as RunEvaluationGradeV1;
  const charges = options.charges ?? [charge];
  const completion = {
    schemaVersion: 1,
    rootRunIds: [runId],
    roots: [{ runId, ...(options.rootBudget === false ? {} : { budget: { tokenBudget: 100, costBudgetMicros: 100 } }), charges }],
    steps: [],
    issues: [],
    status: "satisfied",
    fingerprint: "completion-assurance-evaluation",
  } as unknown as DelegationCompletionEvidenceV1;
  const budget = { status: options.budgetStatus ?? "within" } as FrameworkAssuranceBudgetEvidence;
  const store = {
    listRunEvaluations: () => [evaluation],
    listRunEvaluationGrades: () => [grade],
  } as unknown as RunStore;
  const run = { id: runId } as RunSession;
  return { charge, evaluation, grade, completion, budget, store, run };
}

test("evaluation evidence verifies a grade against the measured Provider charge", () => {
  const f = evaluationFixture();
  const evidence = projectEvaluationEvidence(f.store, f.run, f.completion, f.budget);
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.grades[0]?.chargeMatch, "matched");
  assert.equal(evidence.grades[0]?.chargeId, f.charge.id);
});

test("evaluation evidence blocks missing budget, charge, token or cost matches", () => {
  const missingBudget = evaluationFixture({ rootBudget: false, budgetStatus: "missing" });
  const budgetEvidence = projectEvaluationEvidence(missingBudget.store, missingBudget.run, missingBudget.completion, missingBudget.budget);
  assert.equal(budgetEvidence.status, "blocked");
  assert.ok(budgetEvidence.blockers.includes("evaluation.budget_missing"));

  const missingCharge = evaluationFixture({ charges: [] });
  const chargeEvidence = projectEvaluationEvidence(missingCharge.store, missingCharge.run, missingCharge.completion, missingCharge.budget);
  assert.equal(chargeEvidence.status, "blocked");
  assert.equal(chargeEvidence.grades[0]?.chargeMatch, "missing");
  assert.ok(chargeEvidence.blockers.includes("evaluation.charge_missing"));

  const mismatchCharge = evaluationFixture({ charges: [{ ...evaluationFixture().charge, inputTokens: 11 }] });
  const mismatchEvidence = projectEvaluationEvidence(mismatchCharge.store, mismatchCharge.run, mismatchCharge.completion, mismatchCharge.budget);
  assert.equal(mismatchEvidence.status, "blocked");
  assert.equal(mismatchEvidence.grades[0]?.chargeMatch, "mismatch");
  assert.ok(mismatchEvidence.blockers.includes("evaluation.charge_cost_mismatch"));
});

test("evaluation evidence blocks non-unique charges and grade lineage drift", () => {
  const base = evaluationFixture();
  const duplicate = evaluationFixture({ charges: [base.charge, { ...base.charge, id: "charge-assurance-2", idempotencyKey: "charge-assurance-2" }] });
  const duplicateEvidence = projectEvaluationEvidence(duplicate.store, duplicate.run, duplicate.completion, duplicate.budget);
  assert.equal(duplicateEvidence.status, "blocked");
  assert.equal(duplicateEvidence.grades[0]?.chargeMatch, "non_unique");
  assert.ok(duplicateEvidence.blockers.includes("evaluation.charge_association_non_unique"));

  const foreignGrade = evaluationFixture({ grade: { evaluationId: "evaluation-foreign" } });
  const foreignEvidence = projectEvaluationEvidence(foreignGrade.store, foreignGrade.run, foreignGrade.completion, foreignGrade.budget);
  assert.equal(foreignEvidence.status, "blocked");
  assert.equal(foreignEvidence.grades[0]?.chargeMatch, "mismatch");
  assert.ok(foreignEvidence.blockers.includes("evaluation.grade_lineage_mismatch"));
});
