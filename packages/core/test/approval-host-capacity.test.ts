import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { approvalSideEffectFingerprintV1, createApprovalResumeBasisV1, SqliteRunStore,
  toRuntimeAttemptFence } from "../dist/index.js";
import { createRuntimeHostCapacityStoreBinding, RuntimeHostCapacityBridge,
  type RuntimeHostCapacityDispatchReference } from "../dist/runtime-host-capacity-store-bridge.js";
import { hostCapacityFixture } from "./support/runtime-host-capacity-fixture.ts";
import { runtimeRunQueueFixture } from "./support/runtime-run-queue-fixture.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";

async function fixture(t: TestContext, { native = false }: { native?: boolean } = {}) {
  let bound: SqliteRunStore | undefined;
  t.after(() => { if (bound && testDatabase(bound).isOpen) bound.close(); });
  const host = hostCapacityFixture(t), queue = await runtimeRunQueueFixture(t, { clockStart: Date.now() - 30_000 });
  const capacity = createRuntimeHostCapacityStoreBinding();
  const store = bound = new SqliteRunStore({ cwd: queue.cwd, paths: queue.paths, runtimeHostCapacityBinding: capacity.binding });
  const current = queue.prepare("approval", { tools: ["bash"], ...(native ? {
    requestOverrides: { executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 2 } },
  } : {}) });
  const now = queue.at(3), { run, unit, attempt, fence } = current;
  assert.ok(store.transitionTaskStatus({ taskId: run.taskId, expectedStatus: "todo", event: "claim", actor: "system", now }).ok);
  assert.ok(store.transitionTaskStatus({ taskId: run.taskId, expectedStatus: "claimed", event: "start_run", actor: "system", currentRunId: run.id, now }).ok);
  store.markRunStarted(run.id, now);
  assert.ok(store.transitionWorkUnitStatus({ ...fence, activeAttemptId: attempt.id, expectedStatus: "queued", event: "claim", actor: "system", now }).ok);
  assert.ok(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now }).ok);
  assert.ok(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "approval_requested", actor: "system", now }).ok);
  assert.ok(store.updateWorkUnitAttemptStatus({ ...fence, status: "waiting_for_approval", now }));
  assert.ok(store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "approval_requested", actor: "system", now }).ok);
  const payload = { type: "bash" as const, cwd: queue.cwd, command: "printf approval-host", riskFlags: [] };
  const approval = store.createApprovalRequest({ runId: run.id, taskId: run.taskId, toolCallId: "approval-host-command",
    actionType: "bash", risk: "medium", title: "Approved command", description: payload.command, payload }, now);
  const initial = store.getApprovalCheckpointForApproval(approval.id);
  assert.ok(initial && approval.toolCallId);
  const basis = createApprovalResumeBasisV1({ approvalId: approval.id, runId: run.id, workUnitId: unit.id,
    priorAttemptId: attempt.id, toolCallId: approval.toolCallId, actionType: approval.actionType,
    sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: approval.actionType, toolCallId: approval.toolCallId, sideEffect: payload }) });
  assert.ok(store.updateApprovalCheckpointStatus(initial.id, { status: "pending", expectedStatus: "pending",
    expectedRevision: initial.revision, resumeBasis: basis }, now));
  assert.equal(store.approveApprovalRequest(approval.id, { reason: "fixture approval" }, now)?.status, "approved");
  const checkpoint = store.getApprovalCheckpoint(initial.id);
  assert.ok(checkpoint);
  const journal = capacity.workspace(queue.workspaceId), bridge = new RuntimeHostCapacityBridge(journal, host.host);
  const pending = { checkpointId: checkpoint.id, expectedCheckpointRevision: checkpoint.revision,
    expectedActiveAttemptId: attempt.id, runtimeInstanceId: "approval-executor", now: queue.at(4) };
  const claim = { checkpointId: checkpoint.id, expectedCheckpointStatus: "approved" as const,
    expectedCheckpointRevision: checkpoint.revision, approvalId: approval.id, runId: run.id, workUnitId: unit.id,
    expectedActiveAttemptId: attempt.id, attemptToLoseId: attempt.id,
    replacementAttempt: { id: "approval-resumed-attempt", workUnitId: unit.id, attemptNumber: 2,
      runtimeInstanceId: pending.runtimeInstanceId, runnerId: native ? "kimi-acp" : "pi",
      effectiveRunnerId: native ? "kimi-acp" : "pi", providerPresetId: attempt.providerPresetId, now: queue.at(5) },
    runnerResumeHandle: { kind: "ling_continuation" as const, runId: run.id, attemptId: "approval-resumed-attempt", verified: true },
    mode: "activate_waiting" as const, now: queue.at(5) };
  const reserve = (): RuntimeHostCapacityDispatchReference => {
    const reserved = bridge.reserveApprovalResumePending(pending);
    assert.ok(reserved.status === "reserved" || reserved.status === "duplicate", JSON.stringify(reserved));
    assert.ok(reserved.record.dispatchToken);
    return { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken };
  };
  const snapshot = () => Object.fromEntries(["approval_checkpoints", "run_sessions", "work_units", "work_unit_attempts",
    "runtime_events", "run_events", "control_plane_events", "state_transition_events", "resource_leases",
    "runtime_semaphore_slots", "runtime_host_capacity_intents", "runtime_host_capacity_releases"].map(table => [table, queue.rows(table)]));
  return { store, host, queue, current, checkpoint, journal, pending, claim, reserve, snapshot };
}

test("Host-backed approval claims require a receipt before any durable claim writes", async t => {
  const f = await fixture(t), before = f.snapshot();
  assert.deepEqual(f.store.commitApprovalResumeClaim(f.claim), { ok: false, code: "approval_resume_host_capacity_changed" });
  assert.deepEqual(f.snapshot(), before);
});

test("an unbound legacy Store cannot accept a Host receipt", async t => {
  const f = await fixture(t), hostCapacity = f.reserve(), before = f.snapshot();
  assert.deepEqual(f.queue.store.commitApprovalResumeClaim({ ...f.claim, hostCapacity }),
    { ok: false, code: "approval_resume_host_capacity_changed" });
  assert.deepEqual(f.snapshot(), before);
});

test("approval claim binds the exact created Attempt after checkpoint and Run activation", async t => {
  const f = await fixture(t), hostCapacity = f.reserve();
  const result = f.store.commitApprovalResumeClaim({ ...f.claim, hostCapacity });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.checkpoint.revision, f.checkpoint.revision + 1);
  assert.equal(result.checkpoint.status, "resume_pending");
  assert.equal(result.checkpoint.runnerResumeHandle?.attemptId, result.attempt.id);
  assert.equal(result.run.status, "running");
  assert.equal(result.workUnit.status, "running");
  assert.equal(result.workUnit.activeAttemptId, result.attempt.id);
  assert.equal(result.attempt.status, "created");
  assert.equal(result.attempt.startedAt, undefined);
  assert.equal(f.store.listRuntimeEvents(result.workUnit.id, { limit: 100 })
    .filter(event => event.type === "work_unit_started" && event.attemptId === result.attempt.id).length, 0);
  const record = f.journal.getIntent(hostCapacity.intentId);
  assert.deepEqual(record?.source, { runId: result.run.id, ...toRuntimeAttemptFence(result.attempt) });
  assert.equal(record?.dispatchedAt, undefined);
  assert.equal(f.host.host.counts().held, 1);
});

test("native profile approval resume binds and consumes the matching Host dispatch gate", async t => {
  const f = await fixture(t, { native: true }), hostCapacity = f.reserve();
  const result = f.store.commitApprovalResumeClaim({ ...f.claim, hostCapacity });
  assert.ok(result.ok, JSON.stringify(result));
  const resumed = { ...f.current, run: result.run, unit: result.workUnit, attempt: result.attempt,
    fence: toRuntimeAttemptFence(result.attempt) } as Parameters<typeof f.queue.resources>[0];
  const group = f.queue.resources(resumed, f.queue.at(6));
  for (const lease of group.leases) assert.ok(f.store.acquireResourceLease(lease));
  const acquired = f.store.acquireRuntimeSemaphoreSlots(group.semaphores);
  assert.equal(acquired.status, "acquired", JSON.stringify({ group, acquired,
    rows: f.queue.rows("runtime_semaphore_slots") }));
  const db = testDatabase(f.store);
  db.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(f.journal.consumeDispatchGateWithinTransaction({ intentId: hostCapacity.intentId,
      token: hostCapacity.dispatchToken, source: { runId: result.run.id, ...toRuntimeAttemptFence(result.attempt) }, now: f.queue.at(6) }), true);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  assert.equal(f.journal.getIntent(hostCapacity.intentId)?.dispatchedAt, f.queue.at(6));
  assert.deepEqual(f.queue.rows("runtime_semaphore_slots").map(row => [row.resource_type, row.resource_key]), [
    ["provider", "native:fixture:2"], ["runner", "kimi-acp"], ["channel_parallel", f.current.channel.id],
  ]);
});

for (const fault of ["token", "runtime", "checkpoint-cas", "source-cas"] as const) {
  test(`approval claim rejects ${fault} changes without binding or activating anything`, async t => {
    const f = await fixture(t), reference = f.reserve(), before = f.snapshot();
    const claim = { ...f.claim, hostCapacity: reference,
      ...(fault === "token" ? { hostCapacity: { ...reference, dispatchToken: "0".repeat(64) } } : {}),
      ...(fault === "runtime" ? { replacementAttempt: { ...f.claim.replacementAttempt, runtimeInstanceId: "other-runtime" } } : {}),
      ...(fault === "checkpoint-cas" ? { expectedCheckpointRevision: f.claim.expectedCheckpointRevision + 1 } : {}),
      ...(fault === "source-cas" ? { expectedActiveAttemptId: "other-attempt" } : {}) };
    const result = f.store.commitApprovalResumeClaim(claim);
    assert.equal(result.ok, false);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.journal.getIntent(reference.intentId)?.source, undefined);
    assert.equal(testDatabase(f.store).isTransaction, false);
  });
}

test("an observer write failure rolls back the Host binding with checkpoint, Attempt and activation", async t => {
  const f = await fixture(t), hostCapacity = f.reserve(), before = f.snapshot();
  testDatabase(f.store).exec(`CREATE TRIGGER approval_host_observer_fault BEFORE INSERT ON control_plane_events
    WHEN NEW.idempotency_key LIKE 'approval-resume-claim:%'
    BEGIN SELECT RAISE(ABORT,'approval-host-observer-fault'); END`);
  assert.throws(() => f.store.commitApprovalResumeClaim({ ...f.claim, hostCapacity }), /approval-host-observer-fault/u);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.journal.getIntent(hostCapacity.intentId)?.source, undefined);
  assert.equal(testDatabase(f.store).isTransaction, false);
});
