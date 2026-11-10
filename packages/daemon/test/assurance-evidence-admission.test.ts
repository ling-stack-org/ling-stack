import assert from "node:assert/strict";
import test from "node:test";
import type {
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
  }), "none");
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
    }), effectStatus);
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.blockers.includes("workflow_admission.execution_effects_unconfirmed"));
  }
});

test("isolated admission is verified only after reusable lifecycle and confirmed effects", () => {
  const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed");
  assert.equal(evidence.status, "verified");
  assert.deepEqual(evidence.blockers, []);
});
