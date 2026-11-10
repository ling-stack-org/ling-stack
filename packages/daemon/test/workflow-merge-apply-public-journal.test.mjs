import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowMergeApplyStore,
  workflowIsolationDigest, workflowMergeApplyEffectEvidence } from "@ling-stack/core";
import { requestWorkflowMergeApproval } from "../dist/features/channels/workflow-merge-approval.js";
import { reconcileWorkflowMergeApplication } from "../dist/features/channels/workflow-merge-apply.js";
import { retainIntegrationArtifact } from "../dist/features/channels/workflow-integration-journal.js";
import { nativeGit, now, workflowIntegrationCoordinatorFixture } from "./support/workflow-integration-coordinator-fixture.mjs";

const rejection = { status: "invalid", code: "workflow_isolation.target_apply_receipt_requires_permit" };
const value = result => {
  assert.ok(["created", "updated", "duplicate"].includes(result.status), JSON.stringify(result));
  return result.value;
};

async function pendingApply(t) {
  const afters = [];
  const f = await workflowIntegrationCoordinatorFixture({ mock: t.mock, signal: t.signal,
    after(callback) { afters.push(callback); t.after(callback); } }, { stage: "running", mode: "apply_to_target" });
  // Drain real Host completion while keeping the step lease that authorizes the public journal.
  await afters[0]();
  const fence = f.prepared.fence;
  assert.equal(f.store.transitionRunStatus({ runId: f.runId, expectedStatus: "running", event: "runner_succeeded",
    actor: "runner", endedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "runner_succeeded",
    actor: "runner", endedAt: now(), now: now() }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "succeeded", endedAt: now(), now: now() }));
  f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: "succeeded", transitionedAt: now() },
    type: "work_unit_succeeded", actor: "runner", data: { runId: f.runId } });
  f.store.releaseHostAttemptResources({ runId: f.runId, ...fence }, now());
  assert.equal((await f.capture()).status, "sealed");
  assert.ok(f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { status: "succeeded" }, now()));
  assert.equal(f.store.database.prepare("SELECT status FROM resource_leases WHERE id=?")
    .get(f.generation.owner.leaseId).status, "active");
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  f.request = value(await requestWorkflowMergeApproval({ store: f.store, roundId: f.roundId, now }));
  f.store.approveApprovalRequest(f.request.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
  f.applications = createSqliteWorkflowMergeApplyStore(f.store);
  const ownerToken = "public-journal-test-host";
  const payloadArtifactId = retainIntegrationArtifact(f.store, f.runId,
    workflowMergeApplyEffectEvidence(f.request, ownerToken), "Test Host apply intent", now());
  f.permit = value(f.applications.beginApply({ approvalId: f.request.approvalId, expectedRevision: f.round().revision,
    ownerToken, payloadArtifactId, now: now() }));
  f.lease = () => f.store.database.prepare("SELECT * FROM resource_leases WHERE id=?").get(f.permit.leaseId);
  assert.equal(f.applications.assertPermit({ permitId: f.permit.permitId, ownerToken, now: now() }).status, "authorized");
  return f;
}

function snapshot(f) {
  const tables = ["workflow_integration_effect_links", "workflow_integration_receipt_links", "workflow_merge_apply_permits",
    "harness_artifact_pins", "harness_artifact_pin_events"];
  return { ...f.snapshotIsolation(), ...Object.fromEntries(tables.map(table =>
    [table, f.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) };
}

for (const outcome of ["confirmed", "blocked", "effect_unknown"]) {
  test(`public journal rejects target_apply ${outcome} and duplicates without disturbing dedicated recovery`, nativeGit, async t => {
    const f = await pendingApply(t), intent = f.isolation.getIntent(f.permit.intentId);
    assert.equal(intent.kind, "target_apply");
    assert.equal(intent.status, "pending");
    assert.equal(await f.git("rev-parse", "HEAD"), intent.before.headCommit);
    assert.notEqual(intent.before.headCommit, intent.after.headCommit);
    const artifact = f.store.createArtifact({ runId: f.runId, type: "json", path: `sqlite:public-apply-${outcome}`,
      sealedPayload: { genericObservation: true }, createdAt: now() });
    const input = { receiptId: `public-apply-${outcome}`, intentId: intent.intentId, expectedRevision: f.round().revision,
      writer: f.writer, outcome, observed: intent.after, artifactId: artifact.id, now: now() };
    const before = snapshot(f), git = await f.gitSnapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(f.isolation.recordReceipt(input), rejection);
      assert.deepEqual(snapshot(f), before);
    }
    assert.deepEqual(await f.gitSnapshot(), git);
    assert.equal(f.round().phase, "applying");
    assert.equal(f.round().openIntentId, intent.intentId);
    assert.equal(f.lease().status, "active");
    assert.equal(f.applications.inspectApplication({ approvalId: f.request.approvalId, now: now() }).status, "pending");

    const recoveryRevision = f.round().revision;
    const recovered = await reconcileWorkflowMergeApplication({ store: f.store, approvalId: f.request.approvalId, now });
    assert.equal(recovered.status, "not_applied", JSON.stringify(recovered));
    assert.equal(f.applications.inspectApplication({ approvalId: f.request.approvalId, now: now() }).status, "not_applied");
    assert.equal(f.round().phase, "blocked");
    assert.equal(f.round().openIntentId, undefined);
    assert.equal(f.lease().status, "released");
    assert.notEqual(f.workflow().status, "succeeded");
    assert.match(createSqliteWorkflowIntegrationCoordinatorStore(f.store).readCompletionBlocker(f.workflowId), /not_applied/);
    assert.deepEqual(await f.gitSnapshot(), git);
    const receipts = (await f.journal()).receipts.filter(receipt => receipt.intentId === intent.intentId);
    assert.equal(receipts.length, 1);
    const receipt = receipts[0];
    assert.equal(receipt.outcome, "confirmed");
    assert.deepEqual(receipt.observed, intent.before);
    assert.equal(f.isolation.getIntent(intent.intentId).status, "confirmed");
    assert.equal(f.store.getArtifact(receipt.artifactId).sealedPayload.evidence.disposition, "not_applied");

    // Replay the exact dedicated receipt so the regression reaches the generic duplicate branch without the guard.
    const duplicatePayload = { receiptId: receipt.receiptId, intentId: intent.intentId, expectedRevision: recoveryRevision,
      writer: f.writer, outcome: receipt.outcome, observed: receipt.observed, artifactId: receipt.artifactId };
    assert.equal(workflowIsolationDigest(duplicatePayload), receipt.digest);
    const settled = snapshot(f);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(f.isolation.recordReceipt({ ...duplicatePayload, now: now() }), rejection);
      assert.deepEqual(snapshot(f), settled);
    }
    assert.deepEqual(await f.gitSnapshot(), git);
    assert.equal((await reconcileWorkflowMergeApplication({ store: f.store, approvalId: f.request.approvalId, now })).status, "not_applied");
    assert.deepEqual(snapshot(f), settled);
    assert.deepEqual(await f.gitSnapshot(), git);
  });
}
