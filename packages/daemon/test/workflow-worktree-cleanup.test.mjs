import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createSqliteWorkflowWorktreeCleanupStore, createSqliteWorkflowIntegrationCoordinatorStore } from "@ling-stack/core";
import { completeWorkflowIfStepsFinished } from "../dist/features/channels/workflow-completion.js";
import { cleanupWorkflowWorktrees, coordinateWorkflowWorktreeCleanup } from "../dist/features/channels/workflow-worktree-cleanup.js";
import { recoverWorkflowIsolationsAtStartup } from "../dist/features/channels/workflow-isolation-recovery.js";
import { nativeGit, now, workflowIntegrationCoordinatorFixture } from "./support/workflow-integration-coordinator-fixture.mjs";

async function fixture(t, { succeeded = true } = {}) {
  const f = await workflowIntegrationCoordinatorFixture(t);
  assert.equal((await f.coordinate()).status, "awaiting_approval");
  if (succeeded) {
    completeWorkflowIfStepsFinished(f.store, f.workflowId, now());
    assert.equal(f.workflow().status, "succeeded");
  }
  f.cleanup = () => createSqliteWorkflowWorktreeCleanupStore(f.store);
  f.cleanupOne = (worktreeId = f.integrationScope.worktreeId, options = {}) => coordinateWorkflowWorktreeCleanup({
    store: f.store, roundId: f.roundId, generation: 1, workflowId: f.workflowId, worktreeId, now, ...options,
  });
  f.cleanupAll = options => cleanupWorkflowWorktrees(f.store, f.workflowId, { now, ...options });
  f.cleanupIntent = (worktreeId = f.integrationScope.worktreeId) => f.cleanup().getIntent(f.roundId, 1, worktreeId);
  f.cleanupReceipts = (worktreeId = f.integrationScope.worktreeId) => f.cleanup().listReceipts(f.cleanupIntent(worktreeId).cleanupId);
  return f;
}
const missing = path => assert.rejects(access(path), { code: "ENOENT" });

test("ordinary non-SQLite workflows have no cleanup operation", async () => {
  assert.deepEqual(await cleanupWorkflowWorktrees({}, "ordinary"), []);
});

test("live completion removes only clean owned worktrees and retains every result ref and artifact", nativeGit, async t => {
  const f = await fixture(t, { succeeded: false }), target = await f.targetSnapshot();
  const refs = await f.git("for-each-ref", "--format=%(refname) %(objectname)"), journal = await f.journal();
  const artifacts = f.store.listArtifacts(f.runId);
  const tick = await f.orchestrate();
  assert.equal(tick.status, "completed", JSON.stringify(tick));
  assert.equal(f.workflow().status, "succeeded");
  for (const scope of [f.scopeGit, f.integrationScope]) {
    await missing(scope.executionRoot);
    const intent = f.cleanupIntent(scope.worktreeId);
    assert.equal(intent.plan.scope.executionRoot, scope.executionRoot);
    assert.equal(intent.plan.creationReceipt.worktreeId, scope.worktreeId);
    assert.equal(f.cleanupReceipts(scope.worktreeId).at(-1).state, "removed");
    assert.equal(f.cleanup().assertIntent({ cleanupId: intent.cleanupId, ownerToken: intent.ownerToken, now: now() }).status, "retained");
    assert.equal(await f.ref(scope.branchRef), scope.baseCommit, "worktree removal never deletes a branch");
    for (const retained of intent.plan.retainedRefs) assert.equal(await f.ref(retained.ref), retained.commit);
  }
  for (const artifact of artifacts) assert.deepEqual(f.store.getArtifact(artifact.id), artifact);
  assert.deepEqual(await f.targetSnapshot(), target);
  assert.equal(await f.git("for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.deepEqual(await f.journal(), journal, "cleanup does not mutate the delivery journal");
  const before = f.cleanup().listIntents({ workflowId: f.workflowId }).map(intent => ({
    intent, receipts: f.cleanup().listReceipts(intent.cleanupId),
  }));
  f.reopenIsolation();
  assert.equal((await f.coordinate()).status, "awaiting_approval", "terminal reconciliation never recreates a removed directory");
  assert.equal((await f.orchestrate()).status, "completed");
  assert.deepEqual(f.cleanup().listIntents({ workflowId: f.workflowId }).map(intent => ({
    intent, receipts: f.cleanup().listReceipts(intent.cleanupId),
  })), before, "duplicate/reopen observations are idempotent");
  assert.deepEqual(await f.targetSnapshot(), target);
});

test("verified candidate alone is not cleanup eligibility or permission to delete", nativeGit, async t => {
  const f = await fixture(t, { succeeded: false }), before = await f.gitSnapshot();
  const results = await f.cleanupAll();
  assert.ok(results.length > 0);
  assert.ok(results.every(result => result.status === "retained"), JSON.stringify(results));
  assert.deepEqual(f.cleanup().listIntents(), []);
  assert.notEqual(f.workflow().status, "succeeded");
  assert.deepEqual(await f.gitSnapshot(), before);
});

test("duplicate completion still checks retained delivery evidence after directories were reclaimed", nativeGit, async t => {
  const f = await fixture(t, { succeeded: false });
  assert.equal((await f.orchestrate()).status, "completed");
  await missing(f.executionRoot);
  const artifact = f.store.getArtifact(f.intent().packetArtifactId);
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run("{}", artifact.id);
  assert.equal((await f.orchestrate()).status, "blocked");
  await missing(f.executionRoot);
  await missing(f.integrationScope.executionRoot);
});

test("cleanup inventory failure preserves delivery success and leaves owned directories untouched", nativeGit, async t => {
  const f = await fixture(t, { succeeded: false }), before = await f.gitSnapshot();
  t.mock.method(f.cleanup(), "listIntents", () => { throw new Error("fixture: cleanup inventory unavailable"); });
  assert.equal((await f.orchestrate()).status, "completed");
  assert.equal(f.workflow().status, "succeeded");
  assert.deepEqual(await f.gitSnapshot(), before);
  assert.deepEqual(await f.cleanupAll(), [{ status: "retained", code: "workflow_cleanup.inventory_unverified" }]);
});

for (const residue of ["tracked", "ignored"]) {
  test(`${residue} source residue is retained durably while the independent clean integration directory is reclaimed`, nativeGit, async t => {
    const f = await fixture(t), path = join(f.executionRoot, residue === "tracked" ? "owned.txt" : "private-residue.txt");
    await writeFile(path, "preserved local work\n");
    const target = await f.targetSnapshot(), journal = await f.journal();
    const results = await f.cleanupAll();
    assert.equal(results.find(result => result.worktreeId === f.integrationScope.worktreeId).status, "removed", JSON.stringify(results));
    assert.notEqual(results.find(result => result.worktreeId === f.scopeGit.worktreeId).status, "removed", JSON.stringify(results));
    assert.equal(await readFile(path, "utf8"), "preserved local work\n");
    const intent = f.cleanupIntent(f.scopeGit.worktreeId), receipts = f.cleanupReceipts(f.scopeGit.worktreeId);
    assert.ok(intent, "retention has its own durable plan/intent");
    assert.notEqual(receipts.at(-1).state, "removed");
    assert.match(f.store.getArtifact(receipts.at(-1).artifactId).sealedPayload.observation.code, /dirty/);
    f.reopenIsolation();
    await recoverWorkflowIsolationsAtStartup(f.store);
    assert.equal(await readFile(path, "utf8"), "preserved local work\n");
    assert.deepEqual(await f.targetSnapshot(), target);
    assert.deepEqual(await f.journal(), journal);
    assert.equal(f.workflow().status, "succeeded", "retained cleanup never changes delivery success");
  });
}

test("concurrent cleanup calls share one physical operation and one immutable intent", nativeGit, async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.cleanupOne()));
  assert.ok(results.every(result => result.status === "removed"), JSON.stringify(results));
  assert.equal(f.cleanup().listIntents().length, 1);
  assert.equal(f.cleanupReceipts().length, 1);
  await missing(f.integrationScope.executionRoot);
  await access(f.executionRoot);
});

test("intent committed before removal survives reopen as observation-only and cannot become a deferred delete", nativeGit, async t => {
  const f = await fixture(t), port = f.cleanup(), begin = port.begin;
  const fault = t.mock.method(port, "begin", function(input) {
    begin.call(this, input);
    throw new Error("fixture: crash after cleanup intent, before remove");
  });
  assert.notEqual((await f.cleanupOne()).status, "removed");
  assert.ok(f.cleanupIntent());
  assert.equal(f.cleanupReceipts().length, 0);
  await access(f.integrationScope.executionRoot);
  fault.mock.restore();
  f.reopenIsolation();
  const noReplay = t.mock.method(f.cleanup(), "begin", () => assert.fail("recovery must not mint another cleanup intent"));
  await recoverWorkflowIsolationsAtStartup(f.store);
  assert.equal(f.cleanupReceipts().at(-1).state, "present");
  assert.equal((await f.cleanupOne()).status, "retained");
  await access(f.integrationScope.executionRoot);
  assert.equal(f.workflow().status, "succeeded");
  noReplay.mock.restore();
});

test("removal before receipt is reconciled after restart without another remove or business-state change", nativeGit, async t => {
  const f = await fixture(t), target = await f.targetSnapshot(), journal = await f.journal();
  const fault = t.mock.method(f.cleanup(), "recordObservation", () => { throw new Error("fixture: cleanup receipt unavailable"); });
  assert.equal((await f.cleanupOne()).status, "effect_unknown");
  await missing(f.integrationScope.executionRoot);
  assert.ok(f.cleanupIntent());
  assert.equal(f.cleanupReceipts().length, 0);
  fault.mock.restore();
  f.reopenIsolation();
  await recoverWorkflowIsolationsAtStartup(f.store);
  assert.equal(f.cleanupReceipts().at(-1).state, "removed");
  assert.deepEqual(await f.targetSnapshot(), target);
  assert.deepEqual(await f.journal(), journal);
  assert.equal(f.workflow().status, "succeeded");
});

test("startup with no cleanup intent never starts deleting a succeeded workflow's directories", nativeGit, async t => {
  const f = await fixture(t), before = await f.gitSnapshot();
  f.reopenIsolation();
  await recoverWorkflowIsolationsAtStartup(f.store);
  assert.deepEqual(f.cleanup().listIntents(), []);
  assert.deepEqual(await f.gitSnapshot(), before);
});

test("recovery finds existing cleanup evidence after step pins and current authority are revoked", nativeGit, async t => {
  const f = await fixture(t), port = f.cleanup(), begin = port.begin;
  const fault = t.mock.method(port, "begin", function(input) {
    begin.call(this, input);
    throw new Error("fixture: crash before remove");
  });
  await f.cleanupOne(f.scopeGit.worktreeId);
  fault.mock.restore();
  const intent = f.cleanupIntent(f.scopeGit.worktreeId), metadata = { ...f.step().metadata };
  delete metadata.isolationScopePlan;
  f.store.updateChannelWorkflowStep(f.step().id, { metadata }, now());
  const workflowMetadata = structuredClone(f.workflow().metadata);
  assert.throws(() => f.store.updateChannelWorkflow(f.workflowId, { metadata: {
    ...workflowMetadata, workflowGraphFingerprint: "revoked-after-cleanup-intent",
  } }, now()), /workflow_isolation\.completion_evidence_invalid/);
  assert.deepEqual(f.workflow().metadata, workflowMetadata);
  f.reopenIsolation();
  assert.notEqual(createSqliteWorkflowIntegrationCoordinatorStore(f.store).assertAuthority({
    roundId: f.roundId, generation: 1, now: now(),
  }).status, "authorized");
  await recoverWorkflowIsolationsAtStartup(f.store);
  assert.deepEqual(f.cleanupIntent(f.scopeGit.worktreeId), intent);
  assert.equal(f.cleanupReceipts(f.scopeGit.worktreeId).at(-1).state, "present");
  await access(f.executionRoot);
});

test("a removed tombstone cannot authorize deleting a new foreign directory at the same path", nativeGit, async t => {
  const f = await fixture(t);
  assert.equal((await f.cleanupOne()).status, "removed");
  const intent = f.cleanupIntent();
  await mkdir(f.integrationScope.executionRoot);
  const foreign = join(f.integrationScope.executionRoot, "foreign.txt");
  await writeFile(foreign, "not owned by the original creation receipt\n");
  f.reopenIsolation();
  assert.notEqual((await f.cleanupOne()).status, "removed");
  assert.equal(await readFile(foreign, "utf8"), "not owned by the original creation receipt\n");
  assert.deepEqual(f.cleanupIntent(), intent);
  assert.equal(f.workflow().status, "succeeded");
});
