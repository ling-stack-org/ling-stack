import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, getRunSummaryPath, resolveRuntimePaths,
  toRuntimeAttemptFence } from "../../core/dist/index.js";
import { RunControlService } from "../dist/run-control.js";
import { ensureRunCancelled } from "../dist/features/runs/cancellation.js";
import { handleCancelRunRequest } from "../dist/features/runs/routes.js";
import { handleWorkUnitRoute } from "../dist/runtime/routes.js";
import { DirectReplyControlService, handleTeammateDirectReplyCancel } from "../dist/features/teammates/direct-controls.js";
import { ActiveDirectReplyRegistry } from "../dist/features/teammates/direct-reply-active-registry.js";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { continuationSourceReady } from "../dist/runtime/continuation-source-barrier.js";

const now = "2026-10-15T00:00:00.000Z";
const later = "2026-10-15T00:00:01.000Z";
const expiresAt = "2099-01-01T00:00:00.000Z";

async function fixture(t, kind = "task_run", linked = true) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-p2-stop-fence-"));
  const store = createSqliteRunStore(cwd);
  const registry = new RunStoreRegistry(() => store);
  registry.getStore(cwd);
  const db = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50");
  t.after(async () => { db.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Stop fence", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Stop fence", prompt: "Local controlled execution" }, now);
  const thread = kind === "teammate_direct_reply" ? store.getOrCreateTeammateDirectThread("teammate_builtin_engineer", now) : undefined;
  if (thread) store.createTeammateDirectMessage({ id: "original-run", teammateId: thread.teammateId,
    threadId: thread.id, authorType: "local-user", authorId: "local-user", body: "Original source", status: "ready" }, now);
  const message = thread ? store.createTeammateDirectMessage({ teammateId: thread.teammateId, threadId: thread.id,
    authorType: "ai-teammate", authorId: thread.teammateId, body: "Partial reply", status: "pending" }, now) : undefined;
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind, ownerType: "run",
    teammateId: thread?.teammateId, linkedMessageId: message?.id,
    ownerId: "original-run", taskId: task.id, status: "running", idempotencyKey: "stop-fence", createdByActor: "system",
    request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "original-runtime", runnerId: "runner_pi_embedded", status: "started", now });
  const run = store.createRun({ id: "original-run", cwd, taskId: task.id, workUnitId: unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  if (linked) store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim", actor: "system", now }).ok, true);
  assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "claimed", event: "start_run", actor: "system",
    currentRunId: run.id, now }).ok, true);
  function acquire(owner) {
    const fence = toRuntimeAttemptFence(owner);
    assert.ok(store.acquireResourceLease({ ...fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel",
      resourceKey: channel.id, ownerType: "work_unit_attempt", ownerId: owner.id, acquiredAt: now, expiresAt }));
    assert.ok(store.acquireRuntimeSemaphoreSlot({ ...fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
      resourceKey: "runner_pi_embedded", limit: 1, ownerType: "work_unit_attempt", ownerId: owner.id, acquiredAt: now, expiresAt }));
  }
  acquire(attempt);
  const activeRun = { abortController: new AbortController(), events: [], streamEnvelope(event) { this.events.push(event); } };
  // The callback need not retain a receiver when handed to the real service.
  activeRun.streamEnvelope = event => activeRun.events.push(event);
  const service = new RunControlService();
  return { cwd, store, registry, db, task, thread, message, unit: store.getWorkUnit(unit.id), attempt, run: store.getRun(run.id),
    activeRun, service, acquire };
}

function snapshot(f) {
  return { run: f.store.getRun(f.run.id), unit: f.store.getWorkUnit(f.unit.id), task: f.store.getTask(f.task.id),
    attempts: f.store.listWorkUnitAttempts(f.unit.id), events: f.store.listEvents(f.run.id),
    runtime: f.store.listRuntimeEvents(f.unit.id), approvals: f.store.listApprovalRequests({ runId: f.run.id }),
    leases: f.store.listResourceLeases({ status: "active" }), slots: f.store.listRuntimeSemaphoreSlots({ status: "active" }) };
}

test("a late WorkUnit stop rejects its original Attempt without changing or aborting the successor", async t => {
  const f = await fixture(t);
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor-runtime", runnerId: "runner_pi_embedded", status: "started", now: later });
  f.acquire(successor);
  const before = snapshot(f);
  assert.throws(() => f.service.cancelWorkUnit({ store: f.store, workUnit: f.unit,
    expectedAttemptId: f.attempt.id, expectedRunId: f.run.id, reason: "user_requested", activeRun: f.activeRun }),
  error => error.statusCode === 409 && error.code === "stale_cancellation");
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.activeRun.abortController.signal.aborted, false);
  assert.deepEqual(f.activeRun.events, []);
  assert.equal(existsSync(getRunSummaryPath(f.store.paths, f.run.id)), false);
});

async function httpFixture(t, f, registerExecution = true) {
  const config = resolveConfig({ host: "127.0.0.1", port: 0 });
  const activeRuns = new ActiveRunRegistry();
  let finishExecution;
  const completion = new Promise(resolve => { finishExecution = resolve; });
  const tracker = registerExecution
    ? new AttemptHostOperationTracker({ store: f.store, source: { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) } }) : undefined;
  if (registerExecution) {
    activeRuns.add(f.run.id, { ...f.activeRun, ...toRuntimeAttemptFence(f.attempt), completion });
    activeRuns.registerAttemptExecutors(tracker.executorGroup);
  }
  const supervisor = new RuntimeSupervisor(config);
  const events = new ControlPlaneEventHub();
  const activeDirectReplies = new ActiveDirectReplyRegistry();
  if (f.message) activeDirectReplies.register({ workUnitId: f.unit.id, messageId: f.message.id,
    teammateId: f.thread.teammateId, threadId: f.thread.id, abortController: f.activeRun.abortController });
  const service = new DirectReplyControlService({ activeRuns, activeDirectReplies, runControl: f.service });
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const action = url.pathname.startsWith("/runs/")
      ? handleCancelRunRequest(request, response, config, url, f.registry, activeRuns, f.run.id, ensureRunCancelled)
      : url.pathname.startsWith("/teammate-direct-replies/")
        ? handleTeammateDirectReplyCancel(request, response, config, f.registry, f.unit.id, service)
        : handleWorkUnitRoute(request, response, url, f.registry, activeRuns, supervisor,
          { kind: request.method === "GET" ? "detail" : "cancel", workUnitId: f.unit.id }, ensureRunCancelled, events);
    void action.catch(error => {
      response.writeHead(error.statusCode ?? 500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.code, message: error.message }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    supervisor.releaseAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { activeDirectReplies, activeRuns, tracker, finishExecution,
    getDetail: async () => {
      const response = await fetch(`${base}/work-units/${f.unit.id}?cwd=${encodeURIComponent(f.cwd)}`);
      assert.equal(response.status, 200);
      return response.json();
    }, post: async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}?cwd=${encodeURIComponent(f.cwd)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  } };
}

test("cancellation retains original resources while a captured Host effect is still running", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-running-effect");
  http.tracker.launchHostEffect(operation, () => undefined);
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  const detail = await http.getDetail();
  assert.equal(detail.stopEvidence.attempts[0].localExecution, "draining");
  assert.equal(detail.stopEvidence.attempts[0].effects, "pending");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  // Generic finally/reconciliation cleanup must honor the same durable veto.
  assert.equal(f.store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(f.attempt), new Date().toISOString(), "run-finished"), 0);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(f.attempt), new Date().toISOString(), "run-finished"), 0);
});

test("registered original local lifetime retains resources until durable drain, including reopened TTL cleanup", async t => {
  const f = await fixture(t);
  const source = { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) };
  let finish;
  const completion = f.store.trackHostAttemptCompletion(source, new Promise(resolve => { finish = resolve; }), () => true);
  const http = await httpFixture(t, f, false);
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1,
    "logical cancellation must not release resources while the original Host lifetime is pending");
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  const reopened = createSqliteRunStore(f.cwd);
  t.after(() => reopened.close());
  assert.equal(reopened.expireResourceLeases("2100-01-01T00:00:00.000Z"), 0);
  assert.equal(reopened.expireRuntimeSemaphoreSlots("2100-01-01T00:00:00.000Z"), 0);
  assert.equal(f.store.releaseResourceLeasesForAttempt(source, new Date().toISOString(), "run-finished"), 0);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(source, new Date().toISOString(), "run-finished"), 0);
  finish();
  await completion;
  const at = new Date().toISOString();
  assert.equal(reopened.releaseResourceLeasesForAttempt(source, at, "run-finished"), 1);
  assert.equal(reopened.releaseRuntimeSemaphoreSlotsForAttempt(source, at, "run-finished"), 1);
});

test("registered cancellation with unverified effects retains resources after local drain and restart", async t => {
  const f = await fixture(t);
  const source = { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) };
  let finish;
  const completion = f.store.trackHostAttemptCompletion(source, new Promise(resolve => { finish = resolve; }));
  f.service.cancelWorkUnit({ store: f.store, workUnit: f.unit, activeRun: f.activeRun });
  finish(); await completion;
  const reopened = createSqliteRunStore(f.cwd);
  t.after(() => reopened.close());
  reopened.releaseHostAttemptResources(source, new Date().toISOString());
  assert.equal(reopened.expireResourceLeases("2100-01-01T00:00:00.000Z"), 0);
  assert.equal(reopened.expireRuntimeSemaphoreSlots("2100-01-01T00:00:00.000Z"), 0);
  assert.equal(reopened.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(reopened.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
});

test("TTL cannot release a drained but still-owned nonterminal registered source", async t => {
  const f = await fixture(t);
  const source = { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) };
  await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => true);
  const reopened = createSqliteRunStore(f.cwd);
  t.after(() => reopened.close());
  assert.equal(reopened.expireResourceLeases("2100-01-01T00:00:00.000Z"), 0);
  assert.equal(reopened.expireRuntimeSemaphoreSlots("2100-01-01T00:00:00.000Z"), 0);
  assert.equal(reopened.listResourceLeases({ status: "active" }).length, 1);
});

test("continuation dispatch waits for original local and durable cleanup lifetimes once", async () => {
  const registry = new ActiveRunRegistry();
  const source = { runId: "source", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "token" };
  let finishMain, finishCleanup;
  registry.add(source.runId, { ...source, abortController: new AbortController(), streamEnvelope() {},
    completion: new Promise(resolve => { finishMain = resolve; }) });
  registry.trackAttemptCompletion(source, new Promise(resolve => { finishCleanup = resolve; }));
  let dispatched = 0;
  const callback = () => { dispatched += 1; };
  assert.equal(registry.deferUntilAttemptDrained(source, "guidance", callback), true);
  assert.equal(registry.deferUntilAttemptDrained(source, "guidance", callback), true);
  registry.delete(source.runId); finishMain();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatched, 0);
  finishCleanup(); await registry.waitForIdle(1000);
  assert.equal(dispatched, 1);
  assert.equal(registry.deferUntilAttemptDrained(source, "guidance", callback), false);
});

test("private redirect stays recoverable until original cancellation physically drains", async t => {
  const f = await fixture(t, "teammate_direct_reply");
  const activeRuns = new ActiveRunRegistry(), activeDirectReplies = new ActiveDirectReplyRegistry();
  let finishMain;
  const source = { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) };
  activeRuns.add(f.run.id, { ...f.activeRun, ...source, completion: new Promise(resolve => { finishMain = resolve; }) });
  activeDirectReplies.register({ workUnitId: f.unit.id, messageId: f.message.id,
    teammateId: f.thread.teammateId, threadId: f.thread.id, abortController: f.activeRun.abortController });
  let preparations = 0;
  const service = new DirectReplyControlService({ activeRuns, activeDirectReplies, runControl: f.service,
    providerStartupRefresh: { async refreshBeforeRun() { preparations++; } }, startRun: () => assert.fail("must not start early") });
  const intervention = service.createIntervention({ store: f.store, teammateId: f.thread.teammateId,
    mode: "interrupt_redirect", instruction: "Redirect only when safe.", idempotencyKey: "private-redirect" });
  assert.equal(f.store.getTeammateDirectReplyIntervention(intervention.id).status, "cancelling_source");
  assert.equal(preparations, 0);
  assert.ok(activeDirectReplies.get(f.unit.id), "the owner retires its handle, not logical cancel");
  service.cancelIntervention({ store: f.store, interventionId: intervention.id });
  activeRuns.delete(f.run.id); finishMain(); await activeRuns.waitForIdle(1000);
  assert.equal(f.store.getTeammateDirectReplyIntervention(intervention.id).status, "cancelled");
  assert.equal(preparations, 0);
  assert.equal(f.store.updateTeammateDirectReplyInterventionStatus({ interventionId: intervention.id,
    expectedStatuses: ["queued", "cancelling_source"], status: "starting_continuation", now: later }), undefined);
});

test("private queue dispatch excludes terminal history before applying its limit", async t => {
  const f = await fixture(t, "teammate_direct_reply");
  const source = { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) };
  const completion = f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => true);
  f.service.cancelWorkUnit({ store: f.store, workUnit: f.unit, activeRun: f.activeRun });
  await completion;
  f.store.releaseHostAttemptResources(source, later);
  const input = { teammateId: f.thread.teammateId, threadId: f.thread.id, sourceMessageId: "original-run",
    sourceWorkUnitId: f.unit.id, mode: "queue_followup", instruction: "Next safe instruction", requestedBy: "local-user" };
  for (let index = 0; index < 100; index++) {
    const old = f.store.createTeammateDirectReplyIntervention({ ...input, idempotencyKey: `history-${index}` }, now);
    f.store.cancelTeammateDirectReplyIntervention(old.id, later, "historical-test");
  }
  const next = f.store.createTeammateDirectReplyIntervention({ ...input, idempotencyKey: "new-followup" }, later);
  let preparations = 0;
  const service = new DirectReplyControlService({ activeRuns: new ActiveRunRegistry(),
    activeDirectReplies: new ActiveDirectReplyRegistry(), runControl: f.service,
    providerStartupRefresh: { async refreshBeforeRun() { preparations++; throw new Error("controlled preparation failure"); } },
    startRun: () => assert.fail("the controlled preparation failure must prevent execution") });
  await service.maybeStartNextQueuedContinuation({ store: f.store, teammateId: f.thread.teammateId, threadId: f.thread.id });
  assert.equal(preparations, 1, "terminal history must not hide the pending continuation");
  assert.equal(f.store.getTeammateDirectReplyIntervention(next.id).status, "failed");
});

test("private queued guidance cannot adopt a successor Attempt of the same WorkUnit", async t => {
  const f = await fixture(t, "teammate_direct_reply");
  const intervention = f.store.createTeammateDirectReplyIntervention({ teammateId: f.thread.teammateId,
    threadId: f.thread.id, sourceMessageId: "original-run", sourceWorkUnitId: f.unit.id, mode: "queue_followup",
    instruction: "Original source only", idempotencyKey: "original-fence" }, now);
  assert.equal(intervention.sourceAttemptId, f.attempt.id);
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor-runtime", runnerId: "runner_pi_embedded", status: "started", now: later });
  f.acquire(successor);
  f.store.database.prepare("UPDATE work_units SET status='failed' WHERE id=?").run(f.unit.id);
  const before = snapshot(f);
  const service = new DirectReplyControlService({ activeRuns: new ActiveRunRegistry(),
    activeDirectReplies: new ActiveDirectReplyRegistry(), runControl: f.service,
    startRun: () => assert.fail("a stale queue cannot dispatch a new execution") });
  await service.maybeStartNextQueuedContinuation({ store: f.store, teammateId: f.thread.teammateId, threadId: f.thread.id });
  assert.equal(f.store.getTeammateDirectReplyIntervention(intervention.id).failureReason, "continuation_source_attempt_changed");
  assert.deepEqual(snapshot(f), before);
});

test("private cancellation cannot retire a claimed continuation and admit another dispatcher", async t => {
  const f = await fixture(t, "teammate_direct_reply");
  const input = { teammateId: f.thread.teammateId, threadId: f.thread.id, sourceMessageId: "original-run",
    sourceWorkUnitId: f.unit.id, mode: "queue_followup", instruction: "Owned continuation" };
  const first = f.store.createTeammateDirectReplyIntervention({ ...input, idempotencyKey: "claimed-first" }, now);
  const second = f.store.createTeammateDirectReplyIntervention({ ...input, idempotencyKey: "queued-second" }, later);
  f.store.updateTeammateDirectReplyInterventionStatus({ interventionId: first.id, expectedStatuses: ["queued"],
    status: "starting_continuation", now });
  assert.equal(f.store.cancelTeammateDirectReplyIntervention(first.id, later).status, "starting_continuation");
  assert.equal(f.store.updateTeammateDirectReplyInterventionStatus({ interventionId: second.id,
    expectedStatuses: ["queued"], status: "starting_continuation", now: later }), undefined);
});

test("completed registry observers retire only after durable cleanup and deferred callbacks", async () => {
  const registry = new ActiveRunRegistry();
  const source = { runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "1" };
  let finish;
  registry.add(source.runId, { ...source, abortController: new AbortController(), streamEnvelope() {},
    completion: new Promise(resolve => { finish = resolve; }) });
  let dispatched = 0;
  registry.deferUntilAttemptDrained(source, "retirement", () => { dispatched++; });
  registry.retireDurablyDrainedAttempt(source);
  assert.equal(registry.observeAttemptStop(source).localExecution, "draining");
  registry.delete(source.runId); finish(); await registry.waitForIdle(1000);
  assert.equal(dispatched, 1);
  assert.equal(registry.observeAttemptStop(source).localExecution, "unverified", "only durable storage now owns the completed fact");
});

test("continuation source requires drained cancellation evidence, original resources and a linked Run", async t => {
  const f = await fixture(t);
  const source = { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) };
  const completion = f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => true);
  f.service.cancelWorkUnit({ store: f.store, workUnit: f.unit, activeRun: f.activeRun });
  const registry = new ActiveRunRegistry(), retry = () => assert.fail("no live lifetime to defer");
  assert.equal(continuationSourceReady(f.store, f.store.getWorkUnit(f.unit.id), registry, "test", retry), false);
  await completion;
  assert.equal(continuationSourceReady(f.store, f.store.getWorkUnit(f.unit.id), registry, "test", retry), false);
  f.store.releaseHostAttemptResources(source, new Date().toISOString());
  assert.equal(continuationSourceReady(f.store, f.store.getWorkUnit(f.unit.id), registry, "test", retry), true);
  assert.equal(continuationSourceReady(f.store, { ...f.unit, linkedRunId: undefined }, registry, "test", retry), false);
});

test("lease and semaphore expiry cannot bypass a cancelled original Host effect after reopening the store", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-unknown-effect");
  http.tracker.launchHostEffect(operation, () => undefined);
  http.tracker.markUnknown(operation, "controlled_receipt_loss");
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  const reopened = createSqliteRunStore(f.cwd);
  t.after(() => reopened.close());
  const expiredAt = "2100-01-01T00:00:00.000Z";
  assert.equal(reopened.expireResourceLeases(expiredAt), 0, "elapsed TTL cannot clear a durable unknown effect");
  assert.equal(reopened.expireRuntimeSemaphoreSlots(expiredAt), 0);
  assert.equal(reopened.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(reopened.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
});

test("an independently verified no-start operation does not retain cancellation resources", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-no-start");
  http.tracker.settleNoStart(operation);
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
});

test("the original never-launched Host operation can record no-start after cancellation without reopening execution", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-cancel-before-launch");
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  assert.throws(() => http.tracker.launchHostEffect(operation, () => assert.fail("cancelled effect must not launch")));
  assert.equal(http.tracker.settleNoStart(operation).phase, "safe");
  assert.throws(() => http.tracker.beginHostCall("plugin", "cancelled-new-operation"));
  http.activeRuns.delete(f.run.id);
  http.finishExecution();
  const detail = await http.getDetail();
  assert.equal(detail.workUnit.status, "cancelled");
  assert.equal(detail.stopEvidence.attempts[0].localExecution, "drained");
  assert.equal(detail.stopEvidence.attempts[0].effects, "unverified",
    "a settled enrolled operation does not prove the whole SDK/Host effect inventory");
  const releasedAt = new Date().toISOString();
  assert.equal(f.store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(f.attempt), releasedAt, "run-finished"), 1);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(f.attempt), releasedAt, "run-finished"), 1);
});

for (const outcome of ["launched", "unknown"]) {
test(`a cancelled ${outcome} Host effect cannot be relabelled as no-start`, async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", `controlled-${outcome}-not-no-start`);
  http.tracker.launchHostEffect(operation, () => undefined);
  if (outcome === "unknown") http.tracker.markUnknown(operation, "controlled_receipt_loss");
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  assert.throws(() => http.tracker.settleNoStart(operation));
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  assert.equal((await http.getDetail()).stopEvidence.attempts[0].effects, outcome === "unknown" ? "unknown" : "pending");
});
}

test("a cancelled original no-start ticket cannot borrow a successor's ownership", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-no-start-before-successor");
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor-runtime", runnerId: "runner_pi_embedded", status: "started", now: later });
  const before = snapshot(f);
  assert.throws(() => http.tracker.settleNoStart(operation), error => error.code === "host_operation_stale_owner");
  assert.deepEqual(snapshot(f), before);
});

test("a failed cancelled no-start write retains resources and supports an exact original retry", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-no-start-write-failure");
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  f.db.exec("CREATE TRIGGER reject_no_start BEFORE UPDATE OF phase ON host_operations"
    + " WHEN NEW.phase='safe' BEGIN SELECT RAISE(ABORT, 'controlled_no_start_write_failure'); END");
  assert.throws(() => http.tracker.settleNoStart(operation), /controlled_no_start_write_failure/);
  assert.equal((await http.getDetail()).stopEvidence.attempts[0].effects, "pending");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  f.db.exec("DROP TRIGGER reject_no_start");
  assert.equal(http.tracker.settleNoStart(operation).phase, "safe");
});

test("a second SQLite writer cannot race cancelled no-start validation with changed source linkage", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-no-start-concurrent-writer");
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  f.store.database.exec("PRAGMA busy_timeout=1");
  f.db.exec("BEGIN IMMEDIATE");
  try {
    f.db.prepare("UPDATE work_units SET linked_run_id=NULL WHERE id=?").run(f.unit.id);
    assert.throws(() => http.tracker.settleNoStart(operation), error => error.errcode === 5);
  } finally {
    f.db.exec("COMMIT");
  }
  assert.throws(() => http.tracker.settleNoStart(operation), error => error.code === "host_operation_stale_owner");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
});

test("a cancelled effect's resource veto does not stop independent resource expiry", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-pending");
  http.tracker.launchHostEffect(operation, () => undefined);
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "independent-run", status: "running", idempotencyKey: "independent", createdByActor: "system", request: {}, now });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "independent-runtime", runnerId: "runner_pi_embedded", status: "started", now });
  const fence = toRuntimeAttemptFence(attempt);
  assert.ok(f.store.acquireResourceLease({ ...fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel",
    resourceKey: "independent", ownerType: "work_unit_attempt", ownerId: attempt.id, acquiredAt: now, expiresAt }));
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ ...fence, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
    resourceKey: "independent", limit: 1, ownerType: "work_unit_attempt", ownerId: attempt.id, acquiredAt: now, expiresAt }));
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "succeeded", now: later, endedAt: later }),
    "independent expiry requires positive terminal ownership evidence");
  const expiredAt = "2100-01-01T00:00:00.000Z";
  assert.equal(f.store.expireResourceLeases(expiredAt), 1);
  assert.equal(f.store.expireRuntimeSemaphoreSlots(expiredAt), 1);
  assert.deepEqual(f.store.listResourceLeases({ status: "active" }).map(item => item.attemptId), [f.attempt.id]);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ status: "active" }).map(item => item.attemptId), [f.attempt.id]);
});

test("WorkUnit detail does not equate logical cancellation with captured execution drain", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const response = await http.post(`/work-units/${f.unit.id}/cancel`, {
    expectedAttemptId: f.attempt.id, expectedRunId: f.run.id,
  });
  assert.equal(response.status, 200);
  const pending = await http.getDetail();
  assert.equal(pending.workUnit.status, "cancelled");
  assert.equal(pending.leases.some(lease => lease.status === "active"), false);
  assert.equal(pending.stopEvidence?.attempts[0]?.localExecution, "draining",
    "an accepted cancellation and released leases cannot prove callback drain");
  http.activeRuns.delete(f.run.id);
  assert.equal((await http.getDetail()).stopEvidence.attempts[0].localExecution, "draining",
    "registry removal is not completion of the captured Promise");
  http.finishExecution();
  const settled = await http.getDetail();
  assert.equal(settled.stopEvidence.attempts[0].localExecution, "drained");
  assert.equal(settled.stopEvidence.attempts[0].effects, "unverified",
    "the captured callback has no durable SDK/Host inventory receipt");
  assert.equal(settled.stopEvidence.attempts[0].attemptId, f.attempt.id);
  assert.equal(settled.stopEvidence.attempts[0].fencingToken, f.attempt.fencingToken);
});

for (const outcome of ["pending", "unknown", "settled"]) test(`WorkUnit stop preserves ${outcome} Host operation evidence after callback drain`, async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "controlled-plugin-effect");
  if (outcome === "unknown") {
    http.tracker.launchHostEffect(operation, () => undefined);
    http.tracker.markUnknown(operation, "controlled_receipt_loss");
  } else if (outcome === "settled") http.tracker.settleNoStart(operation);
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  http.activeRuns.delete(f.run.id);
  http.finishExecution();
  const detail = await http.getDetail();
  assert.equal(detail.stopEvidence.attempts[0].localExecution, "drained");
  assert.equal(detail.stopEvidence.attempts[0].effects, outcome === "settled" ? "unverified" : outcome,
    "known operation blockers veto completion, but their absence cannot certify untracked effects");
  if (outcome === "settled") assert.equal(f.store.listHostOperationBlockers({
    runId: f.run.id, ...toRuntimeAttemptFence(f.attempt),
  }).length, 0);
});

test("a late captured callback stays pending after the Run entry and main completion end", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  let finishWriter;
  const writer = new Promise(resolve => { finishWriter = resolve; });
  http.activeRuns.trackAttemptCompletion({ runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) }, writer);
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  http.activeRuns.delete(f.run.id);
  http.finishExecution();
  assert.equal((await http.getDetail()).stopEvidence.attempts[0].localExecution, "draining");
  finishWriter();
  assert.equal((await http.getDetail()).stopEvidence.attempts[0].localExecution, "drained");
});

test("Daemon restart cannot manufacture callback or Host evidence from terminal storage", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  http.activeRuns.delete(f.run.id);
  http.finishExecution();
  assert.equal((await http.getDetail()).stopEvidence.attempts[0].effects, "unverified",
    "an empty live executor group cannot manufacture a durable coverage receipt");
  const restarted = await httpFixture(t, f, false);
  const detail = await restarted.getDetail();
  assert.equal(detail.workUnit.status, "cancelled");
  assert.equal(detail.stopEvidence.attempts[0].localExecution, "unverified");
  assert.equal(detail.stopEvidence.attempts[0].effects, "unverified");
});

test("a stop-unconfirmed command vetoes an otherwise empty Host group before and after restart", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const command = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: toRuntimeAttemptFence(f.attempt),
    cwd: f.cwd, toolCallId: "uncertain-command", command: { kind: "shell", command: "controlled-command" } });
  f.store.settleHostCommandExecution(command, { kind: "observed", observation: {
    scope: "process_group", leaderExited: true, stdioClosed: true, descendants: "unverified",
    settledBy: "cleanup_deadline", stopReason: "cancelled", signalFailures: [],
  } });
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  http.activeRuns.delete(f.run.id);
  http.finishExecution();
  const detail = await http.getDetail();
  assert.equal(detail.stopEvidence.attempts[0].localExecution, "drained");
  assert.equal(detail.stopEvidence.attempts[0].effects, "unknown");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  const restarted = await httpFixture(t, f, false);
  assert.equal((await restarted.getDetail()).stopEvidence.attempts[0].effects, "unknown");
});

test("failed durable unknown recording cannot downgrade the original Host uncertainty to pending", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const operation = http.tracker.beginHostCall("plugin", "unknown-write-fault");
  http.tracker.launchHostEffect(operation, () => undefined);
  f.db.exec("CREATE TRIGGER reject_unknown_evidence BEFORE UPDATE OF phase ON host_operations"
    + " WHEN NEW.phase='unknown_outcome' BEGIN SELECT RAISE(ABORT, 'controlled_unknown_write_failure'); END");
  assert.throws(() => http.tracker.markUnknown(operation, "lost_receipt"));
  assert.equal((await http.post(`/work-units/${f.unit.id}/cancel`)).status, 200);
  http.activeRuns.delete(f.run.id);
  http.finishExecution();
  assert.equal((await http.getDetail()).stopEvidence.attempts[0].effects, "unknown");
});

for (const surface of ["run", "work_unit", "private"]) {
  test(`${surface} HTTP rejects a stale original Attempt and preserves the replacement and private message`, async t => {
    const f = await fixture(t, surface === "private" ? "teammate_direct_reply" : "task_run");
    const http = await httpFixture(t, f);
    const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
      runtimeInstanceId: "successor-runtime", runnerId: "runner_pi_embedded", status: "started", now: later });
    f.acquire(successor);
    const before = snapshot(f);
    const messageBefore = f.message ? f.store.getTeammateDirectMessage(f.message.id) : undefined;
    const path = surface === "run" ? `/runs/${f.run.id}/cancel`
      : surface === "private" ? `/teammate-direct-replies/${f.unit.id}/cancel` : `/work-units/${f.unit.id}/cancel`;
    const result = await http.post(path, { expectedAttemptId: f.attempt.id, expectedRunId: f.run.id });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "stale_cancellation");
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.activeRun.abortController.signal.aborted, false);
    assert.deepEqual(f.activeRun.events, []);
    if (f.message) {
      assert.deepEqual(f.store.getTeammateDirectMessage(f.message.id), messageBefore);
      assert.ok(http.activeDirectReplies.get(f.unit.id));
    }
    const rejected = await http.post(path, { expectedAttemptId: "" });
    assert.equal(rejected.status, 400);
    assert.deepEqual(snapshot(f), before);
    const wrongRun = await http.post(path, { expectedAttemptId: successor.id, expectedRunId: "another-run" });
    assert.equal(wrongRun.status, 409);
    assert.equal(wrongRun.body.error, "stale_cancellation");
    assert.deepEqual(snapshot(f), before);
  });

  test(`${surface} HTTP retains legacy empty-body cancellation`, async t => {
    const f = await fixture(t, surface === "private" ? "teammate_direct_reply" : "task_run");
    const http = await httpFixture(t, f);
    const path = surface === "run" ? `/runs/${f.run.id}/cancel`
      : surface === "private" ? `/teammate-direct-replies/${f.unit.id}/cancel` : `/work-units/${f.unit.id}/cancel`;
    const result = await http.post(path);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.store.getRun(f.run.id).status, "cancelled");
    assert.equal(f.store.getWorkUnit(f.unit.id).status, "cancelled");
    assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
    assert.equal(f.activeRun.abortController.signal.aborted, true);
  });
}

test("a standalone WorkUnit stop cannot reconcile or release a successor and can stop the current owner", async t => {
  const f = await fixture(t, "task_run", false);
  const http = await httpFixture(t, f);
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "standalone-successor", runnerId: "runner_pi_embedded", status: "started", now: later });
  f.acquire(successor);
  const before = snapshot(f);
  const path = `/work-units/${f.unit.id}/cancel`;
  const rejected = await http.post(path, { expectedAttemptId: f.attempt.id, expectedRunId: null });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, "stale_cancellation");
  assert.deepEqual(snapshot(f), before);
  const accepted = await http.post(path, { expectedAttemptId: successor.id, expectedRunId: null });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "cancelled");
  assert.equal(f.store.getWorkUnitAttempt(successor.id).status, "cancelled");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
  assert.deepEqual(f.store.getRun(f.run.id), before.run);
});

test("a current stop atomically cancels its Run and Attempt, releases only its resources, and is idempotent", async t => {
  const f = await fixture(t);
  const result = f.service.cancelWorkUnit({ store: f.store, workUnit: f.unit, reason: "user_requested", activeRun: f.activeRun });
  assert.equal(result.run.status, "cancelled");
  assert.equal(result.workUnit.status, "cancelled");
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "cancelled");
  assert.equal(f.store.getTask(f.task.id).status, "cancelled");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
  assert.equal(f.activeRun.abortController.signal.aborted, true);
  assert.deepEqual(f.activeRun.events.map(event => event.type), ["run_cancelled"]);
  assert.equal(JSON.parse(readFileSync(getRunSummaryPath(f.store.paths, f.run.id), "utf8")).status, "cancelled");
  const before = snapshot(f);
  f.service.cancelWorkUnit({ store: f.store, workUnit: f.unit, reason: "duplicate", activeRun: f.activeRun });
  assert.deepEqual(snapshot(f), before);
});

test("Run cancellation COMMIT failure leaves no terminal state, resource release, event file, summary or abort", async t => {
  const f = await fixture(t);
  f.store.createApprovalRequest({ runId: f.run.id, taskId: f.task.id, actionType: "bash", risk: "medium",
    title: "Controlled approval", description: "whois example.com", payload: {
      type: "bash", cwd: f.cwd, command: "whois example.com", riskFlags: [] } }, now);
  const before = snapshot(f);
  const logBefore = existsSync(f.run.eventLogPath) ? readFileSync(f.run.eventLogPath, "utf8") : "";
  f.db.exec("CREATE TABLE deferred_stop_fault (id TEXT REFERENCES run_sessions(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec("CREATE TRIGGER reject_stop_commit AFTER UPDATE ON run_sessions WHEN NEW.status='cancelled'"
    + " BEGIN INSERT INTO deferred_stop_fault VALUES ('missing-run'); END");
  assert.throws(() => ensureRunCancelled({ store: f.store, runId: f.run.id, taskId: f.task.id, reason: "user_requested",
    expectedAttemptId: f.attempt.id, active: true, streamEnvelope: f.activeRun.streamEnvelope }), /FOREIGN KEY/);
  assert.deepEqual(snapshot(f), before);
  assert.equal(existsSync(f.run.eventLogPath) ? readFileSync(f.run.eventLogPath, "utf8") : "", logBefore);
  assert.equal(existsSync(getRunSummaryPath(f.store.paths, f.run.id)), false);
  assert.equal(f.activeRun.abortController.signal.aborted, false);
  assert.deepEqual(f.activeRun.events, []);
  f.db.exec("DROP TRIGGER reject_stop_commit");
  assert.equal(f.service.cancelRun({ store: f.store, runId: f.run.id, reason: "retry", activeRun: f.activeRun }).cancelled, true);
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "cancelled");
});

test("cancelling an older execution cannot cancel a task now owned by another Run", async t => {
  const f = await fixture(t);
  f.store.createRun({ id: "new-task-owner", cwd: f.cwd, taskId: f.task.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: later });
  f.store.markRunStarted("new-task-owner", later);
  f.store.updateTask(f.task.id, { currentRunId: "new-task-owner" }, later);
  const task = f.store.getTask(f.task.id);
  const successor = f.store.getRun("new-task-owner");
  const result = f.service.cancelRun({ store: f.store, runId: f.run.id, reason: "user_requested", activeRun: f.activeRun });
  assert.equal(result.run.status, "cancelled");
  assert.deepEqual(f.store.getTask(f.task.id), task);
  assert.deepEqual(f.store.getRun("new-task-owner"), successor);
});

test("restart reads original durable local completion without certifying untracked effects", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f, false);
  const source = { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) };
  let finish;
  const completion = f.store.trackHostAttemptCompletion(source, new Promise(resolve => { finish = resolve; }));
  const before = (await http.getDetail()).stopEvidence.attempts[0];
  assert.equal(before.localExecution, "unverified");
  finish();
  await completion;
  const after = (await http.getDetail()).stopEvidence.attempts[0];
  assert.equal(after.localExecution, "drained");
  assert.equal(after.effects, "unverified", "local completion cannot manufacture whole-effect proof");
});

test("live draining and unknown Host effects veto a durable local completion", async t => {
  const f = await fixture(t);
  const http = await httpFixture(t, f);
  const source = { runId: f.run.id, ...toRuntimeAttemptFence(f.attempt) };
  await f.store.trackHostAttemptCompletion(source, Promise.resolve());
  const operation = http.tracker.beginHostCall("plugin", "uncertain-remote");
  http.tracker.launchHostEffect(operation, () => undefined);
  http.tracker.markUnknown(operation, "remote_stop_unconfirmed");
  const after = (await http.getDetail()).stopEvidence.attempts[0];
  assert.equal(after.localExecution, "draining");
  assert.equal(after.effects, "unknown");
  http.finishExecution();
});
