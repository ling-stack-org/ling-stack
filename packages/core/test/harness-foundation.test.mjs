import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertDelegationBudgetSubset,
  assertNonNegativeSafeInteger,
  delegationIdempotencyKey,
  digestRunEvaluationValue,
  gradeDeterministicRunEvaluation,
  harnessToolExecutionIdempotencyKey,
  isHarnessLeaseClaimable,
  isUniqueStringSubset,
  runEvaluationIdempotencyKey,
  runnerContinuationIdempotencyKey,
  transitionDelegationStep,
  transitionHarnessToolExecution,
  transitionRunEvaluation,
  transitionRunnerContinuation,
} from "../dist/index.js";

const createdAt = "2026-09-13T00:00:00.000Z";
const later = "2026-09-13T00:01:00.000Z";

test("runner continuations enforce CAS, legal transitions, and terminal states", () => {
  const requested = continuation();
  const prepared = transitionRunnerContinuation({
    current: requested,
    expectedRevision: 0,
    nextState: "prepared",
    now: later,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.value.state, "prepared");
  assert.equal(prepared.value.revision, 1);
  assert.equal(prepared.value.updatedAt, later);

  assert.deepEqual(transitionRunnerContinuation({
    current: requested,
    expectedRevision: 9,
    nextState: "prepared",
    now: later,
  }), { ok: false, code: "stale_revision" });
  assert.deepEqual(transitionRunnerContinuation({
    current: requested,
    expectedRevision: 0,
    nextState: "running",
    now: later,
  }), { ok: false, code: "invalid_transition" });

  const succeeded = continuation({ state: "succeeded", completedAt: later });
  assert.deepEqual(transitionRunnerContinuation({
    current: succeeded,
    expectedRevision: 0,
    nextState: "prepared",
    now: later,
  }), { ok: false, code: "invalid_transition" });
});

test("tool executions fail closed around approval and unknown outcomes", () => {
  const proposed = toolExecution();
  const prepared = transitionHarnessToolExecution({
    current: proposed,
    expectedRevision: 0,
    nextState: "prepared",
    now: later,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.value.state, "prepared");

  assert.deepEqual(transitionHarnessToolExecution({
    current: proposed,
    expectedRevision: 0,
    nextState: "executing",
    now: later,
  }), { ok: false, code: "invalid_transition" });

  const executing = toolExecution({ state: "executing" });
  const unknown = transitionHarnessToolExecution({
    current: executing,
    expectedRevision: 0,
    nextState: "unknown_outcome",
    now: later,
  });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.value.state, "unknown_outcome");
  assert.deepEqual(transitionHarnessToolExecution({
    current: unknown.value,
    expectedRevision: 1,
    nextState: "succeeded",
    now: later,
  }), { ok: false, code: "invalid_transition" });
});

test("run evaluations support leased retries but keep completed results terminal", () => {
  const queued = evaluation();
  const claimed = transitionRunEvaluation({ current: queued, expectedRevision: 0, nextState: "claimed", now: later });
  assert.equal(claimed.ok, true);
  const grading = transitionRunEvaluation({ current: claimed.value, expectedRevision: 1, nextState: "grading", now: later });
  assert.equal(grading.ok, true);
  const retry = transitionRunEvaluation({ current: grading.value, expectedRevision: 2, nextState: "queued", now: later });
  assert.equal(retry.ok, true);

  const completed = evaluation({ state: "completed", completedAt: later });
  assert.deepEqual(transitionRunEvaluation({
    current: completed,
    expectedRevision: 0,
    nextState: "queued",
    now: later,
  }), { ok: false, code: "invalid_transition" });
});

test("deterministic rule grader canonicalizes JSON and rejects executable or malformed values", () => {
  const caseDefinition = {
    schemaVersion: 1,
    kind: "deterministic_json_rule",
    graderId: "json-contract",
    graderVersion: "1",
    failureSeverity: "error",
    assertions: [
      { type: "deep_equal", baselinePath: ["status"], candidatePath: ["status"] },
      { type: "contains", baselinePath: ["required"], candidatePath: ["actual"] },
      { type: "exists", candidatePath: ["actual", "nested"] },
      { type: "number_range", candidatePath: ["latencyMs"], minimum: 0, maximum: 25 },
    ],
  };
  const baseline = { required: { a: 1, b: [2] }, status: "ok" };
  const candidate = { latencyMs: 12, actual: { b: [2, 3], nested: true, a: 1 }, status: "ok" };
  const first = gradeDeterministicRunEvaluation({ caseDefinition, baseline, candidate });
  const second = gradeDeterministicRunEvaluation({
    caseDefinition: { ...caseDefinition },
    baseline: { status: "ok", required: { b: [2], a: 1 } },
    candidate: { status: "ok", actual: { a: 1, nested: true, b: [2, 3] }, latencyMs: 12 },
  });
  assert.deepEqual(first, second);
  assert.equal(first.verdict, "pass");
  assert.equal(first.score, 1);
  assert.equal(digestRunEvaluationValue({ b: 2, a: 1 }), digestRunEvaluationValue({ a: 1, b: 2 }));

  assert.throws(() => gradeDeterministicRunEvaluation({
    caseDefinition: { ...caseDefinition, assertions: [] }, baseline, candidate,
  }), /between 1 and 100/u);
  assert.throws(() => gradeDeterministicRunEvaluation({
    caseDefinition: { ...caseDefinition, assertions: [{ type: "execute", command: "rm" }] },
    baseline,
    candidate,
  }), /Unsupported rule assertion/u);
  assert.throws(() => gradeDeterministicRunEvaluation({
    caseDefinition,
    baseline,
    candidate: { invalid: undefined },
  }), /not JSON-safe/u);
});

test("delegation steps preserve the interrupt and resume lifecycle", () => {
  let current = delegation();
  for (const nextState of [
    "spawning",
    "running",
    "waiting",
    "interrupting",
    "interrupted",
    "resuming",
    "running",
    "succeeded",
  ]) {
    const result = transitionDelegationStep({
      current,
      expectedRevision: current.revision,
      nextState,
      now: later,
    });
    assert.equal(result.ok, true, `${current.state} -> ${nextState}`);
    current = result.value;
  }
  assert.equal(current.state, "succeeded");
  assert.equal(current.completedAt, later);
  assert.deepEqual(transitionDelegationStep({
    current,
    expectedRevision: current.revision,
    nextState: "running",
    now: later,
  }), { ok: false, code: "invalid_transition" });

  assert.deepEqual(transitionDelegationStep({
    current: delegation(),
    expectedRevision: 0,
    nextState: "running",
    now: later,
  }), { ok: false, code: "invalid_transition" });
});

test("harness leases honor retry backoff and expired ownership", () => {
  assert.equal(isHarnessLeaseClaimable({ now: later }), true);
  assert.equal(isHarnessLeaseClaimable({
    now: later,
    claimOwner: "daemon-a",
    claimExpiresAt: "2026-09-13T00:02:00.000Z",
  }), false);
  assert.equal(isHarnessLeaseClaimable({
    now: later,
    claimOwner: "daemon-a",
    claimExpiresAt: "2026-09-13T00:00:30.000Z",
  }), true);
  assert.equal(isHarnessLeaseClaimable({
    now: later,
    nextAttemptAt: "2026-09-13T00:02:00.000Z",
  }), false);
});

test("delegation policy only permits subsets and inherited budgets", () => {
  assert.doesNotThrow(() => assertDelegationBudgetSubset(
    { tokenBudget: 1_000, costBudgetMicros: 50_000, wallTimeBudgetMs: 60_000 },
    { tokenBudget: 500, costBudgetMicros: 20_000 },
  ));
  assert.doesNotThrow(() => assertDelegationBudgetSubset(
    {},
    { tokenBudget: 500 },
  ));
  assert.throws(() => assertDelegationBudgetSubset(
    { tokenBudget: 100 },
    { tokenBudget: 101 },
  ), /exceeds the parent budget/u);
  assert.throws(() => assertDelegationBudgetSubset(
    { tokenBudget: 100 },
    { tokenBudget: -1 },
  ), /non-negative safe integer/u);

  assert.equal(isUniqueStringSubset(["read", "bash", "write"], ["read", "bash"]), true);
  assert.equal(isUniqueStringSubset(["read"], ["read", "write"]), false);
  assert.equal(isUniqueStringSubset(["read"], ["read", "read"]), false);
  assert.throws(() => assertNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1, "budget"), /non-negative safe integer/u);
});

test("harness identities are deterministic at their authority boundaries", () => {
  assert.equal(
    runnerContinuationIdempotencyKey({
      runId: "run_1",
      sourceAttemptId: "attempt_1",
      origin: "daemon_recovery",
      generation: 2,
    }),
    "runner-continuation:run_1:attempt_1:daemon_recovery:2",
  );
  assert.equal(harnessToolExecutionIdempotencyKey("attempt_1", "tool_1"), "harness-tool:attempt_1:tool_1");
  assert.equal(delegationIdempotencyKey("attempt_1", "spawn_1"), "delegation:attempt_1:spawn_1");
  const evaluationKey = runEvaluationIdempotencyKey({
    rootRunId: "run_root",
    runId: "run_1",
    suiteId: "suite_1",
    suiteVersion: "1",
    suiteArtifactId: "artifact_suite_1",
    suiteDigest: "a".repeat(64),
    caseId: "case_1",
    caseVersion: "3",
    caseArtifactId: "artifact_case_1",
    caseDigest: "b".repeat(64),
    baselineId: "baseline_1",
    baselineVersion: "2",
    baselineArtifactId: "artifact_baseline_1",
    baselineDigest: "c".repeat(64),
    candidateArtifactId: "artifact_1",
    candidateDigest: "d".repeat(64),
  });
  assert.match(evaluationKey, /^run-evaluation:[a-f0-9]{64}$/u);
  assert.equal(evaluationKey, runEvaluationIdempotencyKey({
    candidateDigest: "d".repeat(64),
    candidateArtifactId: "artifact_1",
    baselineDigest: "c".repeat(64),
    baselineArtifactId: "artifact_baseline_1",
    baselineVersion: "2",
    baselineId: "baseline_1",
    caseDigest: "b".repeat(64),
    caseArtifactId: "artifact_case_1",
    caseVersion: "3",
    caseId: "case_1",
    suiteDigest: "a".repeat(64),
    suiteArtifactId: "artifact_suite_1",
    suiteVersion: "1",
    suiteId: "suite_1",
    runId: "run_1",
    rootRunId: "run_root",
  }));
  assert.notEqual(evaluationKey, runEvaluationIdempotencyKey({
    rootRunId: "run_root",
    runId: "run_1",
    suiteId: "suite_1",
    suiteVersion: "1",
    suiteArtifactId: "artifact_suite_copy",
    suiteDigest: "a".repeat(64),
    caseId: "case_1",
    caseVersion: "3",
    caseArtifactId: "artifact_case_1",
    caseDigest: "b".repeat(64),
    baselineId: "baseline_1",
    baselineVersion: "2",
    baselineArtifactId: "artifact_baseline_1",
    baselineDigest: "c".repeat(64),
    candidateArtifactId: "artifact_1",
    candidateDigest: "d".repeat(64),
  }));
});

function continuation(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "continuation_1",
    runId: "run_1",
    workUnitId: "work_unit_1",
    sourceAttemptId: "attempt_1",
    origin: "manual_resume",
    strategy: "deterministic_replay",
    state: "requested",
    runnerId: "pi",
    runnerCapabilityRevision: "pi:1",
    contextViewId: "context_1",
    contextSnapshotArtifactId: "artifact_context_1",
    idempotencyKey: "runner-continuation:run_1:attempt_1:manual_resume:0",
    generation: 0,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function toolExecution(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "tool_execution_1",
    runId: "run_1",
    workUnitId: "work_unit_1",
    attemptId: "attempt_1",
    toolCallId: "tool_1",
    toolName: "bash",
    executorKind: "bash",
    state: "proposed",
    requestDigest: "request_digest",
    sideEffectFingerprint: "side_effect_fingerprint",
    policySnapshotArtifactId: "artifact_policy_1",
    sandboxProfileId: "workspace-write",
    evidenceArtifactIds: [],
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function evaluation(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "evaluation_1",
    rootRunId: "run_1",
    runId: "run_1",
    suiteId: "suite_1",
    suiteVersion: "1",
    suiteArtifactId: "artifact_suite_1",
    suiteDigest: "a".repeat(64),
    caseId: "case_1",
    caseVersion: "1",
    caseArtifactId: "artifact_case_1",
    caseDigest: "b".repeat(64),
    baselineId: "baseline_1",
    baselineVersion: "1",
    baselineArtifactId: "artifact_baseline_1",
    baselineDigest: "c".repeat(64),
    candidateArtifactId: "artifact_candidate_1",
    candidateDigest: "d".repeat(64),
    idempotencyKey: "evaluation-key",
    state: "queued",
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function delegation(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "delegation_1",
    rootRunId: "run_1",
    parentRunId: "run_1",
    parentAttemptId: "attempt_1",
    spawnCallId: "spawn_1",
    objectiveArtifactId: "artifact_objective_1",
    required: true,
    state: "planned",
    depth: 1,
    permissionSnapshotArtifactId: "artifact_permissions_1",
    toolAllowlistArtifactId: "artifact_tools_1",
    workspaceScopeArtifactId: "artifact_workspace_1",
    providerPolicyArtifactId: "artifact_provider_1",
    idempotencyKey: "delegation:attempt_1:spawn_1",
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}
