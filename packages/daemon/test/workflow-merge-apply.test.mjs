import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { createSqliteWorkflowMergeApprovalStore, createSqliteWorkflowMergeApplyStore, createSqliteWorkflowIntegrationCoordinatorStore,
  workflowMergeApplyEffectEvidence, workflowMergeApplyDisposition, workflowMergeApplyObservedIdentity }
  from "@ling-stack/core";
import { requestWorkflowMergeApproval } from "../dist/features/channels/workflow-merge-approval.js";
import { applyApprovedWorkflowMerge, reconcileWorkflowMergeApplication } from "../dist/features/channels/workflow-merge-apply.js";
import { observeWorkflowGitApply } from "../dist/features/workspaces/workflow-git-apply.js";
import { retainIntegrationArtifact } from "../dist/features/channels/workflow-integration-journal.js";
import { recoverWorkflowIsolationsAtStartup } from "../dist/features/channels/workflow-isolation-recovery.js";
import { verifyApprovalPostCommitEvidence } from "../dist/features/runs/approval-postcommit-evidence.js";
import { reconcileApprovalPostCommitEffects } from "../dist/features/runs/approval-postcommit-effects.js";
import { handleApprovalItem } from "../dist/features/runs/routes.js";
import { nativeGit, now, workflowIntegrationCoordinatorFixture } from "./support/workflow-integration-coordinator-fixture.mjs";

const value = result => {
  assert.ok(["created", "updated", "duplicate"].includes(result.status), JSON.stringify(result));
  return result.value;
};
async function fixture(t, { approve = true } = {}) {
  const f = await workflowIntegrationCoordinatorFixture(t, { mode: "apply_to_target" });
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  f.request = value(await requestWorkflowMergeApproval({ store: f.store, roundId: f.roundId, now }));
  f.approvals = () => createSqliteWorkflowMergeApprovalStore(f.store);
  f.applications = () => createSqliteWorkflowMergeApplyStore(f.store);
  f.approval = () => f.store.getApprovalRequest(f.request.approvalId);
  f.permit = () => f.applications().getPermit(f.roundId, 1);
  f.inspect = () => f.applications().inspectApplication({ approvalId: f.request.approvalId, now: now() });
  f.apply = () => applyApprovedWorkflowMerge({ store: f.store, approvalId: f.request.approvalId, now });
  f.reconcile = () => reconcileWorkflowMergeApplication({ store: f.store, approvalId: f.request.approvalId, now });
  f.lease = () => f.store.database.prepare("SELECT * FROM resource_leases WHERE id=?").get(f.permit()?.leaseId ?? "");
  f.target = { expectedRepository: f.request.payload.targetSnapshot, expectedHead: f.request.payload.target.expectedHead,
    candidateCommit: f.request.payload.candidate.commit, candidateTree: f.request.payload.candidate.tree };
  f.begin = (ownerToken = "test-host-owner") => {
    const payload = workflowMergeApplyEffectEvidence(f.request, ownerToken);
    const payloadArtifactId = retainIntegrationArtifact(f.store, f.runId, payload, "Test Host apply intent", now());
    return f.applications().beginApply({ approvalId: f.request.approvalId, expectedRevision: f.round().revision,
      ownerToken, payloadArtifactId, now: now() });
  };
  f.observationArtifact = async () => {
    const observation = await observeWorkflowGitApply(f.target), permit = f.permit();
    const disposition = workflowMergeApplyDisposition(f.request.payload, observation);
    const evidence = { schemaVersion: 1, kind: "workflow_merge_apply_observation", permitId: permit.permitId,
      approvalId: permit.approvalId, disposition, observation };
    const payload = { schemaVersion: 1, kind: "workflow_integration_coordinator_receipt", intentId: permit.intentId,
      effectKey: "target:apply", outcome: disposition === "unknown" ? "effect_unknown" : "confirmed",
      observed: workflowMergeApplyObservedIdentity(f.request.payload, observation), evidence };
    return retainIntegrationArtifact(f.store, f.runId, payload, "Test Host apply observation", now());
  };
  f.fastForward = () => f.git("merge", "--ff-only", "--no-edit", "--no-autostash", f.target.candidateCommit);
  if (approve) f.store.approveApprovalRequest(f.request.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
  return f;
}

async function approveThroughRoute(t, f) {
  const server = createServer((request, response) => {
    void handleApprovalItem(request, response, { host: "127.0.0.1", port: 0, maxBodyBytes: 4096 },
      { getStore: () => f.store }, { approvalId: f.request.approvalId, action: "approve" }, undefined);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/approvals/${f.request.approvalId}/approve?cwd=${encodeURIComponent(f.cwd)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionKind: "approve_once" }) });
  return { status: response.status, body: await response.json() };
}

test("one Host permit applies the frozen candidate, releases its exact lease and completes canonical workflow", nativeGit, async t => {
  const f = await fixture(t), before = await f.gitSnapshot(), candidate = f.round().candidate;
  const result = await f.apply();
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.equal(f.inspect().status, "applied", JSON.stringify(f.inspect()));
  assert.equal(f.round().phase, "applied");
  assert.equal(f.round().openIntentId, undefined);
  assert.equal(f.workflow().status, "succeeded");
  assert.equal((await f.targetSnapshot()).head, candidate.commit);
  assert.equal(await f.ref(f.scopeGit.branchRef), before.branchHead, "cleanup retains the unchanged owned branch ref");
  assert.equal(f.lease().status, "released");
  assert.deepEqual(f.round().candidate, candidate);
  const journal = await f.journal(), effects = journal.effects.filter(effect => effect.kind === "target_apply");
  assert.equal(effects.length, 1);
  assert.equal(effects[0].status, "confirmed");
  assert.equal(journal.receipts.filter(receipt => receipt.intentId === f.permit().intentId).length, 1);
  assert.equal(verifyApprovalPostCommitEvidence(f.store, f.approval(), "owner").status, "applied");
  assert.equal(createSqliteWorkflowIntegrationCoordinatorStore(f.store).readCompletionBlocker(f.workflowId), undefined);
});

test("concurrent calls and SQLite reopen observe one apply and never repeat Git or its intent", nativeGit, async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.apply()));
  for (const result of results) assert.equal(result.status, "applied", JSON.stringify(result));
  const permit = f.permit(), before = await f.gitSnapshot();
  f.reopenIsolation();
  assert.deepEqual(f.permit(), permit);
  assert.equal((await f.apply()).status, "applied");
  assert.equal((await f.reconcile()).status, "applied");
  assert.deepEqual(await f.gitSnapshot(), before);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM workflow_merge_apply_permits").get().n, 1);
  assert.equal(f.applications().assertPermit({ permitId: permit.permitId, ownerToken: permit.ownerToken, now: now() }).status, "blocked");
});

test("restart after consent but before intent never starts a merge", nativeGit, async t => {
  const f = await fixture(t), before = await f.gitSnapshot();
  f.reopenIsolation();
  assert.equal((await f.reconcile()).status, "waiting");
  await recoverWorkflowIsolationsAtStartup(f.store);
  assert.equal(f.permit(), undefined);
  assert.equal(f.inspect().status, "not_started");
  assert.deepEqual(await f.gitSnapshot(), before);
  assert.notEqual(f.workflow().status, "succeeded");
});

test("crash after intent but before Git safely retires the exact unchanged target without replay", nativeGit, async t => {
  const f = await fixture(t), permit = value(f.begin()), before = await f.gitSnapshot();
  assert.equal(f.round().phase, "applying");
  assert.equal(f.lease().status, "active");
  f.reopenIsolation();
  assert.equal((await f.apply()).status, "not_applied");
  assert.equal(f.inspect().status, "not_applied");
  assert.equal(f.round().phase, "blocked");
  assert.equal(f.round().openIntentId, undefined);
  assert.equal(f.lease().status, "released");
  assert.deepEqual(await f.gitSnapshot(), before);
  const observation = (await f.journal()).receipts.find(receipt => receipt.intentId === permit.intentId);
  assert.equal(observation.outcome, "confirmed");
  assert.equal(f.store.getArtifact(observation.artifactId).sealedPayload.evidence.disposition, "not_applied");
  assert.notEqual(f.workflow().status, "succeeded");
  assert.match(createSqliteWorkflowIntegrationCoordinatorStore(f.store).readCompletionBlocker(f.workflowId), /not_applied/);
});

test("crash after Git before receipt recovers a clean exact candidate and completes without another merge", nativeGit, async t => {
  const f = await fixture(t);
  value(f.begin()); await f.fastForward();
  const before = await f.gitSnapshot();
  f.reopenIsolation();
  await recoverWorkflowIsolationsAtStartup(f.store);
  assert.equal(f.inspect().status, "applied", JSON.stringify(f.inspect()));
  assert.equal(f.workflow().status, "succeeded");
  assert.equal(f.lease().status, "released");
  assert.deepEqual(await f.gitSnapshot(), before);
});

for (const decision of ["deny", "expire", "cancel"]) {
  test(`${decision} cannot mint a permit or apply and postcommit settles no-effect evidence`, nativeGit, async t => {
    const f = await fixture(t, { approve: false }), before = await f.gitSnapshot();
    f.store[`${decision}ApprovalRequest`](f.request.approvalId, { resolvedBy: "local-user" }, now());
    assert.equal((await f.apply()).status, "blocked");
    assert.equal(f.permit(), undefined);
    assert.equal(f.begin().status, "stale");
    assert.deepEqual(await f.gitSnapshot(), before);
    assert.equal(verifyApprovalPostCommitEvidence(f.store, f.approval(), "owner").status, "applied");
  });
}

for (const drift of ["head", "dirty", "branch", "config", "untracked", "index"]) {
  test(`post-consent ${drift} drift blocks before intent and preserves user checkout`, nativeGit, async t => {
    const f = await fixture(t);
    if (drift === "head") await f.git("commit", "--allow-empty", "-m", "user advance");
    if (["dirty", "index"].includes(drift)) await writeFile(join(f.cwd, "owned.txt"), "user WIP\n");
    if (drift === "index") await f.git("add", "--", "owned.txt");
    if (drift === "branch") await f.git("checkout", "-b", "user-branch");
    if (drift === "config") await f.git("config", "core.abbrev", "12");
    if (drift === "untracked") await writeFile(join(f.cwd, "private-user-file.txt"), "private\n");
    const before = await f.gitSnapshot();
    assert.equal((await f.apply()).status, "blocked");
    assert.equal(f.permit(), undefined);
    assert.deepEqual(await f.gitSnapshot(), before);
  });
}

for (const drift of ["channel-revoked", "cancelled", "expired", "candidate-artifact"]) {
  test(`${drift} after consent cannot acquire apply authority`, nativeGit, async t => {
    const f = await fixture(t);
    if (drift === "channel-revoked") f.store.database.prepare("UPDATE channels SET allowed_tools_json='[]' WHERE id=?").run(f.channel.id);
    if (drift === "cancelled") f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.workflowId);
    if (drift === "expired") t.mock.timers.tick(11 * 60_000);
    if (drift === "candidate-artifact") {
      const artifact = f.store.listArtifacts(f.runId).find(a => a.sealedPayload?.evidence?.kind === "workflow_candidate_verification");
      f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(artifact.id);
    }
    const before = await f.gitSnapshot();
    assert.equal((await f.apply()).status, "blocked");
    assert.equal(f.permit(), undefined);
    assert.deepEqual(await f.gitSnapshot(), before);
  });
}

test("dirty uncertain target keeps lease and intent across expiry/reopen; clean observation retires without writing", nativeGit, async t => {
  const f = await fixture(t), permit = value(f.begin());
  await writeFile(join(f.cwd, "owned.txt"), "user WIP after intent\n");
  const before = await f.gitSnapshot();
  assert.equal((await f.reconcile()).status, "effect_unknown");
  assert.equal(f.inspect().status, "effect_unknown");
  t.mock.timers.tick(11 * 60_000);
  f.store.expireResourceLeases(now());
  assert.equal(f.store.releaseResourceLease(permit.leaseId, "system", permit.permitId, now()), 0);
  assert.equal(f.store.releaseResourceLeasesForOwner("system", permit.permitId, now()), 0);
  assert.equal(f.lease().status, "active");
  f.reopenIsolation();
  assert.equal((await f.reconcile()).status, "effect_unknown");
  assert.deepEqual(await f.gitSnapshot(), before);
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  assert.equal((await f.reconcile()).status, "not_applied");
  assert.equal(f.lease().status, "released");
  assert.equal(createSqliteWorkflowIntegrationCoordinatorStore(f.store).readPublicationBlocker(f.workflowId), undefined);
});

for (const drift of ["cancelled", "channel-revoked", "expired"]) {
  test(`physical candidate after ${drift} is retained but never reported as successful application`, nativeGit, async t => {
    const f = await fixture(t);
    value(f.begin()); await f.fastForward();
    if (drift === "cancelled") f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.workflowId);
    if (drift === "channel-revoked") f.store.database.prepare("UPDATE channels SET allowed_tools_json='[]' WHERE id=?").run(f.channel.id);
    if (drift === "expired") t.mock.timers.tick(11 * 60_000);
    const before = await f.gitSnapshot();
    f.reopenIsolation();
    assert.equal((await f.reconcile()).status, "blocked", JSON.stringify(f.inspect()));
    assert.equal(f.inspect().status, "blocked");
    assert.equal(f.round().phase, "blocked");
    assert.equal(f.lease().status, "released");
    assert.notEqual(f.workflow().status, "succeeded");
    assert.deepEqual(await f.gitSnapshot(), before);
    const receipt = (await f.journal()).receipts.find(receipt => receipt.intentId === f.permit().intentId && receipt.outcome === "confirmed");
    assert.equal(f.store.getArtifact(receipt.artifactId).sealedPayload.evidence.disposition, "applied");
    assert.equal(createSqliteWorkflowIntegrationCoordinatorStore(f.store).readPublicationBlocker(f.workflowId), undefined);
  });
}

test("generic coordinator cannot confirm target apply even with an exact valid observation", nativeGit, async t => {
  const f = await fixture(t), permit = value(f.begin());
  const artifactId = await f.observationArtifact(), body = f.store.getArtifact(artifactId).sealedPayload;
  const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(f.store);
  const result = coordinator.recordReceipt({ intentId: permit.intentId, expectedRevision: f.round().revision,
    authorityDigest: permit.authorityDigest, outcome: body.outcome, observed: body.observed, artifactId, now: now() });
  assert.equal(result.status, "invalid");
  assert.match(result.code, /target_apply_receipt_requires_permit/);
  assert.equal(f.lease().status, "active");
  assert.equal(f.applications().assertPermit({ permitId: permit.permitId, ownerToken: "another-host", now: now() }).status, "blocked");
});

test("begin CAS failure rolls back permit, generic journal and target lease together", nativeGit, async t => {
  const f = await fixture(t), before = f.snapshotIsolation(), git = await f.gitSnapshot();
  const leases = f.store.database.prepare("SELECT * FROM resource_leases ORDER BY id").all();
  f.store.database.exec(`CREATE TRIGGER reject_apply_phase BEFORE UPDATE OF phase ON workflow_integration_generations
    WHEN NEW.phase='applying' BEGIN SELECT RAISE(ABORT,'test-apply-phase'); END`);
  assert.throws(() => f.begin(), /test-apply-phase/);
  assert.equal(f.store.database.isTransaction, false);
  assert.equal(f.permit(), undefined);
  assert.deepEqual(f.snapshotIsolation(), before);
  assert.deepEqual(f.store.database.prepare("SELECT * FROM resource_leases ORDER BY id").all(), leases);
  assert.deepEqual(await f.gitSnapshot(), git);
});

test("receipt CAS failure retains pending intent and lease until read-only recovery succeeds", nativeGit, async t => {
  const f = await fixture(t), permit = value(f.begin());
  await f.fastForward();
  const artifactId = await f.observationArtifact(), revision = f.round().revision;
  f.store.database.exec(`CREATE TRIGGER reject_applied_phase BEFORE UPDATE OF phase ON workflow_integration_generations
    WHEN NEW.phase='applied' BEGIN SELECT RAISE(ABORT,'test-applied-phase'); END`);
  assert.throws(() => f.applications().recordObservation({ permitId: permit.permitId, expectedRevision: revision, artifactId, now: now() }), /test-applied-phase/);
  assert.equal(f.round().revision, revision);
  assert.equal(f.isolation.getIntent(permit.intentId).status, "pending");
  assert.equal(f.lease().status, "active");
  assert.equal((await f.journal()).receipts.filter(receipt => receipt.intentId === permit.intentId).length, 0);
  f.store.database.exec("DROP TRIGGER reject_applied_phase");
  assert.equal((await f.reconcile()).status, "applied");
});

test("approval postcommit completion follows applied evidence and never launches Git on its own", nativeGit, async t => {
  const f = await fixture(t), before = await f.gitSnapshot();
  const reconcile = () => reconcileApprovalPostCommitEffects({ store: f.store, approval: f.approval(), cwd: f.cwd, now: now() });
  assert.equal(reconcile().deferred, true);
  assert.equal(f.permit(), undefined);
  assert.deepEqual(await f.gitSnapshot(), before);
  assert.equal((await f.apply()).status, "applied");
  assert.equal(reconcile().deferred, false);
  assert.equal(f.store.listApprovalPostCommitEffects({ approvalId: f.request.approvalId }).find(effect => effect.effectKind === "owner").status, "completed");
});

test("actual approval HTTP route awaits tracked apply and reports the committed successful owner", nativeGit, async t => {
  const f = await fixture(t, { approve: false });
  const response = await approveThroughRoute(t, f);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.approval.status, "approved");
  assert.equal(response.body.postCommit, undefined);
  assert.equal(f.inspect().status, "applied", JSON.stringify(f.inspect()));
  assert.equal(f.workflow().status, "succeeded");
});

test("lost apply receipt cannot turn committed HTTP consent into failure and startup only reconciles", nativeGit, async t => {
  const f = await fixture(t, { approve: false });
  const applications = f.applications();
  applications.recordObservation = () => { throw new Error("injected-receipt-loss"); };
  const response = await approveThroughRoute(t, f);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.approval.status, "approved");
  assert.equal(response.body.postCommit.status, "deferred");
  assert.equal((await f.targetSnapshot()).head, f.target.candidateCommit);
  assert.equal(f.lease().status, "active");
  assert.notEqual(f.workflow().status, "succeeded");
  const before = await f.gitSnapshot();
  f.reopenIsolation();
  assert.equal((await f.reconcile()).status, "applied", JSON.stringify(f.inspect()));
  assert.deepEqual(await f.gitSnapshot(), before);
});

test("cancel during durable intent creation stops Git and settles a verified not-applied observation", nativeGit, async t => {
  const f = await fixture(t), applications = f.applications(), begin = applications.beginApply.bind(applications);
  applications.beginApply = input => {
    const result = begin(input);
    f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.workflowId);
    return result;
  };
  const before = await f.gitSnapshot();
  assert.equal((await f.apply()).status, "not_applied");
  assert.equal(f.inspect().status, "not_applied");
  assert.equal(f.workflow().status, "cancelled");
  assert.equal(f.lease().status, "released");
  assert.deepEqual(await f.gitSnapshot(), before);
});

test("cancel between Git and receipt records physical application without publishing success", nativeGit, async t => {
  const f = await fixture(t), applications = f.applications(), record = applications.recordObservation.bind(applications);
  applications.recordObservation = input => {
    f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.workflowId);
    return record(input);
  };
  assert.equal((await f.apply()).status, "blocked", JSON.stringify(f.inspect()));
  assert.equal((await f.targetSnapshot()).head, f.target.candidateCommit);
  assert.equal(f.inspect().status, "blocked");
  assert.equal(f.workflow().status, "cancelled");
  assert.equal(f.lease().status, "released");
});
