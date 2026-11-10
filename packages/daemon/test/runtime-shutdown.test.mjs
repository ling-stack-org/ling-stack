import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { createSqliteRunStore, projectConversationItemToChannelMessage } from "../../core/dist/index.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { resolveConfig } from "../dist/config.js";
import { ChannelTurnDispatchWorkerRegistry } from "../dist/features/channels/channel-turn-dispatch-worker.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { createDaemonServer } from "../dist/index.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("shutdown latches its first cause and aborts a late registered Run", () => {
  const registry = new ActiveRunRegistry();
  registry.suspendAll("daemon_restart");
  registry.suspendAll("desktop_quit");
  const abortController = new AbortController();
  registry.add("late", { abortController, runtimeInstanceId: "late-runtime", streamEnvelope() {} });
  assert.equal(abortController.signal.aborted, true);
  assert.deepEqual(registry.getStopIntent("late"), {
    kind: "runtime_suspend", cause: "daemon_restart", runtimeInstanceId: "late-runtime",
  });
  registry.delete("late");
});

test("late registration preserves an earlier cancellation intent", () => {
  const registry = new ActiveRunRegistry();
  registry.suspendAll("daemon_restart");
  const abortController = new AbortController();
  const stopIntent = { kind: "user_cancel", actor: "local-user", reason: "cancel" };
  registry.add("cancelled", { abortController, stopIntent, streamEnvelope() {} });
  assert.deepEqual(abortController.signal.reason, stopIntent);
  registry.delete("cancelled");
});

test("idle requires registry removal even if no completion Promise was supplied", async () => {
  const registry = new ActiveRunRegistry();
  registry.add("active", { abortController: new AbortController(), streamEnvelope() {} });
  let idle = false;
  const pending = registry.waitForIdle().then(() => { idle = true; });
  try {
    await nextTick();
    assert.equal(idle, false, "registered work is not an idle receipt");
  } finally {
    registry.delete("active");
    await pending;
  }
});

test("the default drain never turns a two second deadline into idle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const registry = new ActiveRunRegistry();
  const work = deferred();
  registry.trackCompletion(work.promise);
  let idle = false;
  const pending = registry.waitForIdle().then(() => { idle = true; });
  try {
    t.mock.timers.tick(2_001);
    await nextTick();
    assert.equal(idle, false, "a deadline cannot prove that a callback stopped");
  } finally {
    work.resolve();
    await pending;
  }
});

test("an explicitly bounded idle observation rejects without releasing work", async () => {
  const registry = new ActiveRunRegistry();
  const work = deferred();
  registry.trackCompletion(work.promise);
  try {
    await assert.rejects(registry.waitForIdle(0), /not idle/i);
  } finally {
    work.resolve();
    await registry.waitForIdle();
  }
});

test("drain includes work registered by a settling callback and rejects no business failure", async () => {
  const registry = new ActiveRunRegistry();
  const first = deferred();
  const second = deferred();
  const firstCompletion = first.promise.then(() => registry.trackCompletion(second.promise));
  registry.trackCompletion(firstCompletion);
  let idle = false;
  const pending = registry.waitForIdle().then(() => { idle = true; });
  first.resolve();
  await nextTick();
  assert.equal(idle, false);
  second.reject(new Error("business failure, execution stopped"));
  await pending;
  assert.equal(idle, true);
});

test("Run entry is rejected before workspace access when the daemon is shutting down", async () => {
  const registry = new ActiveRunRegistry();
  registry.suspendAll("daemon_restart");
  const errors = [];
  const request = { get cwd() { assert.fail("shutdown must not inspect the workspace"); } };
  const result = await executeRunRequest(request, {
    ...createDetachedRunExecutionSink(), writeError: (status, body) => errors.push({ status, body }),
  }, undefined, undefined, registry, undefined, undefined, undefined);
  assert.equal(result, undefined);
  assert.equal(errors[0]?.status, 503);
  assert.equal(errors[0]?.body.error, "runtime_shutting_down");
  await registry.waitForIdle();
});

test("Run preflight is included in idle before a Run id exists", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-preflight-shutdown-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const registry = new ActiveRunRegistry();
  const tracked = [];
  const track = registry.trackCompletion.bind(registry);
  registry.trackCompletion = completion => { tracked.push(completion); track(completion); };
  const request = { cwd, task: { id: "preflight", title: "preflight", prompt: "preflight" } };
  const sink = createDetachedRunExecutionSink();
  const completion = executeRunRequest(request, sink, undefined, undefined, registry, undefined, undefined, undefined);
  // A queued entry must be tracked before its first microtask, not only at add(runId).
  try {
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0], completion);
  } finally {
    await completion;
  }
  await registry.waitForIdle();
});

test("channel close waits for drain and a settlement produced after shutdown", async (t) => {
  const fixture = await createDispatchFixture(t);
  const handedOff = deferred();
  const settled = deferred();
  const entered = deferred();
  const worker = new ChannelTurnDispatchWorkerRegistry(fixture.supervisor, async () => {
    entered.resolve();
    await handedOff.promise;
    return { result: {}, settled: settled.promise };
  });
  worker.start(fixture.store);
  await entered.promise;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let closed = false;
  const closing = worker.close().then(() => { closed = true; });
  try {
    t.mock.timers.tick(2_001);
    await nextTick();
    assert.equal(closed, false, "close must wait for the active drain");
    handedOff.resolve();
    await nextTick();
    t.mock.timers.tick(2_001);
    await nextTick();
    assert.equal(closed, false, "a newly published settlement must also stop");
  } finally {
    handedOff.resolve();
    settled.resolve();
    await closing;
  }
  assert.equal(fixture.store.getWorkUnit(fixture.accepted.dispatchWorkUnitId).status, "succeeded");
});

test("channel shutdown rejects new dispatch without reading the store", async () => {
  const worker = new ChannelTurnDispatchWorkerRegistry(undefined, async () => ({ result: {} }));
  await worker.close();
  await assert.rejects(Promise.resolve().then(() => worker.dispatchAcceptedTurn({
    get store() { assert.fail("closed dispatcher must not read SQLite"); }, message: {},
  })), /shutting down/i);
});

test("channel shutdown settles queued observers but preserves durable queued work", async (t) => {
  const fixture = await createDispatchFixture(t);
  const worker = new ChannelTurnDispatchWorkerRegistry(fixture.supervisor, async () => {
    assert.fail("shutdown must not execute a queued turn");
  });
  let rejection;
  const pending = worker.dispatchAcceptedTurn({ store: fixture.store,
    message: projectConversationItemToChannelMessage(fixture.accepted.item) }).catch(error => { rejection = error; });
  await worker.close();
  await nextTick();
  assert.match(rejection?.message ?? "unsettled", /shutting down/i);
  await pending;
  assert.equal(fixture.store.getWorkUnit(fixture.accepted.dispatchWorkUnitId).status, "queued");
});

for (const locked of [false, true]) {
test(`shutdown between Run ready and registration never enters the Runner: locked=${locked}`, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-late-run-shutdown-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  if (locked) supervisor.updateLockedTaskContinuation({ desktopInstanceId: "shutdown-fixture",
    leaseTtlMs: 60_000, continueWhileLocked: false, locked: true });
  const active = new ActiveRunRegistry();
  t.after(async () => { supervisor.releaseAll(); stores.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  let calls = 0;
  const runners = createRunnerRegistry([{ id: "runner_pi_embedded", aliases: ["pi"], displayName: "Test",
    status: "enabled", adapter: { async runTask(options) {
      calls += 1;
      return { taskId: options.task.id, events: [], messages: [] };
    } } }]);
  const errors = [];
  const runId = await executeRunRequest(runRequest(cwd), {
    ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body),
  }, runners, stores, active, supervisor, { resolve: () => undefined }, {}, {
    onRunReady: () => active.suspendAll("daemon_restart"),
  });
  assert.deepEqual(errors, []);
  assert.ok(runId);
  await active.waitForIdle();
  assert.equal(calls, 0, "shutdown already won before actual Runner dispatch");
  assert.equal(stores.getStore(cwd).getRun(runId).status, "failed");
});
}

test("real daemon stop keeps SQLite open until slow Runner cleanup actually returns", { timeout: 15_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-daemon-stop-barrier-"));
  const entered = deferred();
  const aborted = deferred();
  const cleanup = deferred();
  let store;
  let storeClosed = false;
  let cleanupReadSucceeded = false;
  let finalStatus;
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, port: 0,
    channels: { intentSelector: false, terminalReports: false } }, {
    runner: { async runTask(options) {
      entered.resolve(options.runId);
      const onAbort = () => aborted.resolve();
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      try {
        await aborted.promise;
        await cleanup.promise;
        cleanupReadSucceeded = !!store.getRun(options.runId);
        throw options.signal.reason;
      } finally { options.signal.removeEventListener("abort", onAbort); }
    } },
    storeFactory: storeCwd => {
      store = createSqliteRunStore(storeCwd);
      const close = store.close.bind(store);
      store.close = () => { finalStatus = store.listRuns({ limit: 1 })[0]?.status; storeClosed = true; close(); };
      return store;
    },
  });
  let closing;
  let response;
  t.after(async () => {
    cleanup.resolve();
    aborted.resolve();
    await response?.body?.cancel().catch(() => undefined);
    await (closing ?? daemon.stop());
    await rm(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const port = daemon.server.address().port;
  response = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(runRequest(cwd)),
  });
  assert.equal(response.status, 200);
  await entered.promise;
  let stopped = false;
  closing = daemon.stop().then(() => { stopped = true; });
  await aborted.promise;
  // Cross the former production deadline with a real daemon and SQLite, not mock time.
  await new Promise(resolve => setTimeout(resolve, 2_100));
  assert.equal(stopped, false);
  assert.equal(storeClosed, false);
  cleanup.resolve();
  await closing;
  assert.equal(cleanupReadSucceeded, true);
  assert.equal(storeClosed, true);
  assert.equal(finalStatus, "failed", "shutdown without a checkpoint is not successful or yielded");
});

function runRequest(cwd) {
  return { cwd, task: { id: "shutdown", title: "shutdown", prompt: "shutdown" },
    provider: { provider: "test-provider", model: "test-model" }, tools: ["read"], thinkingLevel: "off" };
}

async function createDispatchFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-runtime-shutdown-"));
  const store = createSqliteRunStore(cwd);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd, port: 0 }));
  t.after(async () => { supervisor.releaseAll(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "shutdown", boundPath: cwd }, now);
  const { thread } = store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id,
    title: "shutdown", objective: "shutdown" }, now);
  const accepted = store.appendConversationUserTurn({ channelId: channel.id, threadId: thread.id,
    title: "stop", userInstruction: "stop", idempotencyKey: "shutdown",
    payload: { body: "stop", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    dispatch: { schemaVersion: 1, requestAiReply: false } }, now);
  supervisor.getRuntime(cwd, store);
  return { cwd, store, supervisor, accepted };
}
