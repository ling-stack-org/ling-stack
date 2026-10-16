import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, invertPatchPlan, planApplyPatch, toRuntimeAttemptFence } from "../dist/index.js";

const now = "2026-10-16T00:00:00.000Z", later = "2026-10-16T00:01:00.000Z";
async function fixture(t, { native = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-compaction-handoff-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "original-runtime", runnerId: "pi", status: "started", now });
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, taskId: "task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, contextViewId: "context", createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now); store.markRunStarted(run.id, now);
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
  let nativeReceipt;
  if (native) {
    const plan = planApplyPatch({ patchText: "*** Begin Patch\n*** Add File: marker.txt\n+done\n*** End Patch", readFile: () => undefined });
    const forward = store.createArtifact({ runId: run.id, type: "json", path: "forward.json", contentType: "application/json",
      sealedPayload: plan, createdAt: now });
    const inverse = store.createArtifact({ runId: run.id, type: "json", path: "inverse.json", contentType: "application/json",
      sealedPayload: invertPatchPlan(plan), createdAt: now });
    store.createWorkspaceMutationRecords(plan.operations.map((operation, operationIndex) => ({
      cwd, runId: run.id, toolCallId: "write-1", patchPlanId: `patch_plan_${forward.id}`, operationIndex,
      path: operation.path, operation: operation.kind, beforeSha256: "before", afterSha256: "after",
      forwardPatchArtifactId: forward.id, inversePatchArtifactId: inverse.id, createdAt: now,
    })));
    nativeReceipt = store.createArtifact({ runId: run.id, type: "json", path: "native-completion.json",
      contentType: "application/vnd.ling.native-file-mutation-completion+json", createdAt: now,
      sealedPayload: { schemaVersion: 1, boundary: "native-file-mutation-completion", source,
        toolCallId: "write-1", toolName: "write", outcome: "applied", rawPatchSha256: plan.rawPatchSha256,
        touchedPaths: plan.touchedPaths, provenanceArtifactIds: [forward.id, inverse.id] } });
  }
  void store.trackHostAttemptCompletion(source, new Promise(() => {}));
  store.acquireResourceLease({ ...source, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel", resourceKey: "channel",
    ownerType: "work_unit_attempt", ownerId: attempt.id, acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z" });
  store.acquireRuntimeSemaphoreSlot({ ...source, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner", resourceKey: "pi", limit: 2,
    ownerType: "work_unit_attempt", ownerId: attempt.id, acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z" });
  const context = store.createArtifact({ runId: run.id, type: "json", path: "context.json", contentType: "application/vnd.ling.pi-compaction-context+json",
    sealedPayload: { boundary: "pi-compaction-context", messages: [] }, createdAt: now });
  const start = store.appendExecutionEvent(run.id, source, "context_compaction_start", { reason: "threshold",
    policyVersion: "pi_sdk_lifecycle_v1", attemptId: attempt.id, checkpointArtifactId: context.id });
  const summary = store.createArtifact({ runId: run.id, type: "json", path: "summary.json", contentType: "application/vnd.ling.run-compaction-summary+json",
    sealedPayload: { summary: "Keep completed tools." }, createdAt: now });
  const prepared = store.createRunCompactionCheckpoint({ runId: run.id, attemptId: attempt.id, sourceEventSeq: start.seq,
    contextSnapshotArtifactId: context.id, summaryArtifactId: summary.id, summaryContentSha256: summary.contentSha256,
    contextViewId: "context", providerName: "fixture", providerModel: "fixture", policyVersion: "pi_sdk_lifecycle_v1",
    policySnapshotFingerprint: "policy", workspaceProvenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(), objective: "Continue", createdAt: now });
  const checkpoint = store.transitionRunCompactionCheckpoint({ id: prepared.id, expectedRevision: 0, state: "committed", now });
  store.appendExecutionEvent(run.id, source, "context_compaction_end", { reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1",
    attemptId: attempt.id, outcome: "sdk_installed", willRetry: false });
  const inventory = { schemaVersion: 1, toolCallIds: native ? ["write-1"] : ["read-1"],
    settledBuiltinReads: native ? [] : [{ toolCallId: "read-1", toolName: "read" }] };
  const seal = extra => store.sealHostCompactionResourceBoundary({ source, checkpointId: checkpoint.id, inventory, now, ...extra });
  const lose = () => {
    store.database.prepare("UPDATE work_unit_attempts SET status='lost',ended_at=? WHERE id=?").run(later, attempt.id);
    store.database.prepare("UPDATE work_units SET status='stale' WHERE id=?").run(unit.id);
  };
  const activationInput = artifactId => ({ preparation: {
    runId: run.id, workUnitId: unit.id, sourceFence: source, expectedTargetAttemptId: attempt.id, origin: "daemon_recovery",
    strategy: "deterministic_replay", runnerId: "pi", runnerCapabilityRevision: "pi:v1", contextViewId: "context",
    contextSnapshotArtifactId: context.id, idempotencyKey: "recovery", generation: 1,
    targetAttempt: { runtimeInstanceId: "successor-runtime", runnerId: "pi" }, now: later,
  }, expectedRunStatus: "running", expectedWorkUnitStatus: "stale", actor: "system", reason: "daemon_recovery", now: later,
  compactionResourceBoundary: { artifactId, checkpointId: checkpoint.id } });
  const activate = artifactId => store.commitExistingRunContinuation(activationInput(artifactId));
  return { get store() { return store; }, source, attempt, unit, run, checkpoint, inventory, nativeReceipt, seal, lose, activate, activationInput,
    reopen() { store.close(); store = createSqliteRunStore(cwd); } };
}

test("checkpoint handoff is atomic and never manufactures original drain or stop proof", async t => {
  const f = await fixture(t), artifactId = f.seal();
  assert.equal(typeof artifactId, "string");
  f.store.releaseResourceLeasesForAttempt(f.source, later, "generic-release");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  f.lose();
  const result = f.activate(artifactId);
  assert.equal(result.ok, true);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
  assert.equal(f.store.getHostAttemptCompletion(f.source).drainedAt, undefined);
  assert.equal(f.store.getHostAttemptCompletion(f.source).effectCoverage, undefined);
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "lost");
  assert.equal(f.activate(artifactId).replayed, true);
});

test("a completed SDK write identity without actual Host effect evidence cannot seal", async t => {
  const f = await fixture(t);
  assert.equal(f.seal({ inventory: { schemaVersion: 1, toolCallIds: ["write-1"], settledBuiltinReads: [] } }), undefined);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
});

for (const change of ["progress", "pending-effect", "unknown-effect", "cancellation", "missing-artifact"]) {
  test(`${change} blocks checkpoint handoff without releasing either resource table`, async t => {
    const f = await fixture(t), artifactId = f.seal();
    if (change === "progress") f.store.appendExecutionEvent(f.run.id, f.source, "assistant_text_delta", { text: "Later progress" });
    if (change === "pending-effect" || change === "unknown-effect") {
      const ticket = f.store.admitHostOperation({ operationId: `operation-${change}`, source: f.source,
        kind: "mcp", toolCallId: "unaccounted", admittedAt: now });
      if (change === "unknown-effect") f.store.settleHostOperation(ticket, { kind: "unknown_outcome", settledAt: now, code: "unverified" });
    }
    f.lose();
    if (change === "cancellation") f.store.database.prepare("UPDATE run_sessions SET status='cancelled' WHERE id=?").run(f.run.id);
    const result = f.activate(change === "missing-artifact" ? "missing" : artifactId);
    assert.equal(result.ok, false);
    assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  });
}

test("failure in the second resource table rolls back handoff and successor activation", async t => {
  const f = await fixture(t), artifactId = f.seal();
  f.lose();
  f.store.database.exec("CREATE TRIGGER handoff_fault BEFORE UPDATE ON runtime_semaphore_slots BEGIN SELECT RAISE(ABORT,'isolated handoff failure'); END");
  assert.throws(() => f.activate(artifactId), /isolated handoff failure/);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "stale");
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  f.store.database.exec("DROP TRIGGER handoff_fault");
  assert.equal(f.activate(artifactId).ok, true);
});

test("invalid boundary creation time cannot authorize a resource handoff", async t => {
  const f = await fixture(t), artifactId = f.seal();
  f.store.database.prepare("UPDATE artifacts SET created_at='invalid' WHERE id=?").run(artifactId);
  f.lose();
  assert.equal(f.activate(artifactId).ok, false);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
});

test("the initial checkpoint tolerates only its pre-install summary stream", async t => {
  const f = await fixture(t);
  const installed = f.store.database.prepare("SELECT seq FROM run_events WHERE run_id=? AND type='context_compaction_end'").get(f.run.id);
  f.store.database.prepare("DELETE FROM run_events WHERE run_id=? AND seq=?").run(f.run.id, installed.seq);
  f.store.appendExecutionEvent(f.run.id, f.source, "assistant_text_delta", { text: "Compacted summary" });
  f.store.appendExecutionEvent(f.run.id, f.source, "context_compaction_end", { reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1",
    attemptId: f.attempt.id, outcome: "sdk_installed", willRetry: false });
  const artifactId = f.seal();
  assert.equal(typeof artifactId, "string");
  f.lose();
  assert.equal(f.activate(artifactId).ok, true);
});

test("an SDK turn-start marker without provider progress does not invalidate the installed checkpoint", async t => {
  const f = await fixture(t);
  f.store.appendExecutionEvent(f.run.id, f.source, "turn_start", {});
  const artifactId = f.seal();
  assert.equal(typeof artifactId, "string");
  f.lose();
  assert.equal(f.activate(artifactId).ok, true);
});

test("a reopened SQLite connection recovers exact-source resources without inventing drain", async t => {
  const f = await fixture(t), artifactId = f.seal();
  f.lose();
  f.reopen();
  const result = f.activate(artifactId);
  assert.equal(result.ok, true);
  assert.equal(f.store.getHostAttemptCompletion(f.source).drainedAt, undefined);
  assert.equal(f.store.getHostAttemptCompletion(f.source).effectCoverage, undefined);
  for (const rows of [f.store.listResourceLeases(), f.store.listRuntimeSemaphoreSlots()]) {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "released");
    assert.equal(rows[0].releaseReason, "compaction-checkpoint-handoff:recovery");
  }
});

test("foreign resources remain active during exact-source checkpoint handoff", async t => {
  const f = await fixture(t), artifactId = f.seal();
  const otherUnit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "foreign-run",
    idempotencyKey: "foreign-unit", status: "running", createdByActor: "system", request: {}, now });
  const otherAttempt = f.store.createWorkUnitAttempt({ workUnitId: otherUnit.id, attemptNumber: 1,
    runtimeInstanceId: "foreign-runtime", runnerId: "pi", status: "started", now });
  const foreign = toRuntimeAttemptFence(otherAttempt);
  f.store.acquireResourceLease({ ...foreign, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel", resourceKey: "foreign-channel",
    ownerType: "work_unit_attempt", ownerId: otherAttempt.id, acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z" });
  f.store.acquireRuntimeSemaphoreSlot({ ...foreign, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner", resourceKey: "pi", limit: 2,
    ownerType: "work_unit_attempt", ownerId: otherAttempt.id, acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z" });
  f.lose();
  assert.equal(f.activate(artifactId).ok, true);
  assert.deepEqual(f.store.listResourceLeases({ status: "active" }).map(row => row.attemptId), [otherAttempt.id]);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ status: "active" }).map(row => row.attemptId), [otherAttempt.id]);
});

test("a deferred COMMIT failure rolls back both resource tables and the successor", async t => {
  const f = await fixture(t), artifactId = f.seal();
  f.lose();
  f.store.database.exec(`CREATE TABLE handoff_commit_parent(id TEXT PRIMARY KEY);
    CREATE TABLE handoff_commit_fault(parent_id TEXT REFERENCES handoff_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER handoff_commit_failure AFTER UPDATE ON runtime_semaphore_slots
      BEGIN INSERT INTO handoff_commit_fault(parent_id) VALUES ('missing'); END;`);
  assert.throws(() => f.activate(artifactId), /FOREIGN KEY constraint failed/);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "stale");
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS count FROM handoff_commit_fault").get().count, 0);
  f.store.database.exec("DROP TRIGGER handoff_commit_failure");
  assert.equal(f.activate(artifactId).ok, true);
});

test("independent recovery callers replay one committed successor rather than activating twice", async t => {
  const f = await fixture(t), artifactId = f.seal();
  f.lose();
  const other = createSqliteRunStore(f.run.cwd);
  t.after(() => other.close());
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => f.activate(artifactId)),
    Promise.resolve().then(() => other.commitExistingRunContinuation(f.activationInput(artifactId))),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
});

test("an exact native file receipt and provenance authorize only checkpoint handoff", async t => {
  const f = await fixture(t, { native: true }), artifactId = f.seal();
  assert.equal(typeof artifactId, "string");
  f.lose();
  f.reopen();
  assert.equal(f.activate(artifactId).ok, true);
  assert.equal(f.store.getHostAttemptCompletion(f.source).drainedAt, undefined);
});

for (const corruption of ["receipt-digest", "receipt-source", "receipt-time", "future-time", "forward-digest", "inverse-digest", "provenance-path", "provenance-state"]) {
  test(`${corruption} invalidates previously sealed native completion before handoff`, async t => {
    const f = await fixture(t, { native: true }), artifactId = f.seal();
    assert.equal(typeof artifactId, "string");
    const receipt = f.nativeReceipt;
    if (corruption === "receipt-digest") f.store.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("0".repeat(64), receipt.id);
    if (corruption === "receipt-source") {
      const payload = { ...receipt.sealedPayload, source: { ...f.source, fencingToken: "foreign-fence" } };
      f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?")
        .run(JSON.stringify(payload), createHash("sha256").update(JSON.stringify(payload)).digest("hex"), receipt.id);
    }
    if (corruption === "receipt-time" || corruption === "future-time") f.store.database.prepare("UPDATE artifacts SET created_at=? WHERE id=?")
      .run(corruption === "receipt-time" ? "invalid" : "2099-01-01T00:00:00.000Z", receipt.id);
    if (corruption === "forward-digest" || corruption === "inverse-digest") f.store.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?")
      .run("0".repeat(64), receipt.sealedPayload.provenanceArtifactIds[corruption === "forward-digest" ? 0 : 1]);
    if (corruption === "provenance-path") f.store.database.prepare("UPDATE workspace_mutation_records SET path='foreign.txt' WHERE run_id=?").run(f.run.id);
    if (corruption === "provenance-state") f.store.database.prepare("UPDATE workspace_mutation_records SET effect_state='effect_unknown' WHERE run_id=?").run(f.run.id);
    f.lose();
    assert.equal(f.activate(artifactId).ok, false);
    assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  });
}

for (const corruption of ["missing-source-field", "foreign-source", "boundary-digest", "newer-watermark"]) {
  test(`${corruption} blocks revalidation of a previously valid boundary`, async t => {
    const f = await fixture(t), artifactId = f.seal();
    const artifact = f.store.getArtifact(artifactId), payload = structuredClone(artifact.sealedPayload);
    if (corruption === "missing-source-field") delete payload.source.runtimeInstanceId;
    if (corruption === "foreign-source") payload.source.runtimeInstanceId = "foreign-runtime";
    if (corruption === "boundary-digest") f.store.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("0".repeat(64), artifactId);
    else if (corruption === "newer-watermark") f.store.database.prepare("INSERT INTO workspace_provenance_sequences(workspace_id,last_seq) VALUES (?,1)")
      .run(DEFAULT_WORKSPACE_ID);
    else f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?")
      .run(JSON.stringify(payload), createHash("sha256").update(JSON.stringify(payload)).digest("hex"), artifactId);
    f.lose();
    assert.equal(f.activate(artifactId).ok, false);
    assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  });
}
