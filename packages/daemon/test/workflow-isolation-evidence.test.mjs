import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteWorkflowMergeApplyStore, workflowMergeApplyEffectEvidence } from "@ling-stack/core";
import { buildWorkflowIsolationEvidence } from "../dist/features/channels/workflow-isolation-evidence.js";
import { buildWorkflowEvidence, projectPublicWorkflowEvidence } from "../dist/features/channels/workflow-evidence.js";
import { requestWorkflowMergeApproval } from "../dist/features/channels/workflow-merge-approval.js";
import { applyApprovedWorkflowMerge } from "../dist/features/channels/workflow-merge-apply.js";
import { retainIntegrationArtifact } from "../dist/features/channels/workflow-integration-journal.js";
import { runWorkflowIsolationOperation } from "../dist/features/channels/workflow-isolation-lifecycle.js";
import { workflowAdmissionFixture } from "../../core/test/support/workflow-step-admission-fixture.mjs";
import { nativeGit, now, workflowIntegrationCoordinatorFixture } from "./support/workflow-integration-coordinator-fixture.mjs";

const read = f => buildWorkflowIsolationEvidence(f.store, f.workflowId, now());
const value = result => {
  assert.ok(["created", "updated", "duplicate"].includes(result.status), JSON.stringify(result));
  return result.value;
};
const keys = object => Object.entries(object ?? {}).flatMap(([key, entry]) => [key,
  ...(entry && typeof entry === "object" ? keys(entry) : [])]);

test("ordinary stores omit isolation while pinned unavailable evidence remains explicit", async t => {
  assert.equal(buildWorkflowIsolationEvidence({ listChannelWorkflowSteps: () => [] }, "ordinary"), undefined);
  const pinned = { listChannelWorkflowSteps: () => [{ metadata: { isolationScopePlan: { planId: "missing" } } }] };
  assert.deepEqual(buildWorkflowIsolationEvidence(pinned, "pinned"), { schemaVersion: 1, status: "unavailable", rounds: [],
    gitEffects: "unconfirmed", hostOperationPending: false, completion: "blocked", reasonCode: "workflow_isolation.evidence_unavailable" });
  const f = await workflowAdmissionFixture(t), scope = f.scope("no-isolation");
  assert.equal(buildWorkflowIsolationEvidence(f.store, scope.workflow.id), undefined);
  f.store.updateChannelWorkflowStep(scope.step.id, { metadata: { isolationScopePlan: { planId: "missing", planDigest: `wip1_${"0".repeat(64)}` } } }, f.at(1));
  assert.equal(buildWorkflowIsolationEvidence(f.store, scope.workflow.id).reasonCode, "workflow_isolation.round_evidence_missing");
});

test("running isolation is a read-only whitelisted observation, not completion or write authority", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { stage: "running" });
  const before = await f.integrationSnapshot(), changes = f.store.database.prepare("SELECT total_changes() n").get().n;
  const evidence = read(f), round = evidence.rounds[0];
  assert.equal(evidence.status, "available");
  assert.equal(evidence.completion, "blocked");
  assert.equal(round.roundId, f.roundId);
  assert.equal(round.phase, f.round().phase);
  assert.equal(round.maxConcurrentSteps, 1);
  assert.deepEqual(round.participants, [{ workflowStepId: f.plan.workflowStepId, required: true }]);
  assert.equal(round.candidate, undefined);
  assert.equal(round.approval, undefined);
  assert.deepEqual(round.application, { status: "not_started", reasonCode: undefined });
  assert.deepEqual(await f.integrationSnapshot(), before, "reading must not reconcile or mutate durable evidence or Git");
  assert.equal(f.store.database.prepare("SELECT total_changes() n").get().n, changes);
  for (const key of ["ownerToken", "leaseId", "bindingId", "fence", "fencingToken", "requestSnapshot", "preparedInput", "inputs"])
    assert.equal(keys(evidence).includes(key), false, `public isolation never exposes ${key}`);
  assert.equal(JSON.stringify(evidence).includes(f.cwd), false, "the read model does not expose physical repository paths");
  const publicEvidence = projectPublicWorkflowEvidence(buildWorkflowEvidence(f.store, f.workflowId));
  assert.deepEqual(publicEvidence.isolation, evidence, "the existing HTTP evidence projection includes the new read model");
});

test("candidate-only delivery remains candidate-only after reopen and pin removal cannot hide a round", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t);
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  const evidence = read(f), round = evidence.rounds[0];
  assert.equal(evidence.completion, "ready");
  assert.equal(round.mode, "candidate_only");
  assert.equal(round.application.status, "not_started");
  assert.deepEqual(round.candidate, { commit: f.round().candidate.commit, tree: f.round().candidate.tree });
  assert.ok(round.effects.some(effect => effect.kind === "candidate_verify" && effect.status === "confirmed" && effect.artifactIds.length));
  f.reopenIsolation();
  assert.deepEqual(read(f), evidence);
  const { isolationScopePlan: _pin, ...metadata } = f.step().metadata;
  f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { metadata }, now());
  const after = read(f);
  assert.equal(after.rounds[0].roundId, f.roundId);
  assert.equal(after.completion, "blocked");
});

test("pending and approved merge consent never project as applied before the actual Host merge", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { mode: "apply_to_target" });
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  const request = value(await requestWorkflowMergeApproval({ store: f.store, roundId: f.roundId, now }));
  const pending = read(f);
  assert.equal(pending.rounds[0].approval.status, "pending");
  assert.equal(pending.rounds[0].application.status, "not_started");
  assert.equal(pending.completion, "blocked");
  f.store.approveApprovalRequest(request.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
  const approved = read(f);
  assert.equal(approved.rounds[0].approval.status, "approved");
  assert.equal(approved.rounds[0].application.status, "not_started");
  assert.equal(approved.rounds[0].phase, "awaiting_approval");
  assert.equal(approved.completion, "blocked");
  assert.equal((await applyApprovedWorkflowMerge({ store: f.store, approvalId: request.approvalId, now })).status, "applied");
  const applied = read(f);
  assert.equal(applied.rounds[0].application.status, "applied");
  assert.equal(applied.rounds[0].phase, "applied");
  assert.equal(applied.gitEffects, "confirmed");
  assert.equal(applied.completion, "ready");
  assert.equal((await f.targetSnapshot()).head, applied.rounds[0].candidate.commit);
  f.reopenIsolation();
  assert.deepEqual(read(f), applied, "reload observes the same confirmed apply without executing anything");
});

test("an unresolved apply intent stays unconfirmed on reads and after SQLite reopen", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { mode: "apply_to_target" });
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  const request = value(await requestWorkflowMergeApproval({ store: f.store, roundId: f.roundId, now }));
  f.store.approveApprovalRequest(request.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
  const ownerToken = "private-host-owner", payload = workflowMergeApplyEffectEvidence(request, ownerToken);
  const payloadArtifactId = retainIntegrationArtifact(f.store, f.runId, payload, "Test pending apply intent", now());
  value(createSqliteWorkflowMergeApplyStore(f.store).beginApply({ approvalId: request.approvalId,
    expectedRevision: f.round().revision, ownerToken, payloadArtifactId, now: now() }));
  const before = await f.integrationSnapshot(), evidence = read(f);
  assert.equal(evidence.gitEffects, "unconfirmed");
  assert.equal(evidence.completion, "blocked");
  assert.equal(evidence.rounds[0].application.status, "pending");
  assert.equal(evidence.rounds[0].phase, "applying");
  assert.equal(JSON.stringify(evidence).includes(ownerToken), false);
  assert.deepEqual(await f.integrationSnapshot(), before);
  f.reopenIsolation();
  assert.deepEqual(read(f), evidence);
  assert.deepEqual(await f.integrationSnapshot(), before, "read-side reload must not replay or settle the unknown Git effect");
});

test("workflow cancellation is distinct from an original Host callback that has not drained", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t, { stage: "running" });
  let finish;
  const pending = runWorkflowIsolationOperation(f.store, f.workflowId, "read-model-drain-proof",
    () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.workflowId);
  try {
    const evidence = read(f);
    assert.equal(f.workflow().status, "cancelled");
    assert.equal(evidence.hostOperationPending, true);
    assert.equal(evidence.gitEffects, "unconfirmed");
    assert.equal(evidence.completion, "blocked");
    assert.notEqual(evidence.rounds[0].application.status, "applied");
  } finally { finish(); await pending; }
  assert.equal(read(f).hostOperationPending, false);
  assert.equal(read(f).completion, "blocked", "a drained local callback alone does not establish successful delivery");
});
