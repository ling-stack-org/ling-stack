import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, getRunSummaryPath, resolveRuntimePaths,
  toRuntimeAttemptFence } from "../../core/dist/index.js";
import { RunControlService } from "../dist/run-control.js";

const now = "2026-09-07T00:00:00.000Z";
const stoppedAt = "2026-09-07T00:00:01.000Z";
const committedAt = "2026-09-07T00:00:02.000Z";
const expiresAt = "2099-01-01T00:00:00.000Z";

/** Real SQLite wait/lease state; safety and cancellation methods are not stubbed. */
async function fixture(t, answered = false) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-run-control-wait-cancel-"));
  const store = createSqliteRunStore(cwd);
  const db = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50");
  t.after(async () => { db.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Wait cancellation", boundPath: cwd }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Wait", objective: "Answer then continue" }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Work", userInstruction: "Work",
    idempotencyKey: "source", payload: { body: "Work", format: "markdown", mentions: [], attachmentIds: [],
      linkPreviewIds: [], fileRefs: [] } }, now);
  const task = store.createTask({ channelId: channel.id, title: "Wait", prompt: "Ask then continue" }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "waiting-run", taskId: task.id, idempotencyKey: "wait", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "waiting-runtime", runnerId: "runner_pi_embedded", status: "started", now });
  const fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "waiting-run", cwd, taskId: task.id, threadId: thread.id, turnId: turn.turnId,
    workUnitId: unit.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
    requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim", actor: "system", now }).ok, true);
  assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "claimed", event: "start_run", actor: "system",
    currentRunId: run.id, now }).ok, true);
  const leaseInput = { ...fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel", resourceKey: channel.id,
    ownerType: "work_unit_attempt", ownerId: attempt.id, acquiredAt: now, expiresAt };
  assert.ok(store.acquireResourceLease(leaseInput));
  assert.ok(store.acquireRuntimeSemaphoreSlot({ ...fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
    resourceKey: "runner_pi_embedded", limit: 1, ownerType: "work_unit_attempt", ownerId: attempt.id, acquiredAt: now, expiresAt }));
  const request = store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: turn.item.id, sourceFence: fence,
    toolCallId: "question", idempotencyKey: "question", toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "choice", prompt: "请选择", required: true, allowFreeText: true, options: [] },
    ] } }, now).request;
  const submission = { schemaVersion: 1, requestId: request.requestId, expectedVersion: 1, expectedStatusRevision: 1,
    idempotencyKey: "answer", answers: [{ questionId: "choice", kind: "text", text: "继续" }] };
  const submit = () => store.submitUserInputAnswer({ threadId: thread.id, submission }, new Date().toISOString());
  const receipt = answered ? store.submitUserInputAnswer({ threadId: thread.id, submission }, stoppedAt) : undefined;
  store.commitUserInputYield({ threadId: thread.id, requestId: request.requestId, expectedRequestVersion: 1, sourceFence: fence,
    quiescence: { kind: "runner_quiesced", runnerId: attempt.runnerId, stoppedAt, lastRunEventSeq: 0 } }, committedAt);
  assert.equal(store.getRun(run.id).status, "yielded");
  assert.equal(store.getWorkUnit(unit.id).status, "waiting_for_input");
  assert.equal(store.getWorkUnit(unit.id).activeAttemptId, undefined);
  assert.equal(store.listResourceLeases({ ownerId: attempt.id, status: "active" }).length, 0);
  assert.equal(store.listRuntimeSemaphoreSlots({ ownerId: attempt.id, status: "active" }).length, 0);

  // Observe actual delegated release methods, rather than replacing them with
  // inert mocks. A generic old-owner cancellation is detectable independently
  // of whether its resources happen already to have been released by yield.
  let releases = 0, streams = 0;
  for (const method of ["releaseResourceLeasesForAttempt", "releaseRuntimeSemaphoreSlotsForAttempt"]) {
    const original = store[method].bind(store);
    store[method] = (...args) => { releases++; return original(...args); };
  }
  const activeRun = { abortController: new AbortController(), streamEnvelope() { streams++; } };
  const service = new RunControlService();
  const cancel = () => service.cancelRun({ store, runId: run.id, reason: "user_requested", activeRun });
  const summaryPath = getRunSummaryPath(store.paths, run.id);
  return { cwd, store, db, channel, thread, turn, task, unit, attempt, fence, run, request, receipt, submit,
    leaseInput, activeRun, cancel, summaryPath, get releases() { return releases; }, get streams() { return streams; } };
}

function snapshot(f) {
  return { run: f.store.getRun(f.run.id), attempt: f.store.getWorkUnitAttempt(f.attempt.id),
    unit: f.store.getWorkUnit(f.unit.id), task: f.store.getTask(f.task.id), thread: f.store.getLingThread(f.thread.id),
    turn: f.store.getLingTurn(f.turn.turnId), request: f.store.getUserInputRequest(f.thread.id, f.request.requestId),
    wait: f.store.getUserInputWait(f.thread.id, f.request.requestId),
    delivery: f.receipt ? f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId) : undefined,
    runtimeEvents: f.store.listRuntimeEvents(f.unit.id, { limit: 100 }),
    controlEvents: f.db.prepare("SELECT * FROM control_plane_events ORDER BY seq").all() };
}

function assertOldExecutionUntouched(f, before) {
  assert.deepEqual(f.store.getRun(f.run.id), before.run);
  assert.deepEqual(f.store.getWorkUnitAttempt(f.attempt.id), before.attempt);
  assert.equal(f.store.countEvents(f.run.id), 0, "no generic cancel/result event may enter the yielded Run");
  assert.equal(f.releases, 0, "logical wait cancellation must not invoke old/successor execution lease cleanup");
  assert.equal(f.streams, 0);
  assert.equal(f.activeRun.abortController.signal.aborted, false, "a caller-supplied current handle is not the yielded source");
  assert.equal(existsSync(f.summaryPath), false, "logical cancellation must not publish a generic old-run terminal summary");
}

test("RunControlService atomically cancels safe yielded logical waiting without rewriting or aborting execution", async t => {
  const f = await fixture(t);
  const before = snapshot(f);
  assert.equal(existsSync(f.summaryPath), false);
  const result = f.cancel();
  assert.equal(result.cancelled, true);
  assert.equal(result.active, false);
  assert.equal(result.run.status, "yielded");
  assert.equal(result.event, undefined);
  const after = snapshot(f);
  assert.equal(after.request.status, "cancelled");
  assert.equal(after.wait.status, "cancelled");
  assert.equal(after.wait.revision, before.wait.revision + 1);
  assert.equal(after.unit.status, "cancelled");
  assert.ok(after.unit.endedAt);
  assert.equal(after.task.status, "cancelled");
  assert.equal(after.turn.status, "cancelled");
  assert.equal(after.thread.status, "cancelled");
  assertOldExecutionUntouched(f, before);
  assert.equal(after.runtimeEvents.filter(event => event.type === "work_unit_cancelled").length, 1);
  assert.deepEqual(f.store.listDueUserInputDeliveries({ threadId: f.thread.id }, new Date().toISOString()), []);
  assert.throws(f.submit, error => error.code === "stale_request");
  const replay = f.cancel();
  assert.equal(replay.cancelled, true);
  assert.deepEqual(snapshot(f), after, "repeat cancellation preserves the first atomic audit and revisions");
});

test("RunControlService keeps an accepted answer but makes its cancelled continuation unclaimable", async t => {
  const f = await fixture(t, true);
  const before = snapshot(f);
  const answerItem = f.store.getConversationItem(f.receipt.answerItemId);
  assert.ok(answerItem, "the accepted answer must have a persisted canonical item");
  assert.equal(answerItem.kind, "user_input_answer");
  assert.equal(answerItem.payload.answerId, f.receipt.answerId);
  assert.equal(answerItem.payload.requestId, f.request.requestId);
  f.cancel();
  assert.equal(f.store.getUserInputRequest(f.thread.id, f.request.requestId).status, "answered");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "cancelled");
  const delivery = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
  assert.equal(delivery.status, "obsolete");
  assert.equal(delivery.claim, null);
  assert.equal(delivery.successorRunId, null);
  assert.deepEqual(f.store.getConversationItem(f.receipt.answerItemId), answerItem);
  assert.equal(f.submit().answerId, f.receipt.answerId, "receipt replay saves no new answer/continuation");
  assert.deepEqual(f.store.listDueUserInputDeliveries({ threadId: f.thread.id }, new Date().toISOString()), []);
  assert.equal(f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: delivery.deliveryId,
    expectedRevision: delivery.revision, ownerId: "answer-worker", leaseMs: 1000 }, new Date().toISOString()), null);
  assert.equal(f.store.getUserInputContinuationSeed(f.thread.id, delivery.deliveryId), undefined);
  assert.equal(f.store.getUserInputContinuationBinding(f.thread.id, delivery.deliveryId), undefined);
  assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, delivery.deliveryId), undefined);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  assertOldExecutionUntouched(f, before);
});

test("RunControlService rejects a replaced waiting owner and preserves real successor leases and semaphore", async t => {
  const f = await fixture(t);
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor-runtime", runnerId: "runner_pi_embedded", status: "started", now: committedAt });
  const fence = toRuntimeAttemptFence(successor);
  assert.ok(f.store.acquireResourceLease({ ...f.leaseInput, ...fence, ownerId: successor.id, acquiredAt: committedAt }));
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ ...fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
    resourceKey: "runner_pi_embedded", limit: 1, ownerType: "work_unit_attempt", ownerId: successor.id,
    acquiredAt: committedAt, expiresAt }));
  const before = snapshot(f);
  const successorBefore = f.store.getWorkUnitAttempt(successor.id);
  const leasesBefore = f.store.listResourceLeases({ ownerId: successor.id, status: "active" });
  const slotsBefore = f.store.listRuntimeSemaphoreSlots({ ownerId: successor.id, status: "active" });
  assert.throws(f.cancel, error => error.statusCode === 409 && error.code === "run_wait_not_cancellable");
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(f.store.getWorkUnitAttempt(successor.id), successorBefore);
  assert.deepEqual(f.store.listResourceLeases({ ownerId: successor.id, status: "active" }), leasesBefore);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ ownerId: successor.id, status: "active" }), slotsBefore);
  assert.equal(leasesBefore.length, 1);
  assert.equal(slotsBefore.length, 1);
  assertOldExecutionUntouched(f, before);
});

test("RunControlService cancellation rolls back wait, delivery and logical aggregate on real SQLite COMMIT failure", async t => {
  const f = await fixture(t, true);
  const before = snapshot(f);
  f.db.exec("CREATE TABLE deferred_wait_cancel_fault (id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec("CREATE TRIGGER reject_wait_cancel_commit BEFORE INSERT ON control_plane_events"
    + " WHEN NEW.entity_type='user_input_wait' AND NEW.action='cancelled'"
    + " BEGIN INSERT INTO deferred_wait_cancel_fault VALUES ('missing-thread'); END");
  assert.throws(f.cancel, /FOREIGN KEY/);
  assert.deepEqual(snapshot(f), before, "request/delivery/wait/task/turn/thread/audit must all roll back together");
  assert.equal(f.store.listPendingUserInputDeliveries({ threadId: f.thread.id }).length, 1);
  assertOldExecutionUntouched(f, before);
  f.db.exec("DROP TRIGGER reject_wait_cancel_commit");
  assert.equal(f.cancel().cancelled, true, "the same legitimate wait remains cancellable after storage recovers");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "cancelled");
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId).status, "obsolete");
  assertOldExecutionUntouched(f, before);
});
