import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import {
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  resolveRuntimePaths,
  toRuntimeAttemptFence,
} from "../dist/index.js";

const now = "2026-09-13T00:00:00.000Z";
const later = "2026-09-13T00:01:00.000Z";
const expires = "2026-09-13T00:05:00.000Z";

test("continuation producer pin failure rolls back target Attempt admission", async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER reject_continuation_pin BEFORE INSERT ON harness_artifact_pin_events BEGIN SELECT RAISE(ABORT,'continuation-pin-fault'); END");
  assert.throws(() => f.store.prepareContinuationAndAttempt(f.input), /continuation-pin-fault/u);
  assert.equal(count(f, "runner_continuations"), 0);
  assert.equal(f.store.listWorkUnitAttempts(f.targetUnit.id).length, 0);
  assert.equal(f.store.getWorkUnit(f.targetUnit.id).activeAttemptId, undefined);
  assert.equal(count(f, "harness_artifact_pins"), 0);
});

test("continuation known terminal releases only its owner, with transaction-atomic release audit", async t => {
  const f = await fixture(t);
  const prepared = f.store.prepareContinuationAndAttempt(f.input);
  f.store.pinHarnessArtifact({ artifactId: f.contextArtifact.id, holder: "independent-audit", reason: "audit_hold", now });
  const lease = { continuationId: prepared.continuation.id, claimOwner: "daemon", claimToken: "pin-lifecycle", targetFence: toRuntimeAttemptFence(prepared.attempt), now };
  assert.equal(f.store.claimRunnerContinuation({ ...lease, expectedRevision: 0, claimExpiresAt: expires }).ok, true);
  assert.equal(f.store.startRunnerContinuation({ ...lease, expectedRevision: 1 }).ok, true);
  const finish = { ...lease, expectedRevision: 2, nextState: "succeeded", now: later };
  assert.equal(f.store.finishRunnerContinuation({ ...finish, expectedRevision: 0 }).ok, false);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pins WHERE released_at IS NULL").get().n, 2);
  f.database.exec("CREATE TRIGGER reject_continuation_release BEFORE INSERT ON harness_artifact_pin_events WHEN NEW.event='release' BEGIN SELECT RAISE(ABORT,'continuation-release-fault'); END");
  assert.throws(() => f.store.finishRunnerContinuation(finish), /continuation-release-fault/u);
  assert.equal(f.store.getRunnerContinuation(prepared.continuation.id).state, "running");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pins WHERE released_at IS NULL").get().n, 2);
  f.database.exec("DROP TRIGGER reject_continuation_release");
  assert.equal(f.store.finishRunnerContinuation(finish).ok, true);
  assert.deepEqual(f.database.prepare("SELECT holder FROM harness_artifact_pins WHERE released_at IS NULL").all().map(row => row.holder), ["independent-audit"]);
});

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-runner-continuation-store-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  f.database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    try { f.database.close(); } catch {}
    try { f.store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = f.store.createChannel({ name: "Harness", boundPath: cwd }, now);
  const task = f.store.createTask({ channelId: channel.id, title: "Continue", prompt: "Continue safely" }, now);

  f.sourceUnit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "run",
    ownerId: "source-run",
    idempotencyKey: "source-unit",
    status: "succeeded",
    createdByActor: "system",
    request: {},
    now,
  });
  f.sourceAttempt = f.store.createWorkUnitAttempt({
    id: "attempt-source-1",
    workUnitId: f.sourceUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime-source-1",
    runnerId: "runner_pi_embedded",
    effectiveRunnerId: "runner_pi_embedded",
    status: "succeeded",
    now,
  });
  f.sourceRun = f.store.createRun({
    id: "source-run",
    cwd,
    taskId: task.id,
    workUnitId: f.sourceUnit.id,
    providerName: "test",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    contextViewId: "context-source",
    contextViewCreatedAt: now,
    createdAt: now,
  });
  f.store.linkRunToWorkUnit(f.sourceRun.id, f.sourceUnit.id, now);
  f.store.markRunSucceeded(f.sourceRun.id, now);

  f.targetUnit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "run",
    ownerId: "target-run",
    idempotencyKey: "target-unit",
    status: "queued",
    createdByActor: "system",
    request: {},
    now,
  });
  f.targetRun = f.store.createRun({
    id: "target-run",
    cwd,
    taskId: task.id,
    workUnitId: f.targetUnit.id,
    parentRunId: f.sourceRun.id,
    providerName: "test",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    contextViewId: "context-target",
    contextViewCreatedAt: now,
    createdAt: now,
  });
  f.store.linkRunToWorkUnit(f.targetRun.id, f.targetUnit.id, now);
  f.contextArtifact = f.store.createArtifact({
    id: "artifact-context-target",
    runId: f.targetRun.id,
    type: "json",
    path: "harness/context-target.json",
    sealedPayload: { contextViewId: "context-target" },
    createdAt: now,
  });
  f.input = {
    id: "continuation-target-1",
    runId: f.targetRun.id,
    workUnitId: f.targetUnit.id,
    sourceFence: toRuntimeAttemptFence(f.sourceAttempt),
    expectedTargetAttemptId: null,
    origin: "queued_followup",
    strategy: "deterministic_replay",
    runnerId: "runner_pi_embedded",
    runnerCapabilityRevision: "pi:1",
    contextViewId: "context-target",
    contextSnapshotArtifactId: f.contextArtifact.id,
    idempotencyKey: "continuation:target:1",
    generation: 0,
    targetAttempt: {
      id: "attempt-target-1",
      runtimeInstanceId: "runtime-target-1",
      runnerId: "runner_pi_embedded",
      effectiveRunnerId: "runner_pi_embedded",
    },
    now,
  };
  return f;
}

test("continuation and target Attempt are committed atomically and replay with one lineage", async (t) => {
  const f = await fixture(t);
  const first = f.store.prepareContinuationAndAttempt(f.input);
  assert.equal(first.replayed, false);
  assert.equal(first.continuation.state, "prepared");
  assert.equal(first.continuation.targetAttemptId, first.attempt.id);
  assert.equal(f.store.getWorkUnit(f.targetUnit.id).activeAttemptId, first.attempt.id);
  const replay = f.store.prepareContinuationAndAttempt({ ...f.input, now: later });
  assert.equal(replay.replayed, true);
  assert.equal(replay.continuation.id, first.continuation.id);
  assert.equal(replay.attempt.id, first.attempt.id);
  assert.equal(count(f, "runner_continuations"), 1);
  assert.equal(f.store.listWorkUnitAttempts(f.targetUnit.id).length, 1);
  assert.throws(
    () => f.store.prepareContinuationAndAttempt({ ...f.input, runnerCapabilityRevision: "pi:2" }),
    hasCode("continuation.idempotency_conflict"),
  );
});

for (const [kind, ownerType] of [["conversation_run", "conversation_turn"],
  ["channel_ai_reply", "channel_message"], ["teammate_direct_reply", "teammate_direct_message"]]) {
  test(`preparation failure settles a snapshot-only ${kind} atomically without creating a Task`, async (t) => {
    const f = await fixture(t);
    setSnapshotOnlyOwner(f, kind, ownerType, { id: "snapshot-task" });
    const prepared = f.store.prepareContinuationAndAttempt(f.input);
    const input = preparationFailureInput(f, prepared);
    const stale = f.store.commitExistingRunContinuationPreparationFailure({ ...input,
      targetFence: { ...input.targetFence, fencingToken: "foreign-fence" } });
    assert.equal(stale.ok, false);
    assert.equal(f.store.getRun(f.targetRun.id).status, "queued");
    assert.equal(f.store.getRunnerContinuation(prepared.continuation.id).state, "prepared");
    f.database.exec(`CREATE TRIGGER reject_preparation_failure BEFORE UPDATE OF status ON work_unit_attempts
      WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT, 'reject preparation failure'); END;`);
    assert.throws(() => f.store.commitExistingRunContinuationPreparationFailure(input), /reject preparation failure/u);
    assert.equal(f.store.getRun(f.targetRun.id).status, "queued");
    assert.equal(f.store.getWorkUnit(f.targetUnit.id).status, "queued");
    assert.equal(f.store.getRunnerContinuation(prepared.continuation.id).state, "prepared");
    f.database.exec("DROP TRIGGER reject_preparation_failure");
    const result = f.store.commitExistingRunContinuationPreparationFailure(input);
    assert.equal(result.ok, true);
    assert.equal(result.run.status, "failed");
    assert.equal(result.workUnit.status, "failed");
    assert.equal(result.attempt.status, "failed");
    assert.equal(result.continuation.state, "failed");
    assert.equal(result.task, undefined);
    assert.equal(f.store.getTask("snapshot-task"), undefined);
    assert.equal(f.store.commitExistingRunContinuationPreparationFailure(input).ok, false);
  });
}

for (const [kind, ownerType, snapshot] of [["task_run", "task", { id: "snapshot-task" }],
  ["conversation_run", "conversation_turn", {}], ["conversation_run", "conversation_turn", { id: "another-task" }],
  ["conversation_run", "task", { id: "snapshot-task" }]]) {
  test(`preparation failure rejects missing Task or invalid ${kind}/${ownerType} snapshot ${JSON.stringify(snapshot)}`, async (t) => {
    const f = await fixture(t);
    setSnapshotOnlyOwner(f, kind, ownerType, snapshot);
    const prepared = f.store.prepareContinuationAndAttempt(f.input);
    const result = f.store.commitExistingRunContinuationPreparationFailure(preparationFailureInput(f, prepared));
    assert.deepEqual(result, { ok: false, code: "continuation.preparation_failure_lineage_stale" });
    assert.equal(f.store.getRun(f.targetRun.id).status, "queued");
    assert.equal(f.store.getWorkUnitAttempt(prepared.attempt.id).status, "created");
    assert.equal(f.store.getRunnerContinuation(prepared.continuation.id).state, "prepared");
  });
}

function setSnapshotOnlyOwner(f, kind, ownerType, snapshot) {
  f.database.prepare("UPDATE run_sessions SET task_id=?,task_snapshot_json=? WHERE id=?")
    .run("snapshot-task", JSON.stringify(snapshot), f.targetRun.id);
  f.database.prepare("UPDATE work_units SET kind=?,owner_type=?,task_id=? WHERE id=?")
    .run(kind, ownerType, "snapshot-task", f.targetUnit.id);
}

function preparationFailureInput(f, prepared) {
  return { continuationId: prepared.continuation.id, expectedContinuationRevision: prepared.continuation.revision,
    expectedContinuationState: "prepared", runId: f.targetRun.id, expectedRunStatus: "queued",
    workUnitId: f.targetUnit.id, expectedWorkUnitStatus: "queued", targetFence: toRuntimeAttemptFence(prepared.attempt),
    expectedAttemptStatus: "created", errorCode: "fixture_prepare_failed", errorMessage: "Preparation failed", now: later };
}

test("prepare survives daemon reopen without creating a duplicate Attempt", async (t) => {
  const f = await fixture(t);
  const first = f.store.prepareContinuationAndAttempt(f.input);
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  const replay = f.store.prepareContinuationAndAttempt({ ...f.input, now: later });
  assert.equal(replay.replayed, true);
  assert.equal(replay.continuation.id, first.continuation.id);
  assert.equal(replay.attempt.id, first.attempt.id);
  assert.equal(f.store.listWorkUnitAttempts(f.targetUnit.id).length, 1);
});

test("continuation insert failure rolls the target Attempt and active pointer back", async (t) => {
  const f = await fixture(t);
  f.database.exec(`
    CREATE TRIGGER reject_runner_continuation
    BEFORE INSERT ON runner_continuations
    BEGIN SELECT RAISE(ABORT, 'reject runner continuation'); END;
  `);
  assert.throws(() => f.store.prepareContinuationAndAttempt(f.input), /reject runner continuation/u);
  assert.equal(count(f, "runner_continuations"), 0);
  assert.equal(f.store.listWorkUnitAttempts(f.targetUnit.id).length, 0);
  assert.equal(f.store.getWorkUnit(f.targetUnit.id).activeAttemptId, undefined);
});

test("new preparation rejects stale source fences and unexpected target ownership", async (t) => {
  const staleSource = await fixture(t);
  staleSource.store.createWorkUnitAttempt({
    id: "attempt-source-replacement",
    workUnitId: staleSource.sourceUnit.id,
    attemptNumber: 2,
    runtimeInstanceId: "runtime-source-2",
    runnerId: "runner_pi_embedded",
    status: "created",
    now: later,
  });
  assert.throws(
    () => staleSource.store.prepareContinuationAndAttempt(staleSource.input),
    hasCode("continuation.source_attempt_stale"),
  );
  assert.equal(staleSource.store.listWorkUnitAttempts(staleSource.targetUnit.id).length, 0);

  const staleTarget = await fixture(t);
  const foreign = staleTarget.store.createWorkUnitAttempt({
    id: "attempt-target-foreign",
    workUnitId: staleTarget.targetUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime-target-foreign",
    runnerId: "runner_pi_embedded",
    status: "created",
    now,
  });
  assert.throws(
    () => staleTarget.store.prepareContinuationAndAttempt(staleTarget.input),
    hasCode("continuation.target_attempt_lost"),
  );
  assert.equal(staleTarget.store.getWorkUnit(staleTarget.targetUnit.id).activeAttemptId, foreign.id);
  assert.equal(staleTarget.store.listWorkUnitAttempts(staleTarget.targetUnit.id).length, 1);
});

test("claim token prevents ABA and stale target start or completion", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareContinuationAndAttempt(f.input);
  const claimed = f.store.claimRunnerContinuation({
    continuationId: prepared.continuation.id,
    expectedRevision: 0,
    claimOwner: "daemon-a",
    claimToken: "claim-a-1",
    claimExpiresAt: expires,
    now,
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.value.claimToken, "claim-a-1");
  assert.deepEqual(f.store.claimRunnerContinuation({
    continuationId: prepared.continuation.id,
    expectedRevision: 0,
    claimOwner: "daemon-a",
    claimToken: "claim-a-1",
    claimExpiresAt: expires,
    now,
  }), { ...claimed, replayed: true });
  assert.equal(f.store.claimRunnerContinuation({
    continuationId: prepared.continuation.id,
    expectedRevision: 0,
    claimOwner: "daemon-a",
    claimToken: "claim-a-2",
    claimExpiresAt: expires,
    now,
  }).ok, false);

  const fence = toRuntimeAttemptFence(prepared.attempt);
  const started = f.store.startRunnerContinuation({
    continuationId: prepared.continuation.id,
    expectedRevision: 1,
    claimOwner: "daemon-a",
    claimToken: "claim-a-1",
    targetFence: fence,
    now,
  });
  assert.equal(started.ok, true);
  assert.equal(f.store.getWorkUnitAttempt(prepared.attempt.id).status, "started");

  f.store.createWorkUnitAttempt({
    id: "attempt-target-replacement",
    workUnitId: f.targetUnit.id,
    attemptNumber: 2,
    runtimeInstanceId: "runtime-target-2",
    runnerId: "runner_pi_embedded",
    status: "created",
    now: later,
  });
  assert.deepEqual(f.store.finishRunnerContinuation({
    continuationId: prepared.continuation.id,
    expectedRevision: 2,
    claimOwner: "daemon-a",
    claimToken: "claim-a-1",
    targetFence: fence,
    nextState: "succeeded",
    now: later,
  }), { ok: false, code: "continuation.target_attempt_lost" });
  assert.equal(f.store.getRunnerContinuation(prepared.continuation.id).state, "running");
});

test("claim and start fail closed when target ownership changes", async (t) => {
  const staleClaim = await fixture(t);
  const claimPrepared = staleClaim.store.prepareContinuationAndAttempt(staleClaim.input);
  staleClaim.store.createWorkUnitAttempt({
    id: "attempt-before-claim",
    workUnitId: staleClaim.targetUnit.id,
    attemptNumber: 2,
    runtimeInstanceId: "runtime-before-claim",
    runnerId: "runner_pi_embedded",
    status: "created",
    now: later,
  });
  assert.deepEqual(staleClaim.store.claimRunnerContinuation({
    continuationId: claimPrepared.continuation.id,
    expectedRevision: 0,
    claimOwner: "daemon",
    claimToken: "claim-stale",
    claimExpiresAt: expires,
    now,
  }), { ok: false, code: "continuation.target_attempt_lost" });

  const staleStart = await fixture(t);
  const startPrepared = staleStart.store.prepareContinuationAndAttempt(staleStart.input);
  const claimed = staleStart.store.claimRunnerContinuation({
    continuationId: startPrepared.continuation.id,
    expectedRevision: 0,
    claimOwner: "daemon",
    claimToken: "claim-start",
    claimExpiresAt: expires,
    now,
  });
  assert.equal(claimed.ok, true);
  staleStart.store.createWorkUnitAttempt({
    id: "attempt-before-start",
    workUnitId: staleStart.targetUnit.id,
    attemptNumber: 2,
    runtimeInstanceId: "runtime-before-start",
    runnerId: "runner_pi_embedded",
    status: "created",
    now: later,
  });
  assert.deepEqual(staleStart.store.startRunnerContinuation({
    continuationId: startPrepared.continuation.id,
    expectedRevision: 1,
    claimOwner: "daemon",
    claimToken: "claim-start",
    targetFence: toRuntimeAttemptFence(startPrepared.attempt),
    now,
  }), { ok: false, code: "continuation.target_attempt_lost" });
  assert.equal(staleStart.store.getRunnerContinuation(startPrepared.continuation.id).state, "claimed");
});

test("successful claim, start and finish are fenced CAS transitions", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareContinuationAndAttempt(f.input);
  const fence = toRuntimeAttemptFence(prepared.attempt);
  const claimed = f.store.claimRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 0, claimOwner: "daemon", claimToken: "claim-1", claimExpiresAt: expires, now });
  assert.equal(claimed.ok, true);
  const started = f.store.startRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 1, claimOwner: "daemon", claimToken: "claim-1", targetFence: fence, now });
  assert.equal(started.ok, true);
  const finished = f.store.finishRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 2, claimOwner: "daemon", claimToken: "claim-1", targetFence: fence,
    nextState: "succeeded", now: later });
  assert.equal(finished.ok, true);
  assert.equal(finished.value.state, "succeeded");
  assert.equal(finished.value.completedAt, later);
  assert.equal(f.store.listClaimableRunnerContinuations({ now }).length, 0);
});

test("only explicitly deferred continuations enter the durable scheduled queue", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareContinuationAndAttempt(f.input);
  assert.equal(f.store.listClaimableRunnerContinuations({ now, scheduledOnly: true }).length, 0);

  const deferred = f.store.deferRunnerContinuation({
    continuationId: prepared.continuation.id,
    expectedRevision: prepared.continuation.revision,
    now,
    nextAttemptAt: later,
  });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.value.revision, 1);
  assert.equal(deferred.value.nextAttemptAt, later);
  assert.equal(f.store.listClaimableRunnerContinuations({ now, scheduledOnly: true }).length, 0);
  assert.deepEqual(
    f.store.listClaimableRunnerContinuations({ now: later, scheduledOnly: true }).map((item) => item.id),
    [prepared.continuation.id],
  );
});

test("rejected native resume is atomically reprepared once with a fresh replay Attempt", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareContinuationAndAttempt({
    ...f.input,
    strategy: "native_resume",
    runnerHandleRef: "artifact-native-handle",
  });
  const abandonedFence = toRuntimeAttemptFence(prepared.attempt);
  const claimed = f.store.claimRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 0, claimOwner: "daemon", claimToken: "claim-native", claimExpiresAt: expires, now });
  assert.equal(claimed.ok, true);
  const started = f.store.startRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 1, claimOwner: "daemon", claimToken: "claim-native", targetFence: abandonedFence, now });
  assert.equal(started.ok, true);
  const failureDetail = f.store.createArtifact({ runId: f.targetRun.id, type: "json", path: "harness/native-failure.json",
    sealedPayload: { reason: "handle rejected" }, createdAt: now });
  const pending = f.store.finishRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 2, claimOwner: "daemon", claimToken: "claim-native", targetFence: abandonedFence,
    nextState: "recovery_pending", failureCode: "continuation.handle_rejected", failureDetailArtifactId: failureDetail.id, now: later });
  assert.equal(pending.ok, true);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pins WHERE released_at IS NULL").get().n, 2);

  const reprepareInput = {
    continuationId: prepared.continuation.id,
    expectedRevision: 3,
    expectedGeneration: 0,
    claimOwner: "daemon",
    claimToken: "claim-native",
    abandonedTargetFence: abandonedFence,
    targetAttempt: {
      id: "attempt-target-replay",
      runtimeInstanceId: "runtime-target-replay",
      runnerId: "runner_pi_embedded",
      effectiveRunnerId: "runner_pi_embedded",
    },
    now: later,
  };
  const replay = f.store.reprepareContinuationAndAttempt(reprepareInput);
  assert.equal(replay.replayed, false);
  assert.equal(replay.continuation.strategy, "deterministic_replay");
  assert.equal(replay.continuation.state, "prepared");
  assert.equal(replay.continuation.generation, 1);
  assert.equal(replay.continuation.revision, 4);
  assert.equal(replay.continuation.claimOwner, undefined);
  assert.equal(replay.continuation.failureCode, undefined);
  assert.equal(replay.attempt.id, "attempt-target-replay");
  assert.equal(f.store.getWorkUnitAttempt(prepared.attempt.id).status, "lost");
  assert.equal(f.store.getWorkUnit(f.targetUnit.id).activeAttemptId, replay.attempt.id);
  assert.deepEqual(f.database.prepare("SELECT artifact_id FROM harness_artifact_pins WHERE released_at IS NULL").all().map(row => row.artifact_id), [f.contextArtifact.id]);

  const repeated = f.store.reprepareContinuationAndAttempt(reprepareInput);
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.attempt.id, replay.attempt.id);
  assert.equal(f.store.listWorkUnitAttempts(f.targetUnit.id).length, 2);
  assert.throws(
    () => f.store.reprepareContinuationAndAttempt({
      ...reprepareInput,
      targetAttempt: { ...reprepareInput.targetAttempt, id: "attempt-target-replay-other" },
    }),
    hasCode("continuation.idempotency_conflict"),
  );
});

test("reprepare rollback restores the rejected native Attempt when continuation CAS fails", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareContinuationAndAttempt({ ...f.input, strategy: "native_resume",
    runnerHandleRef: "artifact-native-handle" });
  const abandonedFence = toRuntimeAttemptFence(prepared.attempt);
  assert.equal(f.store.claimRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 0, claimOwner: "daemon", claimToken: "claim-native-rollback", claimExpiresAt: expires, now }).ok, true);
  assert.equal(f.store.startRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 1, claimOwner: "daemon", claimToken: "claim-native-rollback", targetFence: abandonedFence, now }).ok, true);
  assert.equal(f.store.finishRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 2, claimOwner: "daemon", claimToken: "claim-native-rollback", targetFence: abandonedFence,
    nextState: "recovery_pending", failureCode: "continuation.handle_rejected", now: later }).ok, true);
  f.database.exec(`
    CREATE TRIGGER reject_runner_reprepare
    BEFORE UPDATE OF strategy ON runner_continuations
    WHEN NEW.strategy = 'deterministic_replay'
    BEGIN SELECT RAISE(ABORT, 'reject runner reprepare'); END;
  `);
  assert.throws(() => f.store.reprepareContinuationAndAttempt({
    continuationId: prepared.continuation.id,
    expectedRevision: 3,
    expectedGeneration: 0,
    claimOwner: "daemon",
    claimToken: "claim-native-rollback",
    abandonedTargetFence: abandonedFence,
    targetAttempt: { id: "attempt-replay-rollback", runtimeInstanceId: "runtime-replay-rollback",
      runnerId: "runner_pi_embedded", effectiveRunnerId: "runner_pi_embedded" },
    now: later,
  }), /reject runner reprepare/u);
  assert.equal(f.store.getWorkUnitAttempt(prepared.attempt.id).status, "started");
  assert.equal(f.store.getWorkUnit(f.targetUnit.id).activeAttemptId, prepared.attempt.id);
  assert.equal(f.store.listWorkUnitAttempts(f.targetUnit.id).length, 1);
  assert.equal(f.store.getRunnerContinuation(prepared.continuation.id).state, "recovery_pending");
});

test("reprepare requires a live claim lease and an approved native fallback reason", async (t) => {
  const expiredLease = await fixture(t);
  const expiredPrepared = expiredLease.store.prepareContinuationAndAttempt({
    ...expiredLease.input,
    strategy: "native_resume",
    runnerHandleRef: "artifact-native-handle-expired",
  });
  const expiredFence = toRuntimeAttemptFence(expiredPrepared.attempt);
  assert.equal(expiredLease.store.claimRunnerContinuation({ continuationId: expiredPrepared.continuation.id,
    expectedRevision: 0, claimOwner: "daemon", claimToken: "claim-expired", claimExpiresAt: later, now }).ok, true);
  assert.equal(expiredLease.store.startRunnerContinuation({ continuationId: expiredPrepared.continuation.id,
    expectedRevision: 1, claimOwner: "daemon", claimToken: "claim-expired", targetFence: expiredFence, now }).ok, true);
  assert.equal(expiredLease.store.finishRunnerContinuation({ continuationId: expiredPrepared.continuation.id,
    expectedRevision: 2, claimOwner: "daemon", claimToken: "claim-expired", targetFence: expiredFence,
    nextState: "recovery_pending", failureCode: "continuation.handle_rejected", now }).ok, true);
  assert.throws(() => expiredLease.store.reprepareContinuationAndAttempt({
    continuationId: expiredPrepared.continuation.id,
    expectedRevision: 3,
    expectedGeneration: 0,
    claimOwner: "daemon",
    claimToken: "claim-expired",
    abandonedTargetFence: expiredFence,
    targetAttempt: { id: "attempt-replay-after-expiry", runtimeInstanceId: "runtime-replay-after-expiry",
      runnerId: "runner_pi_embedded", effectiveRunnerId: "runner_pi_embedded" },
    now: expires,
  }), hasCode("continuation.lineage_mismatch"));
  assert.equal(expiredLease.store.getWorkUnitAttempt(expiredPrepared.attempt.id).status, "started");
  assert.equal(expiredLease.store.listWorkUnitAttempts(expiredLease.targetUnit.id).length, 1);

  const disallowedReason = await fixture(t);
  const disallowedPrepared = disallowedReason.store.prepareContinuationAndAttempt({
    ...disallowedReason.input,
    strategy: "native_resume",
    runnerHandleRef: "artifact-native-handle-disallowed",
  });
  const disallowedFence = toRuntimeAttemptFence(disallowedPrepared.attempt);
  assert.equal(disallowedReason.store.claimRunnerContinuation({ continuationId: disallowedPrepared.continuation.id,
    expectedRevision: 0, claimOwner: "daemon", claimToken: "claim-disallowed", claimExpiresAt: expires, now }).ok, true);
  assert.equal(disallowedReason.store.startRunnerContinuation({ continuationId: disallowedPrepared.continuation.id,
    expectedRevision: 1, claimOwner: "daemon", claimToken: "claim-disallowed", targetFence: disallowedFence, now }).ok, true);
  assert.equal(disallowedReason.store.finishRunnerContinuation({ continuationId: disallowedPrepared.continuation.id,
    expectedRevision: 2, claimOwner: "daemon", claimToken: "claim-disallowed", targetFence: disallowedFence,
    nextState: "recovery_pending", failureCode: "continuation.source_attempt_stale", now: later }).ok, true);
  assert.throws(() => disallowedReason.store.reprepareContinuationAndAttempt({
    continuationId: disallowedPrepared.continuation.id,
    expectedRevision: 3,
    expectedGeneration: 0,
    claimOwner: "daemon",
    claimToken: "claim-disallowed",
    abandonedTargetFence: disallowedFence,
    targetAttempt: { id: "attempt-replay-disallowed", runtimeInstanceId: "runtime-replay-disallowed",
      runnerId: "runner_pi_embedded", effectiveRunnerId: "runner_pi_embedded" },
    now: later,
  }), hasCode("continuation.lineage_mismatch"));
  assert.equal(disallowedReason.store.getWorkUnitAttempt(disallowedPrepared.attempt.id).status, "started");
  assert.equal(disallowedReason.store.listWorkUnitAttempts(disallowedReason.targetUnit.id).length, 1);
});

test("start rolls Attempt activation back when continuation CAS cannot commit", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareContinuationAndAttempt(f.input);
  const fence = toRuntimeAttemptFence(prepared.attempt);
  const claimed = f.store.claimRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 0, claimOwner: "daemon", claimToken: "claim-rollback", claimExpiresAt: expires, now });
  assert.equal(claimed.ok, true);
  f.database.exec(`
    CREATE TRIGGER reject_runner_start
    BEFORE UPDATE OF state ON runner_continuations
    WHEN NEW.state = 'running'
    BEGIN SELECT RAISE(ABORT, 'reject runner start'); END;
  `);
  assert.throws(() => f.store.startRunnerContinuation({ continuationId: prepared.continuation.id,
    expectedRevision: 1, claimOwner: "daemon", claimToken: "claim-rollback", targetFence: fence, now }),
  /reject runner start/u);
  assert.equal(f.store.getWorkUnitAttempt(prepared.attempt.id).status, "created");
  assert.equal(f.store.getRunnerContinuation(prepared.continuation.id).state, "claimed");
});

test("two SQLite connections prepare one continuation and one target Attempt", async (t) => {
  const f = await fixture(t);
  const gate = new SharedArrayBuffer(4);
  const jobs = [0, 1].map(() => runPrepareWorker(t, f.cwd, f.input, gate));
  await Promise.all(jobs.map((job) => job.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(jobs.map((job) => job.result));
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(results.filter((result) => result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.continuationId)).size, 1);
  assert.equal(new Set(results.map((result) => result.attemptId)).size, 1);
  assert.equal(count(f, "runner_continuations"), 1);
  assert.equal(f.store.listWorkUnitAttempts(f.targetUnit.id).length, 1);
});

test("two SQLite connections can grant only one claim generation", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareContinuationAndAttempt(f.input);
  const gate = new SharedArrayBuffer(4);
  const claims = ["claim-a", "claim-b"].map((claimToken) => runClaimWorker(t, f.cwd, {
    continuationId: prepared.continuation.id,
    expectedRevision: 0,
    claimOwner: "daemon-shared-name",
    claimToken,
    claimExpiresAt: expires,
    now,
  }, gate));
  await Promise.all(claims.map((claim) => claim.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(claims.map((claim) => claim.result));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.equal(["stale_revision", "invalid_transition"].includes(results.find((result) => !result.ok).code), true);
  const stored = f.store.getRunnerContinuation(prepared.continuation.id);
  assert.equal(stored.state, "claimed");
  assert.equal(stored.revision, 1);
  assert.equal(stored.claimToken, results.find((result) => result.ok).claimToken);
});

function runPrepareWorker(t, cwd, input, gate) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { createSqliteRunStore } = await import(workerData.module);
      const store = createSqliteRunStore(workerData.cwd);
      parentPort.postMessage({ ready: true });
      if (Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000) === "timed-out") {
        throw new Error("barrier timed out");
      }
      try {
        const result = store.prepareContinuationAndAttempt(workerData.input);
        parentPort.postMessage({ ok: true, replayed: result.replayed,
          continuationId: result.continuation.id, attemptId: result.attempt.id });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.code, message: error.message });
      } finally { store.close(); }
    })().catch((error) => { throw error; });
  `, {
    eval: true,
    workerData: { module: new URL("../dist/index.js", import.meta.url).href, cwd, input, gate },
  });
  t.after(() => worker.terminate());
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("worker timed out")), 15_000);
    const fail = (error) => { clearTimeout(timer); rejectReady(error); reject(error); };
    worker.on("message", (message) => {
      if (message.ready) resolveReady();
      else { clearTimeout(timer); resolve(message); }
    });
    worker.on("error", fail);
    worker.on("exit", (code) => { if (code !== 0) fail(new Error(`worker exited ${code}`)); });
  });
  void result.catch(() => {});
  return { ready, result };
}

function runClaimWorker(t, cwd, input, gate) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { createSqliteRunStore } = await import(workerData.module);
      const store = createSqliteRunStore(workerData.cwd);
      parentPort.postMessage({ ready: true });
      if (Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000) === "timed-out") {
        throw new Error("barrier timed out");
      }
      const result = store.claimRunnerContinuation(workerData.input);
      parentPort.postMessage(result.ok
        ? { ok: true, claimToken: result.value.claimToken }
        : { ok: false, code: result.code });
      store.close();
    })().catch((error) => { throw error; });
  `, {
    eval: true,
    workerData: { module: new URL("../dist/index.js", import.meta.url).href, cwd, input, gate },
  });
  t.after(() => worker.terminate());
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("worker timed out")), 15_000);
    const fail = (error) => { clearTimeout(timer); rejectReady(error); reject(error); };
    worker.on("message", (message) => {
      if (message.ready) resolveReady();
      else { clearTimeout(timer); resolve(message); }
    });
    worker.on("error", fail);
    worker.on("exit", (code) => { if (code !== 0) fail(new Error(`worker exited ${code}`)); });
  });
  void result.catch(() => {});
  return { ready, result };
}

function count(f, table) {
  return f.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function hasCode(expected) {
  return (error) => error?.code === expected;
}
