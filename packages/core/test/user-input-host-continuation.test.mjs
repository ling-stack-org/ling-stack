import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { userInputTranscriptFixture, claimedAt } from "./support/user-input-transcript-fixture.mjs";

const later = "2026-09-07T00:00:05.000Z";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ref = value => ({ id: value.id, fingerprint: value.fingerprint });
const code = expected => error => error.code === expected;
async function fixture(t, surface = "normal", options = {}) {
  const f = await userInputTranscriptFixture(t, { surface, ...options });
  f.submit(); f.delivery = f.claim();
  f.seed = f.store.getUserInputContinuationSeed(f.thread.id, f.delivery.deliveryId);
  f.claimIdentity = { threadId: f.thread.id, deliveryId: f.delivery.deliveryId, expectedRevision: f.delivery.revision,
    ownerId: f.delivery.claim.ownerId, claimToken: f.delivery.claim.token };
  f.task = { id: f.run.taskId, title: "Continue", prompt: "Accepted answer: dark", ...(f.channel ? { channelId: f.channel.id } : {}) };
  f.runRequest = { cwd: f.cwd, threadId: f.thread.id, turnId: f.turn.turnId, task: f.task,
    teammateId: f.participantId, workflowStepId: f.step?.id,
    parentRunId: f.run.id, continuationReason: "user_input_answer" };
  const modelInput = { schemaVersion: 1, boundary: "pi-model-context", taskId: f.task.id,
    systemPrompt: "Fixture", userPrompt: "Task: Continue\n\nAccepted answer: dark",
    model: { id: "fixture", provider: "fixture" }, tools: [], thinkingLevel: "off" };
  f.preparedInput = { ...modelInput, fingerprint: hash(modelInput) };
  f.prepare = (adjust = () => {}) => {
    f.preparedRequest = f.store.saveUserInputContinuationPreparation({ ...f.claimIdentity, stage: "request",
      parentRef: ref(f.seed), payload: f.runRequest }, claimedAt).snapshot;
    const runnerExecutionInput = { schemaVersion: 1, runnerId: "pi", toolHydrationEnabled: false,
      input: { cwd: f.cwd, task: f.task, provider: { provider: "fixture", model: "fixture" }, tools: [] },
      preparedInput: f.preparedInput };
    f.plan = { schemaVersion: 1, runnerId: "pi", providerName: "fixture", providerModel: "fixture",
      taskSnapshot: f.task, providerSnapshot: { provider: "fixture", model: "fixture" }, requestSnapshot: f.runRequest,
      runRequestSnapshot: { ...f.runRequest, runnerExecutionInput },
      preparedInput: f.preparedInput, preparedInputFingerprint: f.preparedInput.fingerprint,
      runnerExecutionInput };
    adjust(f.plan);
    f.preparedExecution = f.store.saveUserInputContinuationPreparation({ ...f.claimIdentity, stage: "execution",
      parentRef: ref(f.preparedRequest), payload: f.plan }, claimedAt).snapshot;
    return f.preparedExecution;
  };
  f.admit = () => f.store.admitUserInputContinuation({ ...f.claimIdentity,
    executionRef: ref(f.preparedExecution), runtimeInstanceId: "receiver-runtime" }, claimedAt);
  f.ackInput = binding => ({ threadId: f.thread.id, deliveryId: f.delivery.deliveryId, bindingRef: ref(binding), sourceFence: binding.fence,
    receipt: { schemaVersion: 1, boundary: "pi-session-ready", runId: binding.runId, attemptId: binding.fence.attemptId,
      taskId: f.run.taskId, preparedInputFingerprint: f.preparedInput.fingerprint } });
  return f;
}

for (const surface of ["normal", "private", "channel"]) {
  test(`Host continuation keeps the original ${surface} owner through preparation, binding and ACK`, async t => {
    const f = await fixture(t, surface); f.prepare();
    assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
    const binding = f.admit();
    const run = f.store.getRun(binding.runId), unit = f.store.getWorkUnit(f.unit.id);
    assert.equal(run.id, f.delivery.successorRunId);
    assert.equal(run.threadId, f.thread.id);
    assert.equal(run.parentRunId, f.run.id);
    assert.equal(run.continuationReason, "user_input_answer");
    assert.ok(run.requestSnapshot.runnerExecutionInput, "successor must retain its own reusable execution input");
    assert.deepEqual(run.requestSnapshot.runnerExecutionInput, f.plan.runnerExecutionInput);
    assert.equal(run.teammateId, f.participantId);
    assert.equal(run.channelId, f.channel?.id);
    assert.equal(unit.activeAttemptId, binding.fence.attemptId);
    assert.equal(unit.linkedRunId, run.id);
    assert.equal(unit.status, "claimed");
    assert.equal(f.store.getUserInputWait(f.thread.id, f.requestId ?? f.seed.request.requestId).status, "resuming");
    assert.equal(f.store.getRun(f.run.id).status, "yielded");
    assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "yielded");
    assert.equal(f.store.listLingTurnRuns(f.turn.turnId).find(link => link.runId === run.id).role, "resume");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ling_turns").get().n, 1);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
    assert.equal(f.store.getRun(binding.runId).status, "queued");
    assert.equal(f.store.getWorkUnit(binding.fence.workUnitId).status, "claimed");
    assert.equal(f.store.getWorkUnitAttempt(binding.fence.attemptId).status, "created");
    const receipt = f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later);
    assert.equal(receipt.replayed, false);
    assert.equal(f.store.getRun(binding.runId).status, "running");
    assert.equal(f.store.getWorkUnit(binding.fence.workUnitId).status, "running");
    assert.equal(f.store.getWorkUnitAttempt(binding.fence.attemptId).status, "started");
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "applied");
    assert.equal(f.store.getUserInputWait(f.thread.id, f.seed.request.requestId).status, "resumed");
    assert.equal(f.store.getLingTurn(f.turn.turnId).status, "running");
    assert.equal(f.read().find(item => item.kind === "user_input_answer").delivery.status, "applied");
    assert.equal(f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later).replayed, true);
    assert.ok(Object.isFrozen(receipt.receipt));
  });
}
test("first preparation wins and expired/replaced delivery workers cannot change it", async t => {
  const f = await fixture(t); f.prepare();
  const result = f.store.saveUserInputContinuationPreparation({ ...f.claimIdentity, stage: "request",
    parentRef: ref(f.seed), payload: { different: true } }, claimedAt);
  assert.equal(result.idempotentReplay, true);
  assert.deepEqual(result.snapshot, f.preparedRequest);
  const replacement = f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: f.delivery.deliveryId,
    expectedRevision: f.delivery.revision, ownerId: "replacement", leaseMs: 1000 }, later);
  assert.throws(() => f.admit(), code("delivery_conflict"));
  assert.equal(f.store.getRun(replacement.successorRunId), undefined);
});
test("execution preparation without reusable source input cannot admit an unrecoverable successor", async t => {
  const f = await fixture(t);
  assert.throws(() => f.prepare(plan => { delete plan.runnerExecutionInput; }), code("source_conflict"));
  assert.equal(f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "execution"), undefined);
  assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
});
for (const change of ["runner", "cwd", "task", "provider", "sdk", "hydration"]) {
  test(`execution preparation rejects a mismatched reusable source input: ${change}`, async t => {
    const f = await fixture(t);
    assert.throws(() => f.prepare(plan => {
      const value = plan.runnerExecutionInput;
      if (change === "runner") value.runnerId = "foreign-runner";
      if (change === "cwd") value.input.cwd = "/foreign";
      if (change === "task") value.input.task = { ...f.task, prompt: "a different task" };
      if (change === "provider") value.input.provider = { provider: "fixture", model: "foreign" };
      if (change === "sdk") value.preparedInput = { ...f.preparedInput, userPrompt: "a different input" };
      if (change === "hydration") value.toolHydrationEnabled = "true";
    }), code("source_conflict"));
    assert.equal(f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "execution"), undefined);
    assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
  });
}
for (const change of ["missing", "replaced"]) {
  test(`admitted Run cannot lose or replace its own SDK source input before ACK: ${change}`, async t => {
    const f = await fixture(t); f.prepare(); const binding = f.admit();
    const run = f.store.getRun(binding.runId), snapshot = structuredClone(run.requestSnapshot);
    if (change === "missing") delete snapshot.runnerExecutionInput;
    else snapshot.runnerExecutionInput.input.task.prompt = "borrowed parent input";
    f.db.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), run.id);
    assert.throws(() => f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId), code("invalid_record"));
    assert.throws(() => f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later), code("invalid_record"));
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
  });
}
test("binding survives reopen and cannot allocate another successor after lease expiry", async t => {
  const f = await fixture(t); f.prepare(); const binding = f.admit();
  const other = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(other.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId), binding);
    assert.throws(() => other.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: f.delivery.deliveryId,
      expectedRevision: other.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).revision, ownerId: "replacement", leaseMs: 1000 }, later), code("delivery_conflict"));
    assert.throws(() => f.admit(), code("delivery_conflict"));
    assert.equal(other.listWorkUnitAttempts(f.unit.id).length, 2);
  } finally { other.close(); }
});
test("startup recovery preserves the exact pre-ACK user-input binding", async t => {
  const f = await fixture(t); f.prepare(plan => {
    plan.runRequestSnapshot.userInputContinuationContext = { seedRef: ref(f.seed) };
  }); const binding = f.admit();
  assert.equal(f.store.recoverStaleRuns(later), 0);
  assert.equal(f.store.getRun(binding.runId).status, "queued");
  assert.equal(f.store.getWorkUnit(binding.fence.workUnitId).status, "claimed");
  assert.equal(f.store.getWorkUnitAttempt(binding.fence.attemptId).status, "created");
  assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
  assert.equal(f.store.listEvents(binding.runId, { limit: 100 }).some(event => event.type === "run_error"), false);
});
test("startup recovery still fails a queued successor without valid user-input lineage", async t => {
  const f = await fixture(t); f.prepare(plan => {
    plan.runRequestSnapshot.userInputContinuationContext = { seedRef: ref(f.seed) };
  }); const binding = f.admit();
  f.db.prepare("UPDATE run_sessions SET continuation_reason=NULL WHERE id=?").run(binding.runId);
  assert.equal(f.store.recoverStaleRuns(later), 1);
  assert.equal(f.store.getRun(binding.runId).status, "failed");
  assert.equal(f.store.listEvents(binding.runId, { limit: 100 }).some(event => event.type === "run_error"), true);
});
for (const target of ["run_sessions", "work_unit_attempts", "conversation_context_snapshots", "control_plane_events"]) {
  test(`admission rolls back all pointers if ${target} rejects a write`, async t => {
    const f = await fixture(t); f.prepare();
    f.db.exec(`CREATE TRIGGER admission_failure BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'admission failure'); END`);
    assert.throws(() => f.admit(), /admission failure/);
    assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
    assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, undefined);
    assert.equal(f.store.getWorkUnit(f.unit.id).linkedRunId, f.run.id);
    assert.equal(f.store.getUserInputWait(f.thread.id, f.seed.request.requestId).status, "waiting");
    f.db.exec("DROP TRIGGER admission_failure");
    assert.equal(f.admit().runId, f.delivery.successorRunId);
  });
}
test("logical cancellation wins before admission and keeps the accepted answer", async t => {
  const f = await fixture(t); f.prepare();
  f.store.cancelUserInputWait({ threadId: f.thread.id, sourceRunId: f.run.id }, claimedAt);
  assert.throws(() => f.admit(), code("delivery_conflict"));
  assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
  assert.equal(f.read().find(item => item.kind === "user_input_answer").availability, "available");
});
test("stale execution fence and receipt fingerprint cannot ACK", async t => {
  const f = await fixture(t); f.prepare(); const binding = f.admit();
  const input = f.ackInput(binding);
  assert.throws(() => f.store.acknowledgeUserInputContinuation({ ...input,
    sourceFence: { ...input.sourceFence, fencingToken: "wrong" } }, later), code("source_conflict"));
  assert.throws(() => f.store.acknowledgeUserInputContinuation({ ...input,
    receipt: { ...input.receipt, preparedInputFingerprint: "0".repeat(64) } }, later), code("source_conflict"));
  f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 3, runtimeInstanceId: "replacement-runtime", runnerId: "pi", now: later });
  assert.throws(() => f.store.acknowledgeUserInputContinuation(input, later), code("source_conflict"));
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
});
test("ACK, wait state and transcript visibility roll back together", async t => {
  const f = await fixture(t); f.prepare(); const binding = f.admit();
  f.db.exec("CREATE TRIGGER receipt_failure BEFORE UPDATE ON user_input_deliveries WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
  assert.throws(() => f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later), /receipt failure/);
  assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
  assert.equal(f.store.getUserInputWait(f.thread.id, f.seed.request.requestId).status, "resuming");
  assert.equal(f.store.getRun(binding.runId).status, "queued");
  assert.equal(f.store.getWorkUnit(binding.fence.workUnitId).status, "claimed");
  assert.equal(f.store.getWorkUnitAttempt(binding.fence.attemptId).status, "created");
  f.db.exec("DROP TRIGGER receipt_failure");
  assert.equal(f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later).replayed, false);
  const other = createSqliteRunStore(f.cwd);
  try {
    assert.equal(other.acknowledgeUserInputContinuation(f.ackInput(binding), later).replayed, true);
    assert.equal(other.getUserInputContinuationReceipt("foreign", f.delivery.deliveryId), undefined);
  } finally { other.close(); }
});

for (const options of [{ storedTask: true }, { workflow: true }, { storedTask: true, workflow: true }]) {
  test(`admission and ACK move only the bound Task/step: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, "channel", options); f.prepare();
    const sibling = f.siblingStep && f.store.getChannelWorkflowStep(f.siblingStep.id);
    const binding = f.admit();
    assert.equal(f.seed.source.taskBinding.kind, options.storedTask ? "stored_task" : "run_snapshot");
    if (f.storedTask) {
      assert.equal(f.store.getTask(f.storedTask.id).status, "claimed");
      assert.equal(f.store.getTask(f.storedTask.id).currentRunId, binding.runId);
    }
    if (f.step) {
      assert.equal(f.store.getRun(binding.runId).workflowStepId, f.step.id);
      assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "claimed");
      assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, binding.runId);
    }
    assert.equal(f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later).replayed, false);
    if (sibling) assert.deepEqual(f.store.getChannelWorkflowStep(sibling.id), sibling);
  });
}
for (const stage of ["request", "binding", "receipt"]) {
  test(`deferred COMMIT failure rolls back ${stage} and its state changes`, async t => {
    const f = await fixture(t, "channel", { storedTask: true, workflow: true });
    if (stage !== "request") f.prepare();
    const binding = stage === "receipt" ? f.admit() : undefined;
    const before = [f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId), f.store.getWorkUnit(f.unit.id),
      f.store.getTask(f.storedTask.id), f.store.getChannelWorkflowStep(f.step.id), f.store.getLingThread(f.thread.id),
      f.store.getUserInputWait(f.thread.id, f.request.requestId)];
    f.db.exec("CREATE TABLE deferred_host_failure(id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED)");
    f.db.exec(`CREATE TRIGGER host_commit_failure AFTER INSERT ON conversation_context_snapshots WHEN NEW.snapshot_use='user_input_continuation_${stage}' BEGIN INSERT INTO deferred_host_failure VALUES ('missing'); END`);
    const invoke = stage === "request" ? () => f.prepare() : stage === "binding" ? () => f.admit()
      : () => f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later);
    assert.throws(invoke, /FOREIGN KEY/);
    assert.equal(f.db.prepare("SELECT id FROM conversation_context_snapshots WHERE snapshot_use=?").get("user_input_continuation_" + stage), undefined);
    assert.deepEqual([f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId), f.store.getWorkUnit(f.unit.id),
      f.store.getTask(f.storedTask.id), f.store.getChannelWorkflowStep(f.step.id), f.store.getLingThread(f.thread.id),
      f.store.getUserInputWait(f.thread.id, f.request.requestId)], before);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, binding ? 2 : 1);
    f.db.exec("DROP TRIGGER host_commit_failure");
    assert.ok(invoke());
  });
}
for (const stage of ["request", "execution", "binding", "receipt"]) {
  for (const damage of ["payload", "scope", "parent"]) {
    test(`corrupt ${stage} ${damage} cannot hydrate an applied answer`, async t => {
      const f = await fixture(t); f.prepare(); const binding = f.admit();
      f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later);
      const recordId = `user_input_continuation_${stage}:${f.delivery.deliveryId}`;
      if (damage === "payload") f.db.prepare("UPDATE conversation_context_snapshots SET payload_json='{}' WHERE id=?").run(recordId);
      if (damage === "scope") {
        const otherThread = f.store.createLingThread({ kind: "conversation", title: "Other", objective: "Other scope" }, later);
        f.db.prepare("UPDATE conversation_context_snapshots SET thread_id=? WHERE id=?").run(otherThread.id, recordId);
      }
      if (damage === "parent") {
        const body = JSON.parse(f.db.prepare("SELECT payload_json FROM conversation_context_snapshots WHERE id=?").get(recordId).payload_json);
        const { fingerprint, ...rest } = body;
        const parentKey = stage === "binding" ? "executionRef" : stage === "receipt" ? "bindingRef" : "parentRef";
        rest[parentKey].id = "foreign-parent";
        const amended = { ...rest, fingerprint: hash(rest) };
        f.db.prepare("UPDATE conversation_context_snapshots SET payload_json=?,payload_fingerprint=? WHERE id=?")
          .run(JSON.stringify(amended), amended.fingerprint, recordId);
      }
      assert.equal(f.store.getUserInputContinuationReceipt("foreign-thread", f.delivery.deliveryId), undefined);
      assert.throws(() => f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), code("invalid_record"));
      assert.notEqual(f.read().find(item => item.kind === "user_input_answer").delivery?.status, "applied");
    });
  }
}
test("missing upstream preparation or binding cannot be reconstructed from an admitted Run", async t => {
  for (const stage of ["request", "execution", "binding"]) {
    const f = await fixture(t); f.prepare(); const binding = f.admit();
    f.db.prepare("DELETE FROM conversation_context_snapshots WHERE snapshot_use=?").run("user_input_continuation_" + stage);
    assert.throws(() => f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId), code("invalid_record"));
    assert.throws(() => f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later), code("invalid_record"));
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
  }
});
test("preparation rejects secrets and SQL-writing getters without changing the claim", async t => {
  const f = await fixture(t);
  const save = payload => f.store.saveUserInputContinuationPreparation({ ...f.claimIdentity, stage: "request", parentRef: ref(f.seed), payload }, claimedAt);
  assert.throws(() => save({ ...f.runRequest, apiKey: "fixture-only-not-a-credential" }), code("sensitive_input"));
  f.store.database.exec("CREATE TABLE input_getter_writes(value INTEGER)");
  assert.throws(() => save({ ...f.runRequest, get note() {
    f.store.database.exec("INSERT INTO input_getter_writes VALUES (1)"); return "unreachable";
  } }), /readonly/i);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM input_getter_writes").get().n, 0);
  assert.equal(f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "request"), undefined);
  assert.deepEqual(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId), f.delivery);
  f.prepare(); assert.ok(f.admit());
});
test("archived conversation cannot ACK, and a failed ACK does not unarchive it", async t => {
  const f = await fixture(t); f.prepare(); const binding = f.admit();
  f.store.updateLingThread(f.thread.id, { status: "archived", archivedAt: later }, later);
  assert.throws(() => f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later), code("source_conflict"));
  assert.equal(f.store.getLingThread(f.thread.id).status, "archived");
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
});
test("historical receipt remains readable after its execution finishes", async t => {
  const f = await fixture(t); f.prepare(); const binding = f.admit();
  const receipt = f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later).receipt;
  assert.equal(f.store.transitionWorkUnitStatus({ ...binding.fence, expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: later }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...binding.fence, status: "succeeded", endedAt: later, now: later }));
  assert.equal(f.store.transitionRunStatus({ runId: binding.runId, expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: later }).ok, true);
  assert.deepEqual(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), receipt);
  assert.equal(f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later).replayed, true);
  assert.equal(f.read().find(item => item.kind === "user_input_answer").delivery.status, "applied");
});
for (const owner of ["task", "step", "turn"]) {
  test(`cancellation of the current ${owner} wins before receiver ACK`, async t => {
    const f = await fixture(t, "channel", { storedTask: true, workflow: true }); f.prepare();
    const binding = f.admit();
    const result = owner === "task" ? f.store.transitionTaskStatus({ taskId: f.storedTask.id, expectedStatus: "claimed", event: "cancel", actor: "user", now: later })
      : owner === "step" ? f.store.transitionChannelWorkflowStepStatus({ workflowStepId: f.step.id, expectedStatus: "claimed", event: "cancel", actor: "user", now: later })
      : f.store.transitionLingTurnStatus({ turnId: f.turn.turnId, expectedStatus: "running", event: "cancel", actor: "user", now: later });
    assert.equal(result.ok, true);
    assert.throws(() => f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later), code("source_conflict"));
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
  });
}
test("continuation admission and ACK preserve a sibling approval's Thread priority", async t => {
  const f = await fixture(t, "channel", { storedTask: true, workflow: true }); f.prepare();
  const sibling = f.store.createRun({ id: "approval-sibling", cwd: f.cwd, taskId: "approval-task", threadId: f.thread.id,
    channelId: f.channel.id, teammateId: "teammate_builtin_engineer", turnId: f.turn.turnId, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: claimedAt });
  f.store.markRunStarted(sibling.id, claimedAt);
  assert.equal(f.store.transitionRunStatus({ runId: sibling.id, expectedStatus: "running", event: "approval_requested", actor: "system", now: claimedAt }).ok, true);
  const before = f.store.getRun(sibling.id);
  const binding = f.admit();
  assert.equal(f.store.getLingThread(f.thread.id).status, "waiting_for_approval");
  assert.equal(f.store.getLingThread(f.thread.id).activeRunId, sibling.id);
  f.store.acknowledgeUserInputContinuation(f.ackInput(binding), later);
  assert.deepEqual(f.store.getRun(sibling.id), before);
  assert.equal(f.store.getLingThread(f.thread.id).status, "waiting_for_approval");
  assert.equal(f.store.getLingThread(f.thread.id).activeRunId, sibling.id);
});
for (const operation of ["admitUserInputContinuation", "acknowledgeUserInputContinuation"]) {
  test(`two SQLite connections serialize ${operation} to one write`, { timeout: 20000 }, async t => {
    const f = await fixture(t); f.prepare();
    const binding = operation === "acknowledgeUserInputContinuation" ? f.admit() : undefined;
    const input = binding ? f.ackInput(binding) : { ...f.claimIdentity, executionRef: ref(f.preparedExecution), runtimeInstanceId: "parallel-runtime" };
    const gate = new SharedArrayBuffer(4);
    const workers = [0, 1].map(() => new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {createSqliteRunStore}=await import(workerData.moduleUrl);
        const store=createSqliteRunStore(workerData.cwd);
        parentPort.postMessage({ready:true});
        if(Atomics.wait(new Int32Array(workerData.gate),0,0,10000)==='timed-out') throw new Error('barrier timeout');
        try { parentPort.postMessage({result:store[workerData.operation](workerData.input,workerData.now)}); }
        catch(error) { parentPort.postMessage({error:error.code ?? error.message}); }
        finally {store.close();}
      })().catch(error=>{throw error});`, { eval: true, workerData: {
        moduleUrl: new URL("../dist/index.js", import.meta.url).href, cwd: f.cwd, gate, operation, input,
        now: binding ? later : claimedAt,
      } }));
    t.after(() => Promise.all(workers.map(worker => worker.terminate())));
    await Promise.all(workers.map(worker => once(worker, "message")));
    const pending = Promise.all(workers.map(worker => once(worker, "message")));
    Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
    const results = (await pending).map(([result]) => result);
    if (binding) {
      assert.equal(results.filter(item => item.result?.replayed === false).length, 1);
      assert.equal(results.filter(item => item.result?.replayed === true).length, 1);
    } else {
      assert.equal(results.filter(item => item.result).length, 1);
      assert.equal(results.filter(item => item.error === "delivery_conflict").length, 1);
    }
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
  });
}
