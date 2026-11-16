import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteWorkflowWorktreeCleanupStore } from "@ling-stack/core";
import { completeWorkflowIfStepsFinished } from "../dist/features/channels/workflow-completion.js";
import { retainIntegrationArtifact } from "../dist/features/channels/workflow-integration-journal.js";
import { readWorkflowStepContextPacketArtifact } from "../dist/features/channels/workflow-step-packets.js";
import { nativeGit, now, workflowIntegrationCoordinatorFixture } from "./support/workflow-integration-coordinator-fixture.mjs";

async function fixture(t) {
  const f = await workflowIntegrationCoordinatorFixture(t);
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  completeWorkflowIfStepsFinished(f.store, f.workflowId, now());
  assert.equal(f.workflow().status, "succeeded");
  f.cleanup = createSqliteWorkflowWorktreeCleanupStore(f.store);
  f.scope = { roundId: f.roundId, generation: 1, worktreeId: f.integrationScope.worktreeId };
  const inspected = f.cleanup.inspect({ ...f.scope, now: now() });
  assert.equal(inspected.status, "eligible", JSON.stringify(inspected));
  f.plan = inspected.plan;
  f.artifact = body => retainIntegrationArtifact(f.store, f.runId, body, "Cleanup store evidence", now());
  f.begin = (extra = {}) => f.cleanup.begin({ ...f.scope, ownerToken: "cleanup-store-owner",
    planArtifactId: f.artifact({ ...f.plan }), now: now(), ...extra });
  f.observe = (intent, state, extra = {}) => {
    const observation = { state, executionRoot: f.plan.scope.executionRoot, worktreeId: f.plan.scope.worktreeId,
      branchRef: f.plan.scope.branchRef, commonDir: f.plan.scope.repository.commonDir, retainedRefs: f.plan.retainedRefs, ...extra };
    return f.cleanup.recordObservation({ cleanupId: intent.cleanupId, artifactId: f.artifact({ schemaVersion: 1,
      kind: "workflow_worktree_cleanup_observation", cleanupId: intent.cleanupId, planDigest: intent.planDigest, observation }), now: now() });
  };
  f.count = table => Number(f.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  return f;
}

test("cleanup store is Host composition only, not an adapter inferred from arbitrary RunStore objects", () => {
  assert.throws(() => createSqliteWorkflowWorktreeCleanupStore({}), /store_not_sqlite/);
});

test("inspect and begin retain original creation and all branch, terminal, integration evidence without changing Git or delivery", nativeGit, async t => {
  const f = await fixture(t), before = await f.gitSnapshot(), journal = await f.journal();
  assert.equal(f.plan.role, "integration");
  assert.equal(f.plan.scope.executionRoot, f.integrationScope.executionRoot);
  assert.ok(f.plan.retainedRefs.some(ref => ref.ref === f.resultRef));
  assert.ok(f.plan.retainedRefs.some(ref => ref.ref.endsWith("/candidate")));
  assert.ok(f.plan.artifactIds.includes(f.intent().packetArtifactId));
  assert.equal(f.contextArtifact.sealedPayload, undefined, "production contexts are file-backed");
  const packet = f.store.getArtifact(f.intent().packetArtifactId).sealedPayload;
  assert.ok(packet.terminal.contextArtifactRefs.length > 0);
  for (const id of packet.terminal.contextArtifactRefs) {
    assert.ok(f.plan.artifactIds.includes(id));
    const snapshot = f.store.getArtifact(id).sealedPayload;
    assert.equal(snapshot.kind, "workflow_isolation_context");
    assert.equal(snapshot.sourceArtifactId, f.contextArtifact.id);
    assert.deepEqual(snapshot.packet, readWorkflowStepContextPacketArtifact({ store: f.store, artifactId: f.contextArtifact.id }));
  }
  const result = f.begin();
  assert.equal(result.status, "created", JSON.stringify(result));
  const intent = result.value;
  assert.equal(f.cleanup.assertIntent({ cleanupId: intent.cleanupId, ownerToken: intent.ownerToken, now: now() }).status, "eligible");
  const pins = f.store.database.prepare("SELECT artifact_id FROM harness_artifact_pins WHERE holder LIKE 'host:workflow_cleanup:%' AND released_at IS NULL").all();
  assert.deepEqual(pins.map(row => row.artifact_id).sort(), [intent.planArtifactId, ...f.plan.artifactIds].sort());
  assert.deepEqual(await f.gitSnapshot(), before);
  assert.deepEqual(await f.journal(), journal);
  assert.equal(f.workflow().status, "succeeded");
});

test("existing intent is observation-only, preserves the original token, and is readable after workflow pins are revoked", nativeGit, async t => {
  const f = await fixture(t), intent = f.begin().value;
  assert.equal(f.cleanup.inspect({ ...f.scope, now: now() }).status, "retained");
  assert.equal(f.cleanup.assertIntent({ cleanupId: intent.cleanupId, ownerToken: "another-owner", now: now() }).status, "retained");
  const metadata = { ...f.step().metadata };
  delete metadata.isolationScopePlan;
  f.store.updateChannelWorkflowStep(f.step().id, { metadata }, now());
  const workflowMetadata = structuredClone(f.workflow().metadata);
  assert.throws(() => f.store.updateChannelWorkflow(f.workflowId, {
    metadata: { ...workflowMetadata, workflowGraphFingerprint: "revoked" },
  }, now()), /workflow_isolation\.completion_evidence_invalid/);
  assert.deepEqual(f.workflow().metadata, workflowMetadata);
  assert.deepEqual(f.begin({ ownerToken: "new-owner" }), { status: "duplicate", value: intent });
  assert.equal(f.cleanup.assertIntent({ cleanupId: intent.cleanupId, ownerToken: intent.ownerToken, now: now() }).status, "retained");
  assert.deepEqual(f.cleanup.listIntents({ workflowId: f.workflowId, roundId: f.roundId, generation: 1 }), [intent]);
  assert.deepEqual(f.cleanup.listIntents({ workflowId: "unrelated-workflow" }), []);
  f.reopenIsolation();
  assert.deepEqual(createSqliteWorkflowWorktreeCleanupStore(f.store).getIntent(f.roundId, 1, f.scope.worktreeId), intent);
});

test("observation journal is idempotent, append-only and can record uncertainty after a removed tombstone", nativeGit, async t => {
  const f = await fixture(t), intent = f.begin().value;
  const present = f.observe(intent, "present");
  assert.equal(present.status, "created");
  assert.deepEqual(f.observe(intent, "present"), { status: "duplicate", value: present.value });
  assert.equal(f.cleanup.assertIntent({ cleanupId: intent.cleanupId, ownerToken: intent.ownerToken, now: now() }).status, "retained");
  const removed = f.observe(intent, "removed");
  assert.equal(removed.status, "created");
  assert.deepEqual(f.observe(intent, "removed"), { status: "duplicate", value: removed.value });
  assert.equal(f.observe(intent, "present", { code: "original_directory_reappeared" }).status, "conflict");
  assert.equal(f.observe(intent, "unknown", { code: "workflow_git_cleanup_worktree_identity_changed" }).status, "created");
  assert.equal(f.cleanup.listReceipts(intent.cleanupId).length, 3);
  assert.throws(() => f.store.database.prepare("UPDATE workflow_worktree_cleanup_intents SET owner_token='stolen'").run(), /journal_immutable/);
  assert.throws(() => f.store.database.prepare("DELETE FROM workflow_worktree_cleanup_receipts").run(), /journal_retained/);
});

for (const field of ["scope", "creationReceipt", "retainedRefs", "artifactIds", "authorityDigest", "workflowId"]) {
  test(`cleanup begin rejects a caller-altered ${field} instead of trusting the proposed path or retained evidence`, nativeGit, async t => {
    const f = await fixture(t), plan = structuredClone(f.plan), before = await f.gitSnapshot();
    if (field === "scope") plan.scope.executionRoot = f.cwd;
    if (field === "creationReceipt") plan.creationReceipt.rootInode = "0";
    if (field === "retainedRefs") plan.retainedRefs = [];
    if (field === "artifactIds") plan.artifactIds = [];
    if (field === "authorityDigest") plan.authorityDigest = "not-current";
    if (field === "workflowId") plan.workflowId = "foreign-workflow";
    assert.equal(f.begin({ planArtifactId: f.artifact(plan) }).status, "invalid");
    assert.deepEqual(f.cleanup.listIntents(), []);
    assert.deepEqual(await f.gitSnapshot(), before);
  });
}

for (const status of ["running", "blocked", "failed", "cancelled", "waiting_for_approval"]) {
  test(`${status} workflow is never cleanup eligible even with an already verified candidate`, nativeGit, async t => {
    const f = await fixture(t);
    f.store.database.prepare("UPDATE channel_workflows SET status=? WHERE id=?").run(status, f.workflowId);
    assert.equal(f.cleanup.inspect({ ...f.scope, now: now() }).status, "retained");
    assert.ok(["invalid", "stale", "conflict"].includes(f.begin().status));
    assert.deepEqual(f.cleanup.listIntents(), []);
  });
}

test("corrupt retained bytes prevent cleanup authority and cannot be repaired by replaying begin", nativeGit, async t => {
  const f = await fixture(t), intent = f.begin().value;
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(f.intent().packetArtifactId);
  assert.equal(f.cleanup.assertIntent({ cleanupId: intent.cleanupId, ownerToken: intent.ownerToken, now: now() }).status, "retained");
  assert.throws(() => f.cleanup.getIntent(f.roundId, 1, f.scope.worktreeId), /digest_mismatch/);
  assert.throws(() => f.begin(), /digest_mismatch/);
  assert.equal(f.count("workflow_worktree_cleanup_intents"), 1);
});

test("cleanup intent and all recovery pins roll back atomically when retention fails", nativeGit, async t => {
  const f = await fixture(t), journal = await f.journal();
  f.store.database.exec(`CREATE TRIGGER fixture_cleanup_pin_failure BEFORE INSERT ON harness_artifact_pins
    WHEN NEW.holder LIKE 'host:workflow_cleanup:%' BEGIN SELECT RAISE(ABORT,'fixture-cleanup-pin-failure'); END`);
  assert.throws(() => f.begin(), /fixture-cleanup-pin-failure/);
  assert.equal(f.store.database.isTransaction, false);
  assert.deepEqual(f.cleanup.listIntents(), []);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM harness_artifact_pins WHERE holder LIKE 'host:workflow_cleanup:%'").get().n, 0);
  assert.deepEqual(await f.journal(), journal);
  assert.equal(f.workflow().status, "succeeded");
  f.store.database.exec("DROP TRIGGER fixture_cleanup_pin_failure");
  assert.equal(f.begin().status, "created");
});

test("cleanup commands never adopt or roll back an unrelated caller-owned transaction", nativeGit, async t => {
  const f = await fixture(t), planArtifactId = f.artifact({ ...f.plan });
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    f.store.database.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.workflowId);
    assert.throws(() => f.begin({ planArtifactId }), /transaction/iu);
    assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.workflow().title, "caller-wip");
  } finally { f.store.database.exec("ROLLBACK"); }
  assert.deepEqual(f.cleanup.listIntents(), []);
});

for (const alteration of ["foreign-path", "wrong-plan", "missing-ref", "extra-capability"]) {
  test(`observation rejects ${alteration} without changing the cleanup or business journal`, nativeGit, async t => {
    const f = await fixture(t), intent = f.begin().value, before = await f.journal();
    const observation = { state: "removed", executionRoot: f.plan.scope.executionRoot, worktreeId: f.plan.scope.worktreeId,
      branchRef: f.plan.scope.branchRef, commonDir: f.plan.scope.repository.commonDir, retainedRefs: f.plan.retainedRefs };
    const payload = { schemaVersion: 1, kind: "workflow_worktree_cleanup_observation", cleanupId: intent.cleanupId,
      planDigest: intent.planDigest, observation };
    if (alteration === "foreign-path") observation.executionRoot = f.cwd;
    if (alteration === "wrong-plan") payload.planDigest = "foreign-plan";
    if (alteration === "missing-ref") observation.retainedRefs = [];
    if (alteration === "extra-capability") observation.canDelete = true;
    assert.equal(f.cleanup.recordObservation({ cleanupId: intent.cleanupId, artifactId: f.artifact(payload), now: now() }).status, "invalid");
    assert.deepEqual(f.cleanup.listReceipts(intent.cleanupId), []);
    assert.deepEqual(await f.journal(), before);
    assert.equal(f.workflow().status, "succeeded");
  });
}
