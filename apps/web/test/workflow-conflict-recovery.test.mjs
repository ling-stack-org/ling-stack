import assert from "node:assert/strict";
import test from "node:test";
import { evidence, observed, round, steps, t, workflow } from "./support/workflow-isolation-evidence-fixture.mjs";

const { canRetryWorkflowConflictRecoveryPlanning, validWorkflowRepairInstruction, workflowConflictRecoveryRequest } = await import("../src/lib/workflow-conflict-recovery.ts");
const { buildWorkflowIsolationPresentation, workflowConflictRecoveryRound } = await import("../src/lib/workflow-isolation-evidence.ts");
const conflict = overrides => round({ phase: "conflicted", lastConfirmedPhase: "conflicted", mode: "candidate_only",
  reasonCode: "workflow_integration.text_conflict", approval: undefined, candidate: undefined, ...overrides });

test("repair instructions retain the public contract's exact length, whitespace and control-character bounds", () => {
  for (const value of ["", " \n\t", "x".repeat(4001), "repair\u0000", "repair\u007f"]) assert.equal(validWorkflowRepairInstruction(value), false);
  for (const value of ["Resolve both edits.", "x".repeat(4000), "Preserve both\n\timplementations.", "保留两个分支的修改。"])
    assert.equal(validWorkflowRepairInstruction(value), true);
});

test("repair planning retries require an unstarted ready successor or an exact missing request", () => {
  const owner = workflow({ id: "repair-workflow", status: "ready" });
  const response = { phase: "planning", workflow: owner,
    workflowSteps: steps(owner).map(step => ({ ...step, status: "queued", runId: undefined })) };
  assert.equal(canRetryWorkflowConflictRecoveryPlanning("planning", response), true);
  assert.equal(canRetryWorkflowConflictRecoveryPlanning("retry"), true);
  assert.equal(canRetryWorkflowConflictRecoveryPlanning("planning"), false);
  for (const phase of [undefined, "checking", "unknown", "ready", "starting", "started"])
    assert.equal(canRetryWorkflowConflictRecoveryPlanning(phase, response), false);
  for (const status of ["cancelled", "failed", "succeeded", "running", "blocked", "waiting_for_approval", "waiting_for_input"])
    assert.equal(canRetryWorkflowConflictRecoveryPlanning("planning", { ...response, workflow: { ...owner, status } }), false);
  for (const patch of [{ status: "running" }, { runId: "run-existing" }, { taskId: "task-existing" }])
    assert.equal(canRetryWorkflowConflictRecoveryPlanning("planning", { ...response,
      workflowSteps: [{ ...response.workflowSteps[0], ...patch }, response.workflowSteps[1]] }), false);
  assert.equal(canRetryWorkflowConflictRecoveryPlanning("planning", { ...response, phase: "ready" }), false);
});

test("only a confirmed drained candidate-only text conflict exposes repair, including retained predecessor discovery", () => {
  for (const status of ["running", "blocked", "failed"]) {
    const owner = workflow({ status }), r = conflict(), observation = observed(evidence({ rounds: [r] }));
    assert.equal(workflowConflictRecoveryRound(owner, observation), r);
    const projection = buildWorkflowIsolationPresentation({ workflow: owner, observation, t });
    assert.deepEqual(projection.items[1].availableActions, ["recover_workflow_conflict"]);
    assert.equal(projection.items[1].revision, r.revision);
    assert(projection.items[1].sourceRefs.some(ref => ref.kind === "workflow_integration_round" && ref.id === `${r.roundId}:${r.generation}`));
  }
});

test("stale, unknown, multi-round, applied, approval-bearing and non-text conflict evidence exposes no repair action", () => {
  const owner = workflow({ status: "blocked" });
  for (const observation of [undefined, observed(evidence({ rounds: [conflict()] }), { status: "error" }),
    observed(evidence({ rounds: [conflict()] }), { status: "loading" }), observed(evidence({ schemaVersion: 2, rounds: [conflict()] })),
    observed(evidence({ status: "unavailable", rounds: [conflict()] })), observed(evidence({ hostOperationPending: true, rounds: [conflict()] })),
    observed(evidence({ gitEffects: "unconfirmed", rounds: [conflict()] })), observed(evidence({ rounds: [conflict(), conflict({ generation: 2 })] })),
    ...[{ phase: "blocked" }, { mode: "apply_to_target" }, { maxConcurrentSteps: 3 }, { reasonCode: "workflow_integration.repository_changed" },
      { candidate: { commit: "a", tree: "b" } }, { approval: { approvalId: "approval", status: "denied" } },
      { application: { status: "effect_unknown" } }, { application: { status: "pending" } }, { application: { status: "applied" } },
      { effects: [{ id: "effect", status: "blocked", kind: "integrate_branch", artifactIds: [] }] },
      { effects: [{ id: "effect", status: "pending", kind: "integrate_branch", artifactIds: [] }] }]
      .map(patch => observed(evidence({ rounds: [conflict(patch)] })))]) {
    assert.equal(workflowConflictRecoveryRound(owner, observation), undefined);
  }
  for (const status of ["ready", "succeeded", "cancelled", "waiting_for_approval", "waiting_for_input"]) {
    assert.equal(workflowConflictRecoveryRound(workflow({ status }), observed(evidence({ rounds: [conflict()] }))), undefined);
  }
});

test("recovery read validation binds predecessor revision, successor lineage, candidate-only mode and exact original request", () => {
  const owner = workflow({ status: "blocked" }), expected = { roundId: "round-qa", generation: 1, expectedRevision: 3 };
  const request = { ...expected, idempotencyKey: "repair-key", repairInstruction: "Resolve both edits." };
  const successor = workflow({ id: "successor", status: "ready", metadata: { sourceTurnId: "repair-turn", sourceMessageId: "repair-source" } });
  const response = { recovery: { schemaVersion: 1, sequence: 1, predecessor: { workflowId: owner.id, roundId: expected.roundId,
    generation: 1, revision: 3 }, successor: { workflowId: successor.id, roundId: "repair-round", generation: 1 },
    idempotencyKey: request.idempotencyKey, repairInstruction: request.repairInstruction }, workflow: successor,
    workflowSteps: steps(successor), phase: "ready", mode: "candidate_only", executionProfile: "pi_host_isolated_files_v1", requiresExplicitOrchestration: true };
  assert.deepEqual(workflowConflictRecoveryRequest(response, owner, expected), request);
  assert.deepEqual(workflowConflictRecoveryRequest({ ...response, phase: "planning" }, owner, expected, request), request);
  for (const patch of [{ mode: "apply_to_target" }, { phase: "unknown" }, { requiresExplicitOrchestration: false }, { executionProfile: "other" },
    { workflow: { ...successor, workspaceId: "foreign" } }, { workflow: { ...successor, channelId: "foreign" } },
    { workflow: { ...successor, id: "foreign" } }, { workflowSteps: [] }, { workflowSteps: [{ ...steps(successor)[0], workflowId: owner.id }, steps(successor)[1]] },
    { recovery: { ...response.recovery, predecessor: { ...response.recovery.predecessor, revision: 4 } } },
    { recovery: { ...response.recovery, successor: { ...response.recovery.successor, generation: 2 } } }]) {
    assert.throws(() => workflowConflictRecoveryRequest({ ...response, ...patch }, owner, expected), /unverified/u);
  }
  assert.throws(() => workflowConflictRecoveryRequest(response, owner, expected, { ...request, idempotencyKey: "another" }), /request_mismatch/u);
  assert.throws(() => workflowConflictRecoveryRequest(response, owner, expected, { ...request, repairInstruction: "Other instruction" }), /request_mismatch/u);
});
