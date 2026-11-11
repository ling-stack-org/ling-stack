import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  FrameworkAssuranceBudgetEvidence,
  FrameworkAssuranceClaimStatus,
  FrameworkAssuranceCompletionEvidence,
  FrameworkAssuranceEffectStatus,
  FrameworkAssuranceEvidenceResponse,
  FrameworkAssuranceIsolationEvidence,
  FrameworkAssuranceLifecycleEvidence,
} from "@ling-stack/contracts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, type RunSession } from "@ling-stack/core";
import { buildAdmission as projectAdmission, handleGetRunAssuranceEvidence } from "../dist/features/runs/assurance-evidence.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

const run = {
  status: "succeeded",
  requestSnapshot: { harnessFeatureSnapshot: { toolBroker: "enforce" } },
} as unknown as RunSession;

function buildAdmission(
  sourceRun: RunSession,
  isolation: FrameworkAssuranceIsolationEvidence,
  lifecycle: FrameworkAssuranceLifecycleEvidence,
  effectStatus: FrameworkAssuranceEffectStatus,
  completion: FrameworkAssuranceCompletionEvidence,
  budget: FrameworkAssuranceBudgetEvidence,
  claimStatus: FrameworkAssuranceClaimStatus = "terminal_retained",
  workUnitStatus: FrameworkAssuranceEvidenceResponse["execution"]["workUnitStatus"] = "succeeded",
  attemptStatus: FrameworkAssuranceEvidenceResponse["execution"]["attemptStatus"] = "succeeded",
) {
  return projectAdmission(sourceRun, isolation, lifecycle, effectStatus, completion, budget, { claimStatus, workUnitStatus, attemptStatus });
}

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

for (const status of ["queued", "running", "waiting_for_approval", "yielded"] as const) {
  test(`isolated admission blocks nonterminal Run ${status}`, () => {
    const evidence = buildAdmission({ ...run, status }, isolation, lifecycle(), "confirmed", completion, budget);
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.blockers.includes("workflow_admission.run_not_terminal"));
  });
}

for (const status of ["failed", "cancelled"] as const) {
  test(`isolated admission retains reusable ${status} execution as distinct from its outcome`, () => {
    const evidence = buildAdmission({ ...run, status }, isolation, lifecycle(), "confirmed", completion, budget, "terminal_retained", status, status);
    assert.equal(evidence.status, "verified");
    assert.deepEqual(evidence.blockers, []);
  });
}

for (const claim of ["unclaimed", "held", "expired"] as const) {
  test(`isolated admission blocks ${claim} Attempt ownership despite settled stop evidence`, () => {
    const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed", completion, budget, claim);
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.blockers.includes("workflow_admission.terminal_claim_not_retained"));
  });
}

for (const status of ["queued", "claimed", "running", "waiting_for_input", "waiting_for_approval", "cancelling", "stale"] as const) {
  test(`isolated admission blocks nonterminal WorkUnit ${status}`, () => {
    const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed", completion, budget, "terminal_retained", status);
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.blockers.includes("workflow_admission.work_unit_not_terminal"));
  });
}

for (const status of ["created", "started", "waiting_for_approval", "cancelling", "yielded", "lost"] as const) {
  test(`isolated admission rejects ${status} current Attempt despite a retained-claim label`, () => {
    const evidence = buildAdmission(run, isolation, lifecycle(), "confirmed", completion, budget, "terminal_retained", "succeeded", status);
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.blockers.includes("workflow_admission.terminal_claim_not_retained"));
  });
}

test("Host projection marks a lost current Attempt claim expired even while its active ID remains", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-assurance-claim-")), now = "2026-11-11T00:00:00.000Z";
  const store = createSqliteRunStore(cwd), registry = new RunStoreRegistry(() => store, { recoverOnOpen: false });
  t.after(async () => { registry.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  registry.getStore(cwd);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run-lost",
    idempotencyKey: "lost-claim-unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ id: "attempt-lost", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "runtime-lost", runnerId: "pi", effectiveRunnerId: "pi", status: "started", now });
  store.createRun({ id: "run-lost", cwd, taskId: "task-lost", workUnitId: unit.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit("run-lost", unit.id, now);
  assert.equal(store.updateWorkUnitAttemptStatus({ ...toRuntimeAttemptFence(attempt), status: "lost", endedAt: now, now })?.status, "lost");
  assert.equal(store.getWorkUnit(unit.id)?.activeAttemptId, attempt.id);
  store.createArtifact({ runId: "run-lost", type: "json", path: "result.json", sealedPayload: { result: true }, createdAt: now });
  let status = 0, payload = "";
  const response = { setHeader() {}, writeHead(code: number) { status = code; }, end(body: string) { payload = body; } } as unknown as ServerResponse;
  const url = new URL("http://fixture/runs/run-lost/assurance-evidence"); url.searchParams.set("cwd", cwd);
  handleGetRunAssuranceEvidence(response, url, registry, new ActiveRunRegistry(), "run-lost");
  assert.equal(status, 200, payload);
  const evidence = JSON.parse(payload) as FrameworkAssuranceEvidenceResponse;
  assert.equal(evidence.execution.attemptStatus, "lost");
  assert.equal(evidence.execution.claimStatus, "expired");
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
