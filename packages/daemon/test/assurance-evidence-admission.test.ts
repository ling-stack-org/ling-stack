import assert from "node:assert/strict";
import test from "node:test";
import type {
  FrameworkAssuranceBudgetEvidence,
  FrameworkAssuranceCompletionEvidence,
  FrameworkAssuranceEffectStatus,
  FrameworkAssuranceIsolationEvidence,
  FrameworkAssuranceLifecycleEvidence,
} from "@ling-stack/contracts";
import type { RunSession } from "@ling-stack/core";
import { buildAdmission } from "../dist/features/runs/assurance-evidence.js";

const run = {
  requestSnapshot: { harnessFeatureSnapshot: { toolBroker: "enforce" } },
} as unknown as RunSession;

const isolation: FrameworkAssuranceIsolationEvidence = {
  status: "verified",
  workflowId: "workflow-assurance",
  workflowStepId: "step-assurance",
  selection: { profile: "pi_host_isolated_files_v1", roundId: "round-assurance", phase: "applied" },
  safetyPlan: { present: true, valid: true, profile: "pi_host_isolated_files_v1", digest: "safety-digest", toolsCount: 1, writeRootsCount: 1, networkAccess: false },
  binding: { status: "current", bindingId: "binding-assurance", revision: 1, planDigest: "plan-digest", matchesCurrentFence: true },
  round: { roundId: "round-assurance", generation: 1, revision: 1, phase: "applied", lastConfirmedPhase: "applied", candidate: null },
  history: [],
  effects: [],
  receipts: [],
  branchResults: [],
  approval: { status: "approved", approvalId: "approval-assurance", requestId: "request-assurance", authorityDigest: "authority-digest", basisFingerprint: "basis-fingerprint" },
  apply: { status: "applied", code: null, intentPresent: true },
  blockers: [],
};

const completion: FrameworkAssuranceCompletionEvidence = {
  status: "satisfied",
  rootRunIds: ["run-assurance"],
  fingerprint: "completion-assurance",
  stepCount: 1,
  requiredStepCount: 1,
  completedStepCount: 1,
  steps: [{ stepId: "delegation-assurance", required: true, state: "succeeded", childRunId: "child-assurance",
    attemptId: "attempt-child", reservationState: "settled", completionStatus: "verified", resultArtifacts: [] }],
  issues: [],
  resultArtifacts: [],
};

const budget: FrameworkAssuranceBudgetEvidence = {
  status: "within",
  roots: [],
  reservations: [],
  charges: [],
  usage: { tokenStatus: "within", costStatus: "within", tokens: 5, costMicros: 7, tokenLimit: 10, costLimitMicros: 10 },
  issues: [],
  blockers: [],
};

function lifecycle(overrides: Partial<FrameworkAssuranceLifecycleEvidence> = {}): FrameworkAssuranceLifecycleEvidence {
  return {
    status: "drained",
    currentAttemptId: "attempt-assurance",
    currentGeneration: 1,
    attemptCount: 1,
    oldAttemptCount: 0,
    attempts: [],
    stop: { localExecution: "drained", effects: "settled", allAttemptsTerminal: true, reusable: true },
    ...overrides,
  };
}

test("isolated admission stays blocked while an Attempt is active", () => {
  const evidence = buildAdmission(run, isolation, lifecycle({
    status: "active",
    stop: { localExecution: "unverified", effects: "unverified", allAttemptsTerminal: false, reusable: false },
  }), "none", completion, budget);
  assert.equal(evidence.status, "blocked");
  assert.ok(evidence.blockers.includes("workflow_admission.lifecycle_not_drained"));
  assert.ok(evidence.blockers.includes("workflow_admission.attempt_not_terminal"));
  assert.ok(evidence.blockers.includes("workflow_admission.local_execution_not_drained"));
  assert.ok(evidence.blockers.includes("workflow_admission.execution_effects_unconfirmed"));
});

test("isolated admission stays blocked until terminal stop effects are confirmed", () => {
  const statuses: FrameworkAssuranceEffectStatus[] = ["none", "unknown"];
  for (const effectStatus of statuses) {
    const evidence = buildAdmission(run, isolation, lifecycle({
      status: "terminal",
      stop: { localExecution: "drained", effects: "settled", allAttemptsTerminal: true, reusable: true },
    }), effectStatus, completion, budget);
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.blockers.includes("workflow_admission.execution_effects_unconfirmed"));
  }
});

test("isolated admission is verified only after reusable lifecycle and confirmed effects", () => {
  const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed", completion, budget);
  assert.equal(evidence.status, "verified");
  assert.deepEqual(evidence.blockers, []);
});

for (const status of ["pending", "blocked", "failed", "cancelled"] as const) {
  test(`isolated admission blocks ${status} delegation completion`, () => {
    const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed", { ...completion, status }, budget);
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.blockers.includes("workflow_admission.delegation_completion_not_satisfied"));
  });
}

for (const status of ["pending", "unknown", "over", "missing", "invalid"] as const) {
  test(`isolated admission blocks a ${status} delegation budget`, () => {
    const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed", completion, { ...budget, status });
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.blockers.includes("workflow_admission.delegation_budget_not_within"));
  });
}

test("isolated admission preserves detailed completion and budget blockers", () => {
  const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed", {
    ...completion, status: "blocked",
    issues: [{ code: "delegation.completion_lineage_invalid", stepId: "delegation-assurance", runId: null, factFingerprint: null }],
  }, { ...budget, status: "unknown", blockers: ["delegation.usage_unknown"] });
  assert.equal(evidence.status, "blocked");
  assert.ok(evidence.blockers.includes("delegation.completion_lineage_invalid"));
  assert.ok(evidence.blockers.includes("delegation.usage_unknown"));
});

test("isolated admission accepts a completed Run with no delegated work", () => {
  const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed", {
    status: "not_applicable", rootRunIds: [], fingerprint: null, stepCount: 0, requiredStepCount: 0,
    completedStepCount: 0, steps: [], issues: [], resultArtifacts: [],
  }, {
    status: "not_applicable", roots: [], reservations: [], charges: [],
    usage: { tokenStatus: "not_applicable", costStatus: "not_applicable", tokens: null, costMicros: null, tokenLimit: null, costLimitMicros: null },
    issues: [], blockers: [],
  });
  assert.equal(evidence.status, "verified");
  assert.deepEqual(evidence.blockers, []);
});
