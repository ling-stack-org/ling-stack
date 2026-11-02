import assert from "node:assert/strict";
import test from "node:test";
import { approvalActionTypes, approvalSideEffectFingerprintV1, assertApprovalDecisionAvailable,
  workflowIsolationDigest } from "../dist/index.js";
import { approvalActionTypes as contractApprovalActionTypes } from "../../contracts/dist/approvals.js";
import { workflowIsolationFixture, nextCommit, nextTree } from "./support/workflow-isolation-fixture.mjs";

async function fixture(t) {
  const f = await workflowIsolationFixture(t);
  const payload = { type: "workflow_merge", schemaVersion: 1, workflowId: f.plan.workflowId,
    workflowStepId: f.plan.workflowStepId, roundId: f.roundId, generation: f.plan.generation,
    authorityDigest: workflowIsolationDigest("merge-authority", "wica1_"), inputsDigest: f.round().inputsDigest,
    candidate: { commit: nextCommit, tree: nextTree, packetDigest: workflowIsolationDigest("candidate", "wgp1_"),
      validationDigest: workflowIsolationDigest("verification", "wgp1_"), branchResultDigests: [],
      resultRef: `refs/ling/workflow/candidates/${f.roundId}/1-${f.inputs.integration.worktreeId}/candidate` },
    target: f.inputs.target, repositoryIdentity: f.inputs.repositoryIdentity, graphFingerprint: f.inputs.graphFingerprint,
    safetyFingerprint: f.inputs.safetyFingerprint, templatePins: f.inputs.templatePins,
    targetSnapshot: { root: f.cwd, commonDir: f.inputs.repositoryIdentity.commonDir, gitDir: f.inputs.repositoryIdentity.commonDir,
      head: f.inputs.baseCommit, branchRef: f.inputs.target.branchRef, configurationDigest: "6".repeat(64),
      rootDevice: "1", rootInode: "10", commonDevice: "1", commonInode: "11", dirty: false }, expiresAt: f.at(60) };
  f.payload = { ...payload, fingerprint: workflowIsolationDigest(payload, "wma1_") };
  f.mergeInput = (changes = {}) => ({ workflowStepId: f.plan.workflowStepId, channelId: f.channel.id,
    actionType: "workflow_merge", risk: "high", title: "Approve workflow merge", description: "Merge frozen candidate",
    payload: f.payload, expiresAt: f.payload.expiresAt, ...changes });
  f.createMerge = (changes = {}) => f.store.createApprovalRequest(f.mergeInput(changes), f.at(1));
  f.snapshotApproval = () => ({ ...f.snapshotIsolation(), approval_command_rules:
    f.peer.database.prepare("SELECT * FROM approval_command_rules ORDER BY rowid").all() });
  f.noWrites = action => { const before = f.snapshotApproval();
    try { return action(); } finally { assert.deepEqual(f.snapshotApproval(), before); } };
  f.runApproval = () => {
    if (!f.prepared) f.prepare();
    return f.store.createApprovalRequest({ runId: f.prepared.run.id, taskId: f.prepared.run.taskId, channelId: f.channel.id,
      toolCallId: "merge-review-fixture", actionType: "bash", risk: "medium", title: "Ordinary command",
      description: "echo fixture", payload: { type: "bash", cwd: f.cwd, command: "echo fixture", riskFlags: [] } }, f.at(5));
  };
  f.reviewInput = approval => ({ approvalId: approval.id, approvalCreatedAt: approval.createdAt,
    runId: approval.runId ?? "not-a-merge-owner", toolCallId: approval.toolCallId ?? "not-a-merge-tool",
    sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: approval.actionType,
      toolCallId: approval.toolCallId, sideEffect: approval.payload }), workspacePolicyUpdatedAt: f.store.getApprovalPolicy().updatedAt,
    sourceFence: f.prepared?.fence ?? { workUnitId: "unused", attemptId: "unused", runtimeInstanceId: "unused", fencingToken: "1" },
    decision: "approve", reason: "System reviewer must not authorize a merge" });
  return f;
}

test("workflow_merge is a Core and Contracts action with only once consent", () => {
  assert.ok(approvalActionTypes.includes("workflow_merge"));
  assert.deepEqual(contractApprovalActionTypes, approvalActionTypes);
  const merge = { actionType: "workflow_merge", payload: { type: "workflow_merge" },
    availableDecisions: ["approve_once", "approve_command_rule", "approve_permission_scope", "deny"] };
  assert.doesNotThrow(() => assertApprovalDecisionAvailable(merge, "approve_once"));
  for (const decision of ["approve_command_rule", "approve_permission_scope", "approve_all", "deny"]) {
    assert.throws(() => assertApprovalDecisionAvailable(merge, decision), { code: "approval_decision_unavailable" });
  }
  for (const changes of [{ actionType: "bash" }, { actionType: "runtime_permission_request" }, { payload: { type: "bash" } }]) {
    for (const decision of ["approve_once", "approve_command_rule", "approve_permission_scope"]) {
      assert.throws(() => assertApprovalDecisionAvailable({ ...merge, ...changes }, decision), { code: "approval_decision_unavailable" });
    }
  }
});

test("merge consent persists its sole step owner and checkpoint without issuing a permit or advancing isolation", async t => {
  const f = await fixture(t), round = f.round();
  const approval = f.createMerge();
  assert.equal(approval.actionType, "workflow_merge");
  assert.deepEqual(approval.payload, f.payload);
  assert.deepEqual(approval.availableDecisions, ["approve_once", "deny"]);
  assert.equal(approval.workflowStepId, f.plan.workflowStepId);
  assert.equal(approval.channelId, f.channel.id);
  for (const owner of ["runId", "taskId", "mediaJobId", "externalWorkActionId"]) assert.equal(approval[owner], undefined);
  const checkpoint = f.store.getApprovalCheckpointForApproval(approval.id);
  assert.equal(checkpoint.status, "pending");
  assert.deepEqual(checkpoint.sideEffect, f.payload);
  const resolved = f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_once", resolvedBy: "local-user" }, f.at(2));
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.resolvedBy, "local-user");
  assert.equal(resolved.decisionKind, "approve_once");
  assert.equal(resolved.decisionRuleId, undefined);
  assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, "approved");
  assert.deepEqual(f.round(), round);
  for (const table of ["tasks", "run_sessions", "work_unit_attempts", "workflow_isolation_intents", "runtime_semaphore_slots"]) {
    assert.equal(f.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(f.store.listApprovalCommandRules(), []);
  f.reopenIsolation();
  assert.deepEqual(f.store.getApprovalRequest(approval.id), resolved);
  assert.deepEqual(f.round(), round);
});

test("merge creation rejects foreign owners, absent channels, mismatched discriminants and step lineage atomically", async t => {
  const f = await fixture(t);
  const foreign = f.scope("foreign-merge-owner", { plan: f.plan.resourcePlan });
  const channel = f.store.createChannel({ name: "Other merge channel", boundPath: f.cwd }, f.at(0));
  const cases = [
    { workflowStepId: undefined }, { workflowStepId: foreign.step.id },
    { runId: "foreign-run", taskId: "foreign-task", workflowStepId: undefined },
    { runId: "foreign-run", taskId: "foreign-task" }, { runId: "" }, { taskId: "" },
    { mediaJobId: "foreign-media" }, { externalWorkActionId: "foreign-external-action" },
    { channelId: undefined }, { channelId: "" }, { channelId: "missing-channel" }, { channelId: channel.id },
    { actionType: "workflow_step" }, { payload: { type: "bash", cwd: f.cwd, command: "echo no", riskFlags: [] } },
    { payload: { ...f.payload, schemaVersion: 2 } }, { payload: { ...f.payload, workflowId: foreign.workflow.id } },
    { payload: { ...f.payload, workflowStepId: foreign.step.id } },
    { expiresAt: undefined }, { expiresAt: f.at(61) }, { payload: { ...f.payload, expiresAt: undefined } },
  ];
  for (const changes of cases) assert.throws(() => f.noWrites(() => f.createMerge(changes)), /owner|merge|channel/i);
  assert.equal(f.count("approval_requests"), 0);
  assert.equal(f.count("approval_checkpoints"), 0);
});

test("merge creation never offers reusable rules or native permission scopes", async t => {
  const f = await fixture(t);
  for (const availableDecisions of [["approve_command_rule", "deny"], ["approve_permission_scope", "deny"],
    ["approve_once", "approve_command_rule", "approve_permission_scope", "deny"], []]) {
    assert.throws(() => f.noWrites(() => f.createMerge({ availableDecisions })), /approve_once and deny/);
  }
  assert.throws(() => f.noWrites(() => f.createMerge({ proposedCommandRule: {
    prefix: ["git", "merge"], display: "git merge", fingerprint: "not-a-merge-permit", version: 1, cwd: f.cwd,
  } })), /approve_once and deny/);
  const denialOnly = f.createMerge({ availableDecisions: ["deny"] });
  assert.throws(() => f.noWrites(() => f.store.approveApprovalRequest(denialOnly.id, {}, f.at(2))), { code: "approval_decision_unavailable" });
  assert.equal(f.store.denyApprovalRequest(denialOnly.id, { resolvedBy: "local-user" }, f.at(2)).decisionKind, "deny");
});

test("forged historical offered rules and scopes cannot authorize merge consent", async t => {
  const f = await fixture(t), approval = f.createMerge();
  f.store.database.prepare("UPDATE approval_requests SET available_decisions_json=? WHERE id=?")
    .run(JSON.stringify(["approve_once", "approve_command_rule", "approve_permission_scope", "deny"]), approval.id);
  for (const decisionKind of ["approve_command_rule", "approve_permission_scope"]) {
    assert.throws(() => f.noWrites(() => f.store.approveApprovalRequest(approval.id, { decisionKind }, f.at(2))));
  }
  assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
  assert.deepEqual(f.store.listApprovalCommandRules(), []);
});

test("system reviewer cannot resolve merge consent through either automatic entry point", async t => {
  const f = await fixture(t), approval = f.createMerge();
  for (const decision of ["approve", "deny"]) {
    assert.deepEqual(f.noWrites(() => f.store.resolveApprovalBySystemReviewer({ ...f.reviewInput(approval), decision }, f.at(2))),
      { ok: false, code: "approval_system_reviewer_disallowed" });
  }
  for (const decisionKind of [undefined, "approve_once", "approve_command_rule", "approve_permission_scope"]) {
    assert.throws(() => f.noWrites(() => f.store.approveApprovalRequest(approval.id,
      { resolvedBy: "system-reviewer", decisionKind }, f.at(2))), { code: "approval_decision_unavailable" });
  }
  assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, "pending");
  assert.equal(f.store.approveApprovalRequest(approval.id, {}, f.at(2)).resolvedBy, "local-user");
});

test("historical merge rows with forged Run owners cannot use system reviewer or disguise either discriminator", async t => {
  const f = await fixture(t);
  for (const tag of ["both", "action", "payload"]) {
    const original = f.runApproval();
    const actionType = tag === "payload" ? original.actionType : "workflow_merge";
    const payload = tag === "action" ? original.payload : f.payload;
    f.store.database.prepare("UPDATE approval_requests SET action_type=?,payload_json=? WHERE id=?")
      .run(actionType, JSON.stringify(payload), original.id);
    const forged = f.store.getApprovalRequest(original.id);
    assert.equal(forged.runId, f.prepared.run.id);
    assert.equal(forged.workflowStepId, undefined);
    for (const decision of ["approve", "deny"]) {
      assert.deepEqual(f.noWrites(() => f.store.resolveApprovalBySystemReviewer({ ...f.reviewInput(forged), decision }, f.at(6))),
        { ok: false, code: "approval_system_reviewer_disallowed" });
    }
    assert.throws(() => f.noWrites(() => f.store.approveApprovalRequest(forged.id, { resolvedBy: "system-reviewer" }, f.at(6))),
      { code: "approval_decision_unavailable" });
    assert.throws(() => f.noWrites(() => f.store.approveApprovalRequest(forged.id, { resolvedBy: "local-user" }, f.at(6))));
  }
});

test("merge expiry is strict at the approval boundary and denies malformed or detached lifetimes", async t => {
  const f = await fixture(t);
  const expired = f.createMerge({ expiresAt: f.at(1), payload: { ...f.payload, expiresAt: f.at(1) } });
  for (const now of [f.at(1), f.at(2), "not-a-time"]) {
    assert.throws(() => f.noWrites(() => f.store.approveApprovalRequest(expired.id, {}, now)), { code: "approval_decision_unavailable" });
  }
  const future = f.createMerge();
  assert.equal(f.store.approveApprovalRequest(future.id, {}, f.at(59)).status, "approved");
  for (const expiresAt of [null, "not-a-time", f.at(61)]) {
    const approval = f.createMerge();
    f.store.database.prepare("UPDATE approval_requests SET expires_at=? WHERE id=?").run(expiresAt, approval.id);
    assert.throws(() => f.noWrites(() => f.store.approveApprovalRequest(approval.id, {}, f.at(2))), /expiry/);
  }
  assert.equal(f.store.denyApprovalRequest(expired.id, {}, f.at(61)).status, "denied");
});

test("merge approval and its checkpoint and decision effects roll back together", async t => {
  const f = await fixture(t);
  f.store.database.exec(`CREATE TEMP TRIGGER fail_merge_creation BEFORE INSERT ON approval_checkpoints
    BEGIN SELECT RAISE(ABORT,'merge checkpoint insert failed'); END`);
  assert.throws(() => f.noWrites(() => f.createMerge()), /merge checkpoint insert failed/);
  f.store.database.exec("DROP TRIGGER fail_merge_creation");
  const approval = f.createMerge();
  f.store.database.exec(`CREATE TEMP TRIGGER fail_merge_resolution BEFORE UPDATE ON approval_checkpoints
    BEGIN SELECT RAISE(ABORT,'merge checkpoint update failed'); END`);
  assert.throws(() => f.noWrites(() => f.store.approveApprovalRequest(approval.id, {}, f.at(2))), /merge checkpoint update failed/);
  f.store.database.exec("DROP TRIGGER fail_merge_resolution");
  assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
  assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, "pending");
  assert.equal(f.store.approveApprovalRequest(approval.id, {}, f.at(2)).status, "approved");
});

test("merge approval savepoints preserve an enclosing SQLite transaction", async t => {
  const f = await fixture(t);
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    const approval = f.createMerge();
    assert.equal(f.store.database.isTransaction, true);
    f.store.approveApprovalRequest(approval.id, {}, f.at(2));
    assert.equal(f.store.database.isTransaction, true);
  } finally { f.store.database.exec("ROLLBACK"); }
  assert.equal(f.count("approval_requests"), 0);
  assert.equal(f.count("approval_checkpoints"), 0);
});

test("ordinary Run approvals still accept a fenced system reviewer without becoming merge consent", async t => {
  const f = await fixture(t), approval = f.runApproval(), round = f.round();
  const resolved = f.store.resolveApprovalBySystemReviewer(f.reviewInput(approval), f.at(6));
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.approval.actionType, "bash");
  assert.equal(resolved.approval.resolvedBy, "system-reviewer");
  assert.equal(resolved.approval.decisionKind, "approve_once");
  assert.deepEqual(f.round(), round);
});
