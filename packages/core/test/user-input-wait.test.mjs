import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteRunStore, resolveRuntimePaths, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, projectLingTrace } from "../dist/index.js";
import { SqliteResourceLeaseStore } from "../dist/storage/sqlite/resource-lease-store.js";
import { SqliteLingThreadStore } from "../dist/storage/sqlite/ling-thread-store.js";

const now = "2026-09-07T00:00:00.000Z";
const stoppedAt = "2026-09-07T00:00:01.000Z";
const committedAt = "2026-09-07T00:00:02.000Z";
const code = (expected) => (error) => error.code === expected;

test("verified yield atomically releases original resources while its enclosing Host observation is pending", async t => {
  const f = await fixture(t);
  let finish;
  const observation = f.store.trackHostAttemptCompletion({ runId: f.run.id, ...f.fence },
    new Promise(resolve => { finish = resolve; }));
  assert.equal(f.store.releaseResourceLeasesForAttempt(f.fence, committedAt, "user_input_yielded"), 0,
    "a release reason is not the verified yield transaction");
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(f.fence, committedAt, "user_input_yielded"), 0);
  const result = f.yield();
  assert.equal(result.wait.status, "waiting");
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, undefined);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
  assert.equal(f.store.getHostAttemptCompletion({ runId: f.run.id, ...f.fence }).drainedAt, undefined);
  finish();
  await observation;
});

for (const table of ["resource_leases", "runtime_semaphore_slots"]) {
  test(`verified yield rolls back both resource tables and checkpoint when ${table} cleanup fails`, async t => {
    const f = await fixture(t);
    f.db.exec(`CREATE TRIGGER reject_yield_cleanup BEFORE UPDATE ON ${table}
      WHEN NEW.status='released' BEGIN SELECT RAISE(ABORT,'controlled yield cleanup failure'); END`);
    assert.throws(() => f.yield(), /controlled yield cleanup failure/);
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId), undefined);
    assert.equal(f.store.getRun(f.run.id).status, "running");
    assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, f.attempt.id);
    assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  });
}

test("normal conversation with only a run task snapshot can atomically wait", async (t) => {
  const f = await fixture(t, "required", false, false);
  const result = f.yield();
  assert.equal(result.wait.status, "waiting");
  assert.deepEqual(result.wait.checkpoint.source.taskBinding, { kind: "run_snapshot", taskId: f.task.id });
  assert.equal(result.wait.checkpoint.taskId, f.task.id);
  assert.equal(f.store.getTask(f.task.id), undefined, "waiting must not invent a Task record");
  assert.equal(f.store.getLingTurn(f.turn.turnId).status, "waiting_for_input");
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "waiting_for_input");
  assert.equal(f.store.listRuntimeSemaphoreSlots({ workUnitId: f.unit.id, status: "active" }).length, 0);
});

test("a missing stored task cannot silently become a run-only snapshot while yielding", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.request.source.taskBinding, { kind: "stored_task", taskId: f.task.id });
  const getTask = f.store.getTask.bind(f.store);
  f.store.getTask = (id) => id === f.task.id ? undefined : getTask(id);
  assert.throws(() => f.yield(), code("source_conflict"));
  assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId), undefined);
});

const cancelledAt = "2026-09-07T00:00:03.000Z";
const cancelWait = f => f.store.cancelUserInputWait({ threadId: f.thread.id, sourceRunId: f.run.id }, cancelledAt);

test("request-only cancellation cannot orphan an already committed required wait", async (t) => {
  const f = await fixture(t);
  f.yield();
  assert.throws(() => f.store.cancelUserInputRequest({ threadId: f.thread.id,
    requestId: f.request.requestId, expectedStatusRevision: 1 }, cancelledAt), code("wait_conflict"));
  assert.equal(f.store.getUserInputRequest(f.thread.id, f.request.requestId).status, "pending");
});

for (const answered of [false, true]) {
  test(`cancel waiting logical work without rewriting yielded execution: answered=${answered}`, async (t) => {
    const f = await fixture(t);
    const receipt = answered ? f.submit() : undefined;
    f.yield();
    const runBefore = f.store.getRun(f.run.id);
    const attemptBefore = f.store.getWorkUnitAttempt(f.attempt.id);
    const result = cancelWait(f);
    assert.equal(result.replayed, false);
    assert.equal(result.wait.status, "cancelled");
    assert.equal(result.wait.revision, 2);
    assert.equal(result.request.status, answered ? "answered" : "cancelled");
    assert.deepEqual(f.store.getRun(f.run.id), runBefore);
    assert.deepEqual(f.store.getWorkUnitAttempt(f.attempt.id), attemptBefore);
    assert.equal(f.store.countEvents(f.run.id), 0, "no execution event may be appended to the yielded Run");
    assert.equal(f.store.getWorkUnit(f.unit.id).status, "cancelled");
    assert.equal(f.store.getWorkUnit(f.unit.id).endedAt, cancelledAt);
    assert.equal(f.store.getTask(f.task.id).status, "cancelled");
    assert.equal(f.store.getLingTurn(f.turn.turnId).status, "cancelled");
    assert.equal(f.store.getLingThread(f.thread.id).status, "cancelled");
    assert.deepEqual(f.store.listPendingUserInputDeliveries({ threadId: f.thread.id }), []);
    if (answered) {
      assert.equal(f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: {
        schemaVersion: 1, requestId: f.request.requestId, expectedVersion: 1, expectedStatusRevision: 1,
        idempotencyKey: "answer-theme", answers: [{ questionId: "theme", kind: "text", text: "深色" }],
      } }, cancelledAt).answerId, receipt.answerId, "accepted receipt must survive cancellation");
      assert.equal(f.db.prepare("SELECT status FROM user_input_deliveries WHERE delivery_id=?").get(receipt.deliveryId).status, "obsolete");
    } else assert.throws(() => f.submit(), code("stale_request"));
    const replay = cancelWait(f);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.wait, result.wait);
    assert.equal(f.store.listRuntimeEvents(f.unit.id).filter(event => event.type === "work_unit_cancelled").length, 1);
  });
}

test("run-snapshot input wait cancels without inventing a Task", async (t) => {
  const f = await fixture(t, "required", false, false);
  f.yield();
  cancelWait(f);
  assert.equal(f.store.getTask(f.task.id), undefined);
  assert.equal(f.store.getLingTurn(f.turn.turnId).status, "cancelled");
});

test("cancelling one workflow input wait does not cancel an independent participant", async (t) => {
  const f = await fixture(t, "required", true);
  f.yield();
  const sibling = f.store.getChannelWorkflowStep(f.siblingStep.id);
  cancelWait(f);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "cancelled");
  assert.deepEqual(f.store.getChannelWorkflowStep(f.siblingStep.id), sibling);
  assert.notEqual(f.store.getChannelWorkflow(f.workflow.id).status, "succeeded");
});

test("waiting cancellation rejects wrong scope, missing checkpoint and a replaced owner", async (t) => {
  const f = await fixture(t);
  assert.throws(() => cancelWait(f), code("not_found"));
  f.yield();
  assert.throws(() => f.store.cancelUserInputWait({ threadId: "another-thread", sourceRunId: f.run.id }, cancelledAt), code("not_found"));
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "next-runtime", runnerId: "runner_pi_embedded", status: "created", now: cancelledAt });
  const before = f.store.getWorkUnit(f.unit.id);
  assert.throws(() => cancelWait(f), code("source_conflict"));
  assert.deepEqual(f.store.getWorkUnit(f.unit.id), before);
  assert.equal(f.store.getWorkUnitAttempt(successor.id).status, "created");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "waiting");
});

for (const siblingStatus of ["running", "waiting_for_input"]) {
  for (const separateTurn of [false, true]) {
    test(`cancelling a wait preserves sibling ${siblingStatus}: separateTurn=${separateTurn}`, async (t) => {
      const f = await fixture(t);
      f.yield();
      const siblingTurn = separateTurn ? f.store.appendConversationUserTurn({
        threadId: f.thread.id, title: "Independent", userInstruction: "Continue independently", idempotencyKey: "sibling-turn",
        payload: { body: "Continue independently", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      }, committedAt) : f.turn;
      const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
        ownerId: "sibling-run", taskId: "sibling-snapshot", idempotencyKey: "sibling-unit", status: "running",
        createdByActor: "system", request: {}, now: committedAt });
      const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
        runtimeInstanceId: "sibling-runtime", runnerId: "runner_pi_embedded", status: "started", now: committedAt });
      const fence = toRuntimeAttemptFence(attempt);
      const run = f.store.createRun({ id: "sibling-run", cwd: f.cwd, taskId: "sibling-snapshot",
        threadId: f.thread.id, turnId: siblingTurn.turnId, workUnitId: unit.id, providerName: "fixture", providerModel: "fixture",
        taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: committedAt });
      f.store.markRunStarted(run.id, committedAt);
      f.store.linkRunToWorkUnit(run.id, unit.id, committedAt);
      let request;
      if (siblingStatus === "waiting_for_input") {
        request = f.store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: siblingTurn.item.id, sourceFence: fence,
          toolCallId: "sibling-question", idempotencyKey: "sibling-question", toolInput: { schemaVersion: 1, waitMode: "required",
            questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] },
        }, committedAt).request;
        f.store.commitUserInputYield({ threadId: f.thread.id, requestId: request.requestId, expectedRequestVersion: 1,
          sourceFence: fence, quiescence: { kind: "runner_quiesced", runnerId: attempt.runnerId,
            stoppedAt: committedAt, lastRunEventSeq: 0 } }, committedAt);
      }
      const siblingBefore = { run: f.store.getRun(run.id), unit: f.store.getWorkUnit(unit.id),
        attempt: f.store.getWorkUnitAttempt(attempt.id) };
      cancelWait(f);
      assert.deepEqual({ run: f.store.getRun(run.id), unit: f.store.getWorkUnit(unit.id),
        attempt: f.store.getWorkUnitAttempt(attempt.id) }, siblingBefore);
      assert.equal(f.store.getLingTurn(siblingTurn.turnId).status, siblingStatus);
      assert.equal(f.store.getLingTurn(siblingTurn.turnId).completedAt, undefined);
      assert.equal(f.store.getLingThread(f.thread.id).status, siblingStatus);
      assert.equal(f.store.getLingThread(f.thread.id).activeRunId, siblingStatus === "running" ? run.id : undefined);
      if (request) {
        assert.equal(f.store.getUserInputWait(f.thread.id, request.requestId).status, "waiting");
        assert.equal(f.store.getUserInputRequest(f.thread.id, request.requestId).status, "pending");
      }
      assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "cancelled");
    });
  }
}

for (const point of ["request", "delivery", "wait", "logical", "task", "step", "commit"]) {
  test(`waiting cancellation rolls back its full aggregate on ${point} failure`, async (t) => {
    const f = await fixture(t, "required", true);
    if (point !== "request") f.submit();
    f.yield();
    const trigger = point === "request" ? "BEFORE UPDATE ON user_input_requests WHEN NEW.status='cancelled'"
      : point === "delivery" ? "BEFORE UPDATE ON user_input_deliveries WHEN NEW.status='obsolete'"
      : point === "wait" ? "BEFORE UPDATE ON user_input_requests WHEN NEW.wait_status='cancelled'"
      : point === "logical" ? "BEFORE UPDATE ON work_units WHEN NEW.status='cancelled'"
      : point === "task" ? "BEFORE UPDATE ON tasks WHEN NEW.status='cancelled'"
      : point === "step" ? "BEFORE UPDATE ON channel_workflow_steps WHEN NEW.status='cancelled'"
      : "BEFORE INSERT ON control_plane_events WHEN NEW.entity_type='user_input_wait' AND NEW.action='cancelled'";
    if (point === "commit") {
      f.db.exec("CREATE TABLE deferred_cancel_failure (id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED)");
      f.db.exec(`CREATE TRIGGER reject_cancel ${trigger} BEGIN INSERT INTO deferred_cancel_failure VALUES ('missing'); END`);
    } else f.db.exec(`CREATE TRIGGER reject_cancel ${trigger} BEGIN SELECT RAISE(ABORT, 'cancel failure'); END`);
    assert.throws(() => cancelWait(f), /cancel failure|FOREIGN KEY/);
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "waiting");
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).revision, 1);
    assert.equal(f.store.getUserInputRequest(f.thread.id, f.request.requestId).status, point === "request" ? "pending" : "answered");
    assert.equal(f.store.getWorkUnit(f.unit.id).status, "waiting_for_input");
    assert.equal(f.store.getTask(f.task.id).status, "waiting_for_input");
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "waiting_for_input");
    assert.equal(f.store.listRuntimeEvents(f.unit.id).filter(event => event.type === "work_unit_cancelled").length, 0);
    assert.equal(f.store.listPendingUserInputDeliveries({ threadId: f.thread.id }).length, point === "request" ? 0 : 1);
  });
}

test("cancelled wait survives reopen and does not revert to waiting", async (t) => {
  const f = await fixture(t);
  f.yield();
  cancelWait(f);
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  f.store.reconcileLingTurnStatus(f.turn.turnId, cancelledAt);
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "cancelled");
  assert.equal(f.store.getLingTurn(f.turn.turnId).status, "cancelled");
  assert.equal(cancelWait(f).replayed, true);
});

for (const status of ["claimed", "applied"]) {
  test(`waiting cancellation cannot discard an already ${status} answer delivery`, async (t) => {
    const f = await fixture(t);
    const receipt = f.submit();
    f.yield();
    f.db.prepare("UPDATE user_input_deliveries SET status=? WHERE delivery_id=?").run(status, receipt.deliveryId);
    assert.throws(() => cancelWait(f), code("source_conflict"));
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "waiting");
    assert.equal(f.db.prepare("SELECT status FROM user_input_deliveries WHERE delivery_id=?").get(receipt.deliveryId).status, status);
  });
}

test("a delivery for a different consumer cannot be cancelled using this wait", async (t) => {
  const f = await fixture(t);
  const receipt = f.submit();
  f.yield();
  f.db.prepare("UPDATE user_input_deliveries SET consumer_work_unit_id='different-participant' WHERE delivery_id=?").run(receipt.deliveryId);
  assert.throws(() => cancelWait(f), code("source_conflict"));
  assert.equal(f.db.prepare("SELECT status FROM user_input_deliveries WHERE delivery_id=?").get(receipt.deliveryId).status, "pending");
});

test("two connections cancel one logical wait and preserve the first cancellation audit", async (t) => {
  const f = await fixture(t);
  f.submit();
  f.yield();
  const other = createSqliteRunStore(f.cwd);
  try {
    const first = cancelWait(f);
    const second = other.cancelUserInputWait({ threadId: f.thread.id, sourceRunId: f.run.id }, "2026-09-07T00:00:04.000Z");
    assert.equal(second.replayed, true);
    assert.deepEqual(second.wait, first.wait);
    assert.equal(other.getWorkUnit(f.unit.id).endedAt, cancelledAt);
    assert.equal(other.listRuntimeEvents(f.unit.id).filter(event => event.type === "work_unit_cancelled").length, 1);
  } finally { other.close(); }
});

async function fixture(t, waitMode = "required", workflow = false, storedTask = true) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-user-input-wait-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  f.db = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  f.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50");
  t.after(async () => { f.db.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.channel = f.store.createChannel({ name: "Wait fixture", boundPath: cwd }, now);
  if (workflow) {
    f.workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Two branches", objective: "Independent work",
      status: "running", createdBy: "local-user" }, now);
    f.step = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Ask", prompt: "Ask then continue",
      toParticipantId: "ling_agent", toParticipantLabel: "Ling", status: "running" }, now);
    f.siblingStep = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Independent", prompt: "Continue independently",
      toParticipantId: "ling_agent", toParticipantLabel: "Ling", status: "running" }, now);
  }
  f.thread = f.store.createLingThread({ kind: workflow ? "channel_discussion" : "conversation",
    ...(workflow ? { channelId: f.channel.id } : {}), title: "等待测试", objective: "暂停后继续原工作" }, now);
  f.turn = f.store.appendConversationUserTurn({
    ...(workflow ? { channelId: f.channel.id } : {}),
    threadId: f.thread.id, title: "Build", userInstruction: "Build a project", idempotencyKey: "source",
    payload: { body: "Build a project", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, now);
  f.task = storedTask ? f.store.createTask({ channelId: f.channel.id, title: "Wait fixture", prompt: "Ask then continue" }, now)
    : { id: "normal-conversation-task-snapshot" };
  f.unit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "wait-run",
    taskId: f.task.id, idempotencyKey: "wait-unit", status: "running", createdByActor: "system", request: {}, now,
  });
  f.attempt = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 1,
    runtimeInstanceId: "wait-runtime", runnerId: "runner_pi_embedded", status: "started", now });
  f.fence = toRuntimeAttemptFence(f.attempt);
  f.run = f.store.createRun({
    id: "wait-run", cwd, taskId: f.task.id, threadId: f.thread.id, turnId: f.turn.turnId, workUnitId: f.unit.id,
    ...(workflow ? { channelId: f.channel.id, workflowStepId: f.step.id } : {}),
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now });
  f.store.linkRunToWorkUnit(f.run.id, f.unit.id, now);
  if (workflow) f.store.updateChannelWorkflowStep(f.step.id, { runId: f.run.id, taskId: f.task.id }, now);
  if (storedTask) {
    f.store.transitionTaskStatus({ taskId: f.task.id, expectedStatus: "todo", event: "claim", actor: "system", now });
    f.store.transitionTaskStatus({ taskId: f.task.id, expectedStatus: "claimed", event: "start_run", actor: "system", currentRunId: f.run.id, now });
  }
  f.request = f.store.createUserInputRequest({ sourceRunId: f.run.id, sourceItemId: f.turn.item.id, sourceFence: f.fence,
    toolCallId: "ask-theme", idempotencyKey: "ask-theme", toolInput: { schemaVersion: 1, waitMode, questions: [
      { questionId: "theme", prompt: "选择主题", required: true, allowFreeText: true, options: [] },
    ] } }, now).request;
  f.input = { threadId: f.thread.id, requestId: f.request.requestId, expectedRequestVersion: 1, sourceFence: f.fence,
    quiescence: { kind: "runner_quiesced", runnerId: f.attempt.runnerId, stoppedAt, lastRunEventSeq: 0 } };
  f.yield = (override = {}) => f.store.commitUserInputYield({ ...f.input, ...override }, committedAt);
  f.submit = () => f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: {
    schemaVersion: 1, requestId: f.request.requestId, expectedVersion: 1, expectedStatusRevision: 1,
    idempotencyKey: "answer-theme", answers: [{ questionId: "theme", kind: "text", text: "深色" }],
  } }, stoppedAt);
  f.slot = f.store.acquireRuntimeSemaphoreSlot({ ...f.fence, workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "runner", resourceKey: "runner_pi_embedded", limit: 1, ownerType: "work_unit_attempt", ownerId: f.attempt.id,
    acquiredAt: now, expiresAt: "2026-09-07T01:00:00.000Z" });
  assert.ok(f.slot, "fixture owns a real fenced semaphore slot");
  f.leaseInput = { ...f.fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel", resourceKey: f.channel.id,
    ownerType: "work_unit_attempt", ownerId: f.attempt.id, acquiredAt: now, expiresAt: "2026-09-07T01:00:00.000Z" };
  f.lease = f.store.acquireResourceLease(f.leaseInput);
  assert.ok(f.lease, "fixture owns a real fenced resource lease");
  return f;
}

test("yield atomically closes the physical run/attempt but keeps the logical work waiting", async (t) => {
  const f = await fixture(t);
  const result = f.yield();
  assert.equal(result.replayed, false);
  assert.equal(result.wait.status, "waiting");
  assert.equal(result.wait.checkpoint.source.runId, f.run.id);
  assert.equal(f.store.getRun(f.run.id).status, "yielded");
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "yielded");
  assert.equal(f.store.getRun(f.run.id).endedAt, stoppedAt);
  const unit = f.store.getWorkUnit(f.unit.id);
  assert.equal(unit.status, "waiting_for_input");
  assert.equal(unit.activeAttemptId, undefined);
  assert.equal(unit.endedAt, undefined);
  assert.equal(f.store.getTask(f.task.id).status, "waiting_for_input");
  const turn = f.store.getLingTurn(f.turn.turnId);
  assert.equal(turn.status, "waiting_for_input");
  assert.equal(turn.completedAt, undefined);
  assert.equal(turn.activeRunId, undefined);
  assert.equal(f.store.getLingThread(f.thread.id).status, "waiting_for_input");
  assert.equal(f.store.listRuntimeSemaphoreSlots({ workUnitId: f.unit.id, status: "active" }).length, 0);
  assert.equal(f.store.listResourceLeases({ ownerId: f.attempt.id, status: "active" }).length, 0);
  const events = f.store.listRuntimeEvents(f.unit.id, { limit: 100 });
  assert.equal(events.filter((event) => event.type === "work_unit_waiting_for_input").length, 1);
  assert.equal(events.some((event) => event.type === "work_unit_succeeded" || event.type === "work_unit_failed"), false);
});

test("legacy runner aliases are canonicalized when a new wait checkpoint is stored", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE work_unit_attempts SET runner_id='pi' WHERE id=?").run(f.attempt.id);
  f.input.quiescence = { ...f.input.quiescence, runnerId: "pi-coding-agent" };
  const result = f.yield();
  assert.equal(result.wait.checkpoint.quiescence.runnerId, "pi");
  const row = f.db.prepare("SELECT wait_checkpoint_json FROM user_input_requests WHERE request_id=?").get(f.request.requestId);
  assert.equal(JSON.parse(row.wait_checkpoint_json).quiescence.runnerId, "pi");
});

test("equivalent yield retry returns the original checkpoint and never publishes twice", async (t) => {
  const f = await fixture(t);
  const first = f.yield();
  const repeated = f.yield();
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.wait, first.wait);
  assert.equal(f.store.listRuntimeEvents(f.unit.id).filter((event) => event.type === "work_unit_waiting_for_input").length, 1);
  assert.throws(() => f.yield({ quiescence: { ...f.input.quiescence, stoppedAt: committedAt } }), code("wait_conflict"));
});

test("an answer arriving before safe yield stays pending delivery and does not lose the pause", async (t) => {
  const f = await fixture(t);
  const receipt = f.submit();
  f.yield();
  assert.equal(f.store.getUserInputRequest(f.thread.id, f.request.requestId).status, "answered");
  assert.equal(f.store.listPendingUserInputDeliveries({ threadId: f.thread.id })[0].deliveryId, receipt.deliveryId);
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "waiting_for_input");
});

test("yield checks current owner, scope, request version and runner stop identity", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.yield({ threadId: "other-thread" }), code("not_found"));
  assert.throws(() => f.yield({ expectedRequestVersion: 2 }), code("stale_request"));
  assert.throws(() => f.yield({ sourceFence: { ...f.fence, fencingToken: "999" } }), code("source_conflict"));
  assert.throws(() => f.yield({ quiescence: { ...f.input.quiescence, runnerId: "other" } }), code("source_conflict"));
  assert.equal(f.store.getRun(f.run.id).status, "running");
});

test("optional input does not yield the run", async (t) => {
  const f = await fixture(t, "optional");
  assert.throws(() => f.yield(), code("wait_conflict"));
  assert.equal(f.store.getRun(f.run.id).status, "running");
});

test("a cancelled source cannot be moved back to input waiting", async (t) => {
  const f = await fixture(t);
  f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running", event: "cancel", actor: "local-user", now: stoppedAt });
  assert.throws(() => f.yield(), code("source_conflict"));
  assert.equal(f.store.getRun(f.run.id).status, "cancelled");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId), undefined);
});

test("unresolved tool evidence and changed event sequence reject a quiescence claim", async (t) => {
  const f = await fixture(t);
  f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "read-1", toolName: "read", input: { path: "example.txt" } });
  assert.throws(() => f.yield(), code("not_quiescent"));
  assert.throws(() => f.yield({ quiescence: { ...f.input.quiescence, lastRunEventSeq: 1 } }), code("not_quiescent"));
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "started");
});

for (const point of ["run", "attempt", "logical", "event", "commit"]) {
  test(`failure at ${point} rolls back checkpoint, statuses, release and invalidation`, async (t) => {
    const f = await fixture(t);
    const trigger = point === "run" ? "BEFORE UPDATE ON run_sessions WHEN NEW.status='yielded'"
      : point === "attempt" ? "BEFORE UPDATE ON work_unit_attempts WHEN NEW.status='yielded'"
      : point === "logical" ? "BEFORE UPDATE ON work_units WHEN NEW.status='waiting_for_input'"
      : "BEFORE INSERT ON control_plane_events WHEN NEW.entity_type='user_input_wait'";
    if (point === "commit") {
      f.db.exec("CREATE TABLE deferred_wait_failure (id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED)");
      f.db.exec(`CREATE TRIGGER reject_wait ${trigger} BEGIN INSERT INTO deferred_wait_failure VALUES ('missing'); END`);
    } else f.db.exec(`CREATE TRIGGER reject_wait ${trigger} BEGIN SELECT RAISE(ABORT, 'wait failure'); END`);
    assert.throws(() => f.yield(), /wait failure|FOREIGN KEY/);
    assert.equal(f.store.getRun(f.run.id).status, "running");
    assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "started");
    assert.equal(f.store.getWorkUnit(f.unit.id).status, "running");
    assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, f.attempt.id);
    assert.equal(f.store.getTask(f.task.id).status, "running");
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId), undefined);
    assert.equal(f.store.listRuntimeSemaphoreSlots({ workUnitId: f.unit.id, status: "active" }).length, 1);
    assert.equal(f.store.listResourceLeases({ ownerId: f.attempt.id, status: "active" }).length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control_plane_events WHERE entity_type='user_input_wait'").get().n, 0);
  });
}

test("waiting survives reopen and turn reconciliation without becoming complete", async (t) => {
  const f = await fixture(t);
  f.yield();
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  f.store.reconcileLingTurnStatus(f.turn.turnId, committedAt);
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "waiting");
  assert.equal(f.store.getLingTurn(f.turn.turnId).status, "waiting_for_input");
  assert.equal(f.store.getLingTurn(f.turn.turnId).completedAt, undefined);
  assert.equal(f.store.getUserInputWait("other", f.request.requestId), undefined);
});

test("a yielded fence cannot append progress, revive its attempt or reacquire a slot", async (t) => {
  const f = await fixture(t);
  f.yield();
  assert.throws(() => f.store.appendRuntimeEvent({ ...f.fence, type: "work_unit_progress", actor: "runner", data: {}, ts: committedAt }), /Stale/);
  assert.equal(f.store.updateWorkUnitAttemptStatus({ ...f.fence, status: "started", now: committedAt }), undefined);
  assert.equal(f.store.acquireRuntimeSemaphoreSlot({ ...f.fence, workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "runner", resourceKey: "runner_pi_embedded", limit: 1, ownerType: "work_unit_attempt", ownerId: f.attempt.id,
    acquiredAt: committedAt, expiresAt: "2026-09-07T01:00:00.000Z" }), undefined);
});

test("late execution events cannot change SQLite or the event file after yield", async (t) => {
  const f = await fixture(t);
  f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "read-1", toolName: "read", input: {} });
  f.store.appendEvent(f.run.id, "tool_end", { toolCallId: "read-1", toolName: "read", isError: false, output: "ok" });
  f.db.prepare("UPDATE run_events SET ts=? WHERE run_id=?").run(stoppedAt, f.run.id);
  f.yield({ quiescence: { ...f.input.quiescence, lastRunEventSeq: 2 } });
  const path = f.store.getRun(f.run.id).eventLogPath;
  const before = await readFile(path, "utf8");
  for (const [type, data] of [
    ["assistant_text_delta", { text: "late narration" }],
    ["message_end", { role: "assistant", text: "late final" }],
    ["result", { text: "late result" }],
    ["run_cancelled", { reason: "late cancel" }],
    ["run_end", {}],
    ["tool_end", { toolCallId: "late", toolName: "bash", isError: false, output: "late" }],
    ["run_error", { message: "late failure" }],
  ]) assert.throws(() => f.store.appendEvent(f.run.id, type, data), /yielded|closed/i);
  assert.equal(f.store.countEvents(f.run.id), 2);
  assert.equal(await readFile(path, "utf8"), before);
});

test("direct Run setters cannot overwrite yielded or attach a late summary", async (t) => {
  const f = await fixture(t);
  f.yield();
  const original = f.store.getRun(f.run.id);
  f.store.markRunStarted(f.run.id, committedAt);
  f.store.markRunRunning(f.run.id, committedAt);
  f.store.markRunWaitingForApproval(f.run.id, committedAt);
  f.store.markRunSucceeded(f.run.id, committedAt, "late.md");
  f.store.markRunFailed(f.run.id, committedAt, "late failure", "late.md");
  f.store.markRunCancelled(f.run.id, committedAt, "late.md");
  assert.deepEqual(f.store.getRun(f.run.id), original);
});

test("lease admission atomically rejects a yield committed by a second connection before INSERT", async (t) => {
  const f = await fixture(t);
  const second = createSqliteRunStore(f.cwd);
  t.after(() => second.close());
  let interleaved = false;
  const leases = new SqliteResourceLeaseStore({ database: {
    prepare(sql) {
      if (/INSERT INTO resource_leases/.test(sql)) {
        interleaved = true;
        second.commitUserInputYield(f.input, committedAt);
      }
      return f.db.prepare(sql);
    },
  } });
  assert.equal(leases.acquireResourceLease({ ...f.leaseInput, resourceKey: "second-resource" }), undefined);
  assert.equal(interleaved, true);
  assert.equal(f.store.listResourceLeases({ ownerId: f.attempt.id, status: "active" }).length, 0);
});

test("two store connections replay a single immutable yield and publish once", async (t) => {
  const f = await fixture(t);
  const second = createSqliteRunStore(f.cwd);
  t.after(() => second.close());
  const first = f.yield();
  const replay = second.commitUserInputYield(f.input, committedAt);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.wait, first.wait);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control_plane_events WHERE entity_type='user_input_wait'").get().n, 1);
});

test("corrupt checkpoint fails closed both on read and Turn projection", async (t) => {
  const f = await fixture(t);
  f.yield();
  const row = f.db.prepare("SELECT wait_checkpoint_json FROM user_input_requests WHERE request_id=?").get(f.request.requestId);
  const corrupt = JSON.parse(row.wait_checkpoint_json);
  corrupt.source.participantId = "someone-else";
  f.db.prepare("UPDATE user_input_requests SET wait_checkpoint_json=? WHERE request_id=?").run(JSON.stringify(corrupt), f.request.requestId);
  assert.throws(() => f.store.getUserInputWait(f.thread.id, f.request.requestId), code("invalid_record"));
  f.store.reconcileLingTurnStatus(f.turn.turnId, committedAt);
  assert.equal(f.store.getLingTurn(f.turn.turnId).status, "blocked");
  assert.equal(f.store.getLingTurn(f.turn.turnId).completedAt, undefined);
});

test("a yielded trace never reports success or historical progress as live work", async (t) => {
  const f = await fixture(t);
  f.store.appendRuntimeEvent({ ...f.fence, type: "work_unit_progress", actor: "runner", ts: now, data: {} });
  f.yield();
  const trace = projectLingTrace({ workspaceId: DEFAULT_WORKSPACE_ID, subjectKind: "thread", subjectId: f.thread.id,
    runs: [f.store.getRun(f.run.id)], eventsByRunId: {}, runtimeEventsByWorkUnitId: { [f.unit.id]: f.store.listRuntimeEvents(f.unit.id) } });
  assert.equal(trace.trace.status, "waiting_for_input");
  assert.equal(trace.trace.endedAt, undefined);
  assert.equal(trace.spans.find(span => span.kind === "agent_run").status, "yielded");
});

test("one participant waiting does not hide a running sibling or vanish when that sibling finishes", async (t) => {
  const f = await fixture(t);
  const sibling = f.store.createRun({ id: "sibling", cwd: f.cwd, taskId: f.task.id, threadId: f.thread.id, turnId: f.turn.turnId,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: stoppedAt });
  f.store.markRunStarted(sibling.id, stoppedAt);
  f.yield();
  assert.equal(f.store.getLingTurn(f.turn.turnId).status, "running");
  assert.equal(f.store.getLingThread(f.thread.id).activeRunId, sibling.id);
  f.store.markRunSucceeded(sibling.id, committedAt);
  f.store.reconcileLingTurnStatus(f.turn.turnId, committedAt);
  assert.equal(f.store.getLingTurn(f.turn.turnId).status, "waiting_for_input");
  assert.equal(f.store.getLingTurn(f.turn.turnId).completedAt, undefined);
});

test("workflow child yield preserves its binding, releases only its step lease and keeps an independent branch running", async (t) => {
  const f = await fixture(t, "required", true);
  for (const step of [f.step, f.siblingStep]) assert.ok(f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "bound_path", resourceKey: join(f.cwd, step.id), ownerType: "workflow_step", ownerId: step.id,
    acquiredAt: now, expiresAt: "2026-09-07T01:00:00.000Z" }));
  const { wait } = f.yield();
  assert.equal(wait.checkpoint.source.workflowStepId, f.step.id);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "waiting_for_input");
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, f.run.id);
  assert.equal(f.store.getChannelWorkflowStep(f.siblingStep.id).status, "running");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "running");
  assert.equal(f.store.listResourceLeases({ ownerId: f.step.id, status: "active" }).length, 0);
  assert.equal(f.store.listResourceLeases({ ownerId: f.siblingStep.id, status: "active" }).length, 1);
});

for (const separateTurn of [false, true]) {
  test(`startup recovery cannot hide a committed input wait behind a stale sibling: separateTurn=${separateTurn}`, async (t) => {
    const f = await fixture(t);
    f.yield();
    const turn = separateTurn ? f.store.appendConversationUserTurn({ threadId: f.thread.id, title: "Other task",
      userInstruction: "Other task", idempotencyKey: "other", payload: { body: "Other task", format: "markdown",
        mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, committedAt) : f.turn;
    const sibling = f.store.createRun({ id: "crashed-sibling", cwd: f.cwd, taskId: "other-snapshot", threadId: f.thread.id,
      turnId: turn.turnId, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
      requestSnapshot: {}, createdAt: committedAt });
    f.store.markRunStarted(sibling.id, committedAt);
    f.store.updateLingThread(f.thread.id, { status: "running", activeRunId: sibling.id, lastRunId: sibling.id }, committedAt);
    f.store.close();
    f.store = createSqliteRunStore(f.cwd);
    assert.equal(f.store.recoverStaleRuns(cancelledAt), 1);
    assert.equal(f.store.getRun(sibling.id).status, "failed");
    assert.equal(f.store.getRun(f.run.id).status, "yielded");
    assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "waiting");
    assert.equal(f.store.getLingTurn(f.turn.turnId).status, "waiting_for_input");
    assert.equal(f.store.getLingThread(f.thread.id).status, "waiting_for_input");
    assert.equal(f.store.getLingThread(f.thread.id).activeRunId, undefined);
    assert.equal(f.store.recoverStaleRuns(cancelledAt), 0);
  });
}

for (const status of ["succeeded", "failed", "cancelled"]) {
  test(`terminal Thread update preserves input waiting and an independent active run: ${status}`, async (t) => {
    const f = await fixture(t);
    f.yield();
    const sibling = f.store.createRun({ id: "active-sibling", cwd: f.cwd, taskId: "other-snapshot", threadId: f.thread.id,
      turnId: f.turn.turnId, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
      requestSnapshot: {}, createdAt: committedAt });
    f.store.markRunStarted(sibling.id, committedAt);
    f.store.updateLingThread(f.thread.id, { status, activeRunId: null, lastRunId: f.run.id }, cancelledAt);
    assert.equal(f.store.getLingThread(f.thread.id).status, "running");
    assert.equal(f.store.getLingThread(f.thread.id).activeRunId, sibling.id);
    f.store.markRunSucceeded(sibling.id, cancelledAt);
    f.store.updateLingThread(f.thread.id, { status, activeRunId: null, lastRunId: sibling.id }, cancelledAt);
    assert.equal(f.store.getLingThread(f.thread.id).status, "waiting_for_input");
    assert.equal(f.store.getLingThread(f.thread.id).activeRunId, undefined);
  });
}

test("workflow child transition failure rolls the entire yield back", async (t) => {
  const f = await fixture(t, "required", true);
  f.db.exec("CREATE TRIGGER reject_step_wait BEFORE UPDATE ON channel_workflow_steps WHEN NEW.status='waiting_for_input' BEGIN SELECT RAISE(ABORT, 'step wait failure'); END");
  assert.throws(() => f.yield(), /step wait failure/);
  assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "started");
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "running");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId), undefined);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ workUnitId: f.unit.id, status: "active" }).length, 1);
  assert.equal(f.store.listResourceLeases({ ownerId: f.attempt.id, status: "active" }).length, 1);
});

for (const damaged of ["checkpoint", "blocked"]) {
  test(`terminal projection shows blocked rather than inventing a valid wait: ${damaged}`, async (t) => {
    const f = await fixture(t);
    f.yield();
    if (damaged === "checkpoint") f.db.prepare("UPDATE user_input_requests SET wait_checkpoint_json='{}' WHERE request_id=?").run(f.request.requestId);
    else f.db.prepare("UPDATE user_input_requests SET wait_status='blocked' WHERE request_id=?").run(f.request.requestId);
    f.store.updateLingThread(f.thread.id, { status: "succeeded", activeRunId: null, lastRunId: f.run.id }, cancelledAt);
    assert.equal(f.store.getLingThread(f.thread.id).status, "blocked");
    assert.equal(f.store.getLingThread(f.thread.id).activeRunId, undefined);
  });
}

test("a terminal notification cannot unarchive an input-waiting Thread", async (t) => {
  const f = await fixture(t);
  f.yield();
  f.store.updateLingThread(f.thread.id, { status: "archived", archivedAt: cancelledAt }, cancelledAt);
  const before = f.store.getLingThread(f.thread.id);
  f.store.updateLingThread(f.thread.id, { status: "succeeded", lastRunId: f.run.id }, cancelledAt);
  assert.deepEqual(f.store.getLingThread(f.thread.id), before);
});

test("a closed input wait does not override a later terminal Thread update", async (t) => {
  const f = await fixture(t);
  f.yield();
  cancelWait(f);
  f.store.updateLingThread(f.thread.id, { status: "succeeded", activeRunId: null }, cancelledAt);
  assert.equal(f.store.getLingThread(f.thread.id).status, "succeeded");
});

for (const status of ["succeeded", "failed", "cancelled"]) {
  test(`an explicit unarchive is not mistaken for a late terminal notification: ${status}`, async (t) => {
    const f = await fixture(t);
    const thread = f.store.createLingThread({ kind: "conversation", title: "Finished", objective: "Finished", status }, now);
    f.store.updateLingThread(thread.id, { archivedAt: committedAt, archivedReason: "user archived" }, committedAt);
    const restored = f.store.updateLingThread(thread.id, { status, archivedAt: null, archivedReason: null }, cancelledAt);
    assert.equal(restored.status, status);
    assert.equal(restored.archivedAt, undefined);
    assert.equal(restored.archivedReason, undefined);
  });
}

test("terminal projection preserves a sibling awaiting approval", async (t) => {
  const f = await fixture(t);
  f.yield();
  const sibling = f.store.createRun({ id: "approval-sibling", cwd: f.cwd, taskId: "approval-task", threadId: f.thread.id,
    turnId: f.turn.turnId, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
    requestSnapshot: {}, createdAt: committedAt });
  f.store.markRunStarted(sibling.id, committedAt);
  assert.equal(f.store.transitionRunStatus({ runId: sibling.id, expectedStatus: "running", event: "approval_requested",
    actor: "system", now: committedAt }).ok, true);
  f.store.updateLingThread(f.thread.id, { status: "succeeded", activeRunId: null, lastRunId: f.run.id }, cancelledAt);
  assert.equal(f.store.getLingThread(f.thread.id).status, "waiting_for_approval");
  assert.equal(f.store.getLingThread(f.thread.id).activeRunId, sibling.id);
});

test("terminal projection participates in an outer transaction without committing it", async (t) => {
  const f = await fixture(t);
  f.yield();
  const before = f.store.getLingThread(f.thread.id);
  const threads = new SqliteLingThreadStore({ database: f.db }, {
    getUserInputWait: (threadId, requestId) => f.store.getUserInputWait(threadId, requestId),
    rebuildLingThreadMetadata: () => {},
  });
  f.db.exec("BEGIN IMMEDIATE");
  try {
    const pending = threads.updateLingThread(f.thread.id, { title: "Uncommitted", status: "succeeded", lastRunId: f.run.id }, cancelledAt);
    assert.equal(pending.title, "Uncommitted");
    assert.equal(pending.status, "waiting_for_input");
    assert.deepEqual(f.store.getLingThread(f.thread.id), before, "other connections must not see a nested savepoint commit");
  } finally { f.db.exec("ROLLBACK"); }
  assert.deepEqual(f.store.getLingThread(f.thread.id), before);
});

test("terminal projection rolls back metadata and status when savepoint commit fails", async (t) => {
  const f = await fixture(t);
  f.yield();
  const before = f.store.getLingThread(f.thread.id);
  f.db.exec("CREATE TABLE projection_commit_failure (id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec("CREATE TRIGGER reject_projection BEFORE UPDATE ON ling_threads BEGIN INSERT INTO projection_commit_failure VALUES ('missing'); END");
  assert.throws(() => f.store.updateLingThread(f.thread.id, { title: "Must roll back", status: "succeeded", lastRunId: f.run.id }, cancelledAt), /FOREIGN KEY/);
  assert.deepEqual(f.store.getLingThread(f.thread.id), before);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM projection_commit_failure").get().count, 0);
  f.db.exec("DROP TRIGGER reject_projection");
  assert.equal(f.store.updateLingThread(f.thread.id, { status: "succeeded", lastRunId: f.run.id }, cancelledAt).status, "waiting_for_input");
});

test("an infrastructure failure during wait projection is not swallowed as logical blocking", async (t) => {
  const f = await fixture(t);
  f.yield();
  const before = f.store.getLingThread(f.thread.id);
  const readWait = f.store.getUserInputWait.bind(f.store);
  f.store.getUserInputWait = () => { throw new Error("fixture storage unavailable"); };
  try {
    assert.throws(() => f.store.updateLingThread(f.thread.id, { status: "succeeded", title: "Must not write" }, cancelledAt), /fixture storage unavailable/);
    assert.deepEqual(f.store.getLingThread(f.thread.id), before);
  } finally { f.store.getUserInputWait = readWait; }
});

test("a concurrent commit cannot make terminal projection overwrite a newer Thread snapshot", async (t) => {
  const f = await fixture(t);
  f.yield();
  const readWait = f.store.getUserInputWait.bind(f.store);
  let injected = false;
  f.store.getUserInputWait = (threadId, requestId) => {
    const wait = readWait(threadId, requestId);
    if (!injected) {
      injected = true;
      f.db.prepare("UPDATE ling_threads SET title='Other connection committed' WHERE id=?").run(f.thread.id);
    }
    return wait;
  };
  try {
    assert.throws(() => f.store.updateLingThread(f.thread.id, { status: "succeeded", title: "Stale overwrite" }, cancelledAt), /database is locked|busy/i);
  } finally { f.store.getUserInputWait = readWait; }
  assert.equal(injected, true);
  assert.equal(f.store.getLingThread(f.thread.id).title, "Other connection committed");
  assert.equal(f.store.getLingThread(f.thread.id).status, "waiting_for_input");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "waiting");
});

test("closed execution keeps a separate audit channel without changing canonical activity", async (t) => {
  const f = await fixture(t);
  f.yield();
  const unit = f.store.getWorkUnit(f.unit.id);
  const run = f.store.getRun(f.run.id);
  const event = f.store.appendIgnoredRunnerCompletionEvent(f.run.id, { reason: "terminal_state_changed", reportedStatus: "succeeded" });
  assert.equal(event.type, "stale_runner_completion_ignored");
  f.store.appendRuntimeDiagnosticEvent({ ...f.fence, type: "stale_runner_completion_ignored", actor: "runner", ts: committedAt, data: { runEventId: event.id } });
  assert.deepEqual(f.store.getWorkUnit(f.unit.id), unit);
  assert.deepEqual(f.store.getRun(f.run.id), run);
  assert.throws(() => f.store.appendEvent(f.run.id, "result", { text: "not an audit" }), /yielded|closed/i);
});

test("old cleanup and heartbeat cannot touch a newer attempt's resources", async (t) => {
  const f = await fixture(t);
  f.yield();
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "new-runtime", runnerId: "runner_pi_embedded", status: "started", now: committedAt });
  const newFence = toRuntimeAttemptFence(successor);
  assert.ok(f.store.acquireResourceLease({ ...f.leaseInput, ...newFence, ownerId: successor.id }));
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ ...newFence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
    resourceKey: "runner_pi_embedded", limit: 1, ownerType: "work_unit_attempt", ownerId: successor.id,
    acquiredAt: committedAt, expiresAt: "2026-09-07T01:00:00.000Z" }));
  const unit = f.store.getWorkUnit(f.unit.id);
  assert.throws(() => f.store.recordRuntimeHeartbeat({ ...f.fence, ts: committedAt, source: "runner" }), /Stale/);
  assert.equal(f.store.releaseResourceLeasesForAttempt(f.fence, committedAt, "late-finally"), 0);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(f.fence, committedAt, "late-finally"), 0);
  assert.equal(f.store.renewResourceLeasesForAttempt(f.fence, committedAt), 0);
  assert.equal(f.store.renewRuntimeSemaphoreSlotsForAttempt(f.fence, committedAt), 0);
  assert.deepEqual(f.store.getWorkUnit(f.unit.id), unit);
  assert.equal(f.store.listResourceLeases({ ownerId: successor.id, status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: successor.id, status: "active" }).length, 1);
});
