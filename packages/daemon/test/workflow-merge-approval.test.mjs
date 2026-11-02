import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSqliteWorkflowMergeApprovalStore, createSqliteWorkflowIntegrationCoordinatorStore,
  workflowMergeApprovalFingerprint, workflowMergeTargetSnapshotDigest } from "@ling-stack/core";
import { requestWorkflowMergeApproval } from "../dist/features/channels/workflow-merge-approval.js";
import { syncWorkflowApprovalDecision } from "../dist/features/channels/orchestrator.js";
import { reconcileApprovalPostCommitEffects } from "../dist/features/runs/approval-postcommit-effects.js";
import { verifyApprovalPostCommitEvidence } from "../dist/features/runs/approval-postcommit-evidence.js";
import { nativeGit, now, workflowIntegrationCoordinatorFixture } from "./support/workflow-integration-coordinator-fixture.mjs";

const value = result => {
  assert.ok(["created", "updated", "duplicate"].includes(result.status), JSON.stringify(result));
  return result.value;
};
async function fixture(t, options = {}) {
  const f = await workflowIntegrationCoordinatorFixture(t, { mode: "apply_to_target", ...options });
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  f.approvals = () => createSqliteWorkflowMergeApprovalStore(f.store);
  f.request = () => requestWorkflowMergeApproval({ store: f.store, roundId: f.roundId, now });
  f.inspect = approvalId => f.approvals().inspectApproval({ approvalId, now: now() });
  f.proposalRows = () => f.store.database.prepare("SELECT * FROM workflow_merge_approval_requests ORDER BY request_id").all();
  return f;
}

test("Host freezes a verified candidate and actual target snapshot atomically without touching Git", nativeGit, async t => {
  const f = await fixture(t), before = await f.gitSnapshot(), revision = f.round().revision;
  const proposal = value(await f.request()), { payload } = proposal;
  assert.equal(payload.type, "workflow_merge");
  assert.equal(payload.workflowStepId, f.plan.workflowStepId);
  assert.equal(payload.roundId, f.roundId);
  assert.deepEqual(payload.candidate, f.round().candidate);
  assert.equal(payload.target.expectedHead, before.target.head);
  assert.equal(workflowMergeTargetSnapshotDigest(payload.targetSnapshot), f.inputs.target.cleanStateDigest);
  const { fingerprint, ...basis } = payload;
  assert.equal(workflowMergeApprovalFingerprint(basis), fingerprint);
  assert.equal(f.round().revision, revision + 1);
  assert.equal(f.round().outstandingApprovalId, proposal.approvalId);
  const approval = f.store.getApprovalRequest(proposal.approvalId);
  assert.deepEqual(approval.payload, payload);
  assert.equal(approval.status, "pending");
  assert.deepEqual(approval.availableDecisions, ["approve_once", "deny"]);
  assert.equal(approval.runId, undefined);
  assert.equal(approval.taskId, undefined);
  assert.equal(f.inspect(approval.id).status, "pending");
  assert.notEqual(createSqliteWorkflowIntegrationCoordinatorStore(f.store).assertAuthority({
    roundId: f.roundId, generation: 1, now: now(), excludedMergeApprovalId: approval.id }).status, "authorized",
  "public authority never accepts a caller-supplied approval exemption");
  assert.deepEqual(await f.gitSnapshot(), before);
  assert.notEqual(f.workflow().status, "succeeded");
});

test("duplicate proposal and SQLite reopen preserve one approval and immutable basis", nativeGit, async t => {
  const f = await fixture(t), proposal = value(await f.request());
  const before = f.snapshotIsolation(), rows = f.proposalRows(), git = await f.gitSnapshot();
  for (const reopen of [false, true]) {
    if (reopen) f.reopenIsolation();
    const duplicate = await f.request();
    assert.equal(duplicate.status, "duplicate", JSON.stringify(duplicate));
    assert.deepEqual(duplicate.value, proposal);
    assert.deepEqual(f.approvals().getRequest(f.roundId, 1), proposal);
    assert.equal(f.inspect(proposal.approvalId).status, "pending");
    assert.deepEqual(f.snapshotIsolation(), before);
    assert.deepEqual(f.proposalRows(), rows);
    assert.deepEqual(await f.gitSnapshot(), git);
  }
  assert.throws(() => f.store.database.prepare("UPDATE workflow_merge_approval_requests SET authority_digest='foreign'").run(), /approval_immutable/);
  assert.throws(() => f.store.database.prepare("DELETE FROM workflow_merge_approval_requests").run(), /approval_retained/);
});

test("candidate-only round cannot acquire apply approval", nativeGit, async t => {
  const f = await fixture(t, { mode: "candidate_only" }), before = f.snapshotIsolation(), git = await f.gitSnapshot();
  assert.equal((await f.request()).status, "invalid");
  assert.deepEqual(f.proposalRows(), []);
  assert.deepEqual(f.snapshotIsolation(), before);
  assert.deepEqual(await f.gitSnapshot(), git);
});

for (const drift of ["head", "dirty", "branch", "configuration"]) {
  test(`Host refuses target ${drift} drift before creating any approval`, nativeGit, async t => {
    const f = await fixture(t);
    if (drift === "head") await f.git("commit", "--allow-empty", "-m", "user advanced target");
    if (drift === "dirty") await writeFile(join(f.cwd, "owned.txt"), "user WIP\n");
    if (drift === "branch") await f.git("checkout", "-b", "user-branch");
    if (drift === "configuration") await f.git("config", "core.abbrev", "12");
    const git = await f.gitSnapshot(), before = f.snapshotIsolation();
    assert.ok(["invalid", "blocked"].includes((await f.request()).status));
    assert.deepEqual(f.proposalRows(), []);
    assert.deepEqual(f.snapshotIsolation(), before);
    assert.deepEqual(await f.gitSnapshot(), git);
  });
}

test("local consent never runs the legacy gate or marks merge owner applied", nativeGit, async t => {
  const f = await fixture(t), proposal = value(await f.request()), before = await f.gitSnapshot();
  const approval = f.store.approveApprovalRequest(proposal.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
  assert.equal(f.inspect(approval.id).status, "approved");
  assert.deepEqual(syncWorkflowApprovalDecision(f.store, approval, now()), { status: "not_workflow_approval" });
  assert.equal(verifyApprovalPostCommitEvidence(f.store, approval, "owner").status, "pending");
  const result = reconcileApprovalPostCommitEffects({ store: f.store, approval, cwd: f.cwd, now: now(),
    onOwnerResolved: () => { assert.deepEqual(syncWorkflowApprovalDecision(f.store, approval, now()), { status: "not_workflow_approval" }); } });
  assert.equal(result.deferred, true);
  const owner = f.store.listApprovalPostCommitEffects({ approvalId: approval.id }).find(effect => effect.effectKind === "owner");
  assert.equal(owner.status, "pending");
  assert.equal(f.round().phase, "awaiting_approval");
  assert.notEqual(f.workflow().status, "succeeded");
  assert.deepEqual(await f.gitSnapshot(), before);
});

for (const decision of ["deny", "expire", "cancel"]) {
  test(`merge ${decision} leaves candidate and target intact after reopen`, nativeGit, async t => {
    const f = await fixture(t), proposal = value(await f.request()), before = await f.gitSnapshot(), candidate = f.round().candidate;
    const resolved = f.store[`${decision}ApprovalRequest`](proposal.approvalId, { resolvedBy: "local-user" }, now());
    const status = { deny: "denied", expire: "expired", cancel: "cancelled" }[decision];
    assert.equal(resolved.status, status);
    assert.equal(f.inspect(proposal.approvalId).status, status);
    f.reopenIsolation();
    assert.equal(f.inspect(proposal.approvalId).status, status);
    assert.deepEqual(f.round().candidate, candidate);
    assert.deepEqual(syncWorkflowApprovalDecision(f.store, resolved, now()), { status: "not_workflow_approval" });
    assert.deepEqual(await f.gitSnapshot(), before);
  });
}

for (const drift of ["channel-revoked", "cancelled", "candidate-artifact", "approval-payload", "checkpoint-payload"]) {
  test(`inspection rejects ${drift} after approval rather than trusting consent`, nativeGit, async t => {
    const f = await fixture(t), proposal = value(await f.request());
    f.store.approveApprovalRequest(proposal.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
    if (drift === "channel-revoked") f.store.database.prepare("UPDATE channels SET allowed_tools_json='[]' WHERE id=?").run(f.channel.id);
    if (drift === "cancelled") f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.workflowId);
    if (drift === "candidate-artifact") {
      const artifact = f.store.listArtifacts(f.runId).find(a => a.sealedPayload?.kind === "workflow_integration_coordinator_receipt"
        && a.sealedPayload.evidence?.kind === "workflow_candidate_verification");
      f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(artifact.id);
    }
    if (drift === "approval-payload") f.store.database.prepare("UPDATE approval_requests SET payload_json='{}' WHERE id=?").run(proposal.approvalId);
    if (drift === "checkpoint-payload") f.store.database.prepare("UPDATE approval_checkpoints SET side_effect_json='{}' WHERE approval_id=?").run(proposal.approvalId);
    const before = f.snapshotIsolation(), git = await f.gitSnapshot();
    assert.equal(f.inspect(proposal.approvalId).status, "blocked");
    assert.deepEqual(f.snapshotIsolation(), before);
    assert.deepEqual(await f.gitSnapshot(), git);
  });
}

test("approval proposal and round attachment roll back together on a failed CAS update", nativeGit, async t => {
  const f = await fixture(t), before = f.snapshotIsolation(), git = await f.gitSnapshot();
  f.store.database.exec(`CREATE TRIGGER reject_merge_attachment BEFORE UPDATE OF outstanding_approval_id ON workflow_integration_generations
    WHEN NEW.outstanding_approval_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'test-merge-attachment'); END`);
  assert.equal((await f.request()).status, "blocked");
  assert.equal(f.store.database.isTransaction, false);
  assert.deepEqual(f.proposalRows(), []);
  assert.deepEqual(f.snapshotIsolation(), before);
  assert.deepEqual(await f.gitSnapshot(), git);
});
