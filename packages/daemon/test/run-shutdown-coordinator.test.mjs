import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunShutdownCoordinator } from "../dist/runtime/run-shutdown-coordinator.js";
import { runSuspensionOrderFor } from "../dist/runtime/run-suspension-order.js";
import { MediaLocalExecutionRegistry } from "../dist/runtime/media-local-executions.js";
import { AttemptLocalWriterGroup } from "../dist/runtime/attempt-local-writers.js";
import { createDelegatedTerminalHandoff } from "../dist/runtime/delegated-terminal-handoff.js";

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function source(id) { return { runId: id, workUnitId: `unit-${id}`, attemptId: `attempt-${id}`,
  runtimeInstanceId: "runtime", fencingToken: `fence-${id}` }; }
function add(active, id, changes = {}) {
  const completion = deferred(), abortController = new AbortController();
  active.add(id, { ...source(id), abortController, streamEnvelope() {}, completion: completion.promise, ...changes });
  return { abortController, finish() { active.delete(id); completion.resolve(); } };
}
function fixture(overrides = {}) {
  const activeRuns = new ActiveRunRegistry(), calls = [];
  const delegations = { stopAdmission() { calls.push("stop"); }, async settle() { calls.push("settle"); }, ...overrides };
  return { activeRuns, calls, coordinator: createRunShutdownCoordinator({ activeRuns, delegations }) };
}

test("shared shutdown closes admission and requests sources synchronously, without abort", async () => {
  const f = fixture(); let requests = 0, reentry;
  const run = add(f.activeRuns, "root", { requestGracefulSuspension() {
    requests++; reentry = f.coordinator.shutdown("desktop_quit");
  } });
  const work = f.coordinator.shutdown("daemon_restart");
  assert.equal(f.activeRuns.isShuttingDown(), true, "no microtask dispatch gap after shutdown returns");
  assert.equal(requests, 1); assert.equal(reentry, work);
  assert.equal(f.coordinator.shutdown("process_signal"), work);
  assert.equal(run.abortController.signal.aborted, false);
  run.finish(); await work;
  assert.deepEqual(f.calls, ["stop", "settle"]);
});

test("explicit non-resumable executors stop but still own their actual drain lifetime", async () => {
  const f = fixture(); const run = add(f.activeRuns, "native", { runtimeShutdownPolicy: "stop_without_resume" });
  let stopped = false; const work = f.coordinator.shutdown("desktop_quit").then(() => { stopped = true; });
  await nextTick();
  assert.equal(run.abortController.signal.aborted, true);
  assert.equal(f.activeRuns.getStopIntent("native").kind, "runtime_suspend");
  assert.equal(stopped, false);
  run.finish(); await work;
});

test("already cancelled non-resumable execution keeps its stop reason and original drain barrier", async () => {
  const f = fixture();
  const run = add(f.activeRuns, "native", { runtimeShutdownPolicy: "stop_without_resume",
    requestGracefulSuspension() { assert.fail("a non-resumable execution must not be checkpointed"); } });
  const intent = { kind: "user_cancel", actor: "local-user", reason: "cancel before desktop quit" };
  f.activeRuns.requestStop("native", intent);
  let stopped = false;
  const work = f.coordinator.shutdown("desktop_quit").then(() => { stopped = true; });
  const result = work.then(() => undefined, error => error);
  try {
    await nextTick();
    assert.equal(stopped, false, "abort is not the original executor's drain receipt");
    assert.deepEqual(run.abortController.signal.reason, intent);
    assert.deepEqual(f.activeRuns.getStopIntent("native"), intent);
  } finally { run.finish(); }
  assert.equal(await result, undefined);
  assert.equal(stopped, true);
});

test("non-resumable policy cannot bypass a supplied forged terminal handoff", async () => {
  const f = fixture();
  const run = add(f.activeRuns, "child", { runtimeShutdownPolicy: "stop_without_resume", terminalHandoff: {} });
  f.activeRuns.requestStop("child", { kind: "workflow_cancel", workflowId: "workflow", reason: "stop child" });
  const result = assert.rejects(f.coordinator.shutdown("desktop_quit"), AggregateError);
  run.finish(); await result;
});

test("idle is not a stopped receipt: durable finalization still owns the barrier", async () => {
  const f = fixture(); const order = runSuspensionOrderFor(f.activeRuns);
  const run = add(f.activeRuns, "root", { requestGracefulSuspension() {} });
  const store = { getRun: id => ({ id, taskId: `task-${id}` }) };
  const handle = order.capture(store, source("root"));
  let stopped = false; const work = f.coordinator.shutdown("daemon_restart").then(() => { stopped = true; });
  run.finish(); await nextTick(); assert.equal(stopped, false);
  order.ready(handle); await nextTick(); assert.equal(stopped, false);
  order.finish(handle); await work;
});

test("terminal handoff is verified only after the original durable finalization barrier", async () => {
  const f = fixture(), order = runSuspensionOrderFor(f.activeRuns), phases = [];
  let terminal = false;
  const handoff = createDelegatedTerminalHandoff(source("child"), phase => {
    phases.push(phase); if (phase === "settled") assert.equal(terminal, true);
  });
  const run = add(f.activeRuns, "child", { terminalHandoff: handoff });
  const handle = order.capture({ getRun: id => ({ id, taskId: `task-${id}` }) }, source("child"));
  f.activeRuns.requestStop("child", { kind: "workflow_cancel", workflowId: "workflow", reason: "Host stop_with_parent" });
  const work = f.coordinator.shutdown("daemon_restart");
  run.finish(); await nextTick(); assert.deepEqual(phases, ["capture"]);
  terminal = true; order.finish(handle); await work;
  assert.deepEqual(phases, ["capture", "settled"]);
});

for (const unknown of ["effect", "usage", "drain", "result"]) test(`unknown ${unknown} still refuses terminal shutdown after local drain`, async () => {
  const f = fixture();
  const run = add(f.activeRuns, "child", { terminalHandoff: createDelegatedTerminalHandoff(source("child"), phase => {
    if (phase === "settled") throw new Error(`${unknown} remains unknown`);
  }) });
  f.activeRuns.requestStop("child", { kind: "workflow_cancel", workflowId: "workflow", reason: "Host stop_with_parent" });
  const work = assert.rejects(f.coordinator.shutdown("daemon_restart"), error => error instanceof AggregateError
    && error.errors.some(item => item.message === "runtime_terminal_handoff_unverified"));
  run.finish(); await work;
});

test("late source persistence failure cannot disappear behind the first accepted request", async () => {
  const f = fixture(), completion = deferred();
  f.activeRuns.trackCompletion(completion.promise);
  const work = f.coordinator.shutdown("daemon_restart");
  await nextTick();
  const failure = new Error("late original source refused");
  const late = add(f.activeRuns, "late", { requestGracefulSuspension() { throw failure; } });
  const result = assert.rejects(work, error => error instanceof AggregateError
    && error.errors.some(item => item instanceof AggregateError && item.errors.includes(failure)));
  late.finish(); completion.resolve(); await result;
  assert.equal(late.abortController.signal.aborted, false);
});

test("request refusal still drains original executions and delegation finalizers before returning failure", async () => {
  const settled = deferred(); const f = fixture({ settle: () => settled.promise });
  const failure = new Error("source cannot seal");
  const run = add(f.activeRuns, "root", { requestGracefulSuspension() { throw failure; } });
  let done = false;
  const work = assert.rejects(f.coordinator.shutdown("daemon_restart"), { message: "runtime_shutdown_unverified" }).then(() => { done = true; });
  await nextTick(); assert.equal(done, false);
  run.finish(); await nextTick(); assert.equal(done, false);
  settled.resolve(); await work;
  assert.equal(run.abortController.signal.aborted, false);
});

test("unknown executor capability fails closed, never falls back to abort", async () => {
  const f = fixture(), run = add(f.activeRuns, "unknown");
  const work = assert.rejects(f.coordinator.shutdown("daemon_restart"), { message: "runtime_shutdown_unverified" });
  await nextTick(); assert.equal(run.abortController.signal.aborted, false);
  run.finish(); await work;
});

for (const refuse of [false, true]) test(`captured media local abort precedes parent drain; request refusal=${refuse}`, async t => {
  const activeRuns = new ActiveRunRegistry(), mediaExecutions = new MediaLocalExecutionRegistry();
  const writers = new AttemptLocalWriterGroup(source("media-parent")), tail = deferred();
  const ticket = mediaExecutions.reserve({ source: writers.source, requestDigest: "owned-media",
    toolCallId: "owned-media", localWriters: writers });
  const handle = mediaExecutions.bindNew(ticket, { cwd: "/workspace/owned-media", mediaJobId: "owned-job" });
  const signal = mediaExecutions.getAbortSignal(handle);
  const body = mediaExecutions.runTick({ cwd: handle.cwd, mediaJobId: handle.mediaJobId, execution: handle }, async () => {
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    await tail.promise;
  });
  const run = add(activeRuns, "media-parent", { requestGracefulSuspension() {
    if (refuse) throw new Error("exact source refused");
  } });
  writers.close();
  const parent = writers.waitForIdle().then(() => run.finish());
  const coordinator = createRunShutdownCoordinator({ activeRuns,
    delegations: { stopAdmission() {}, async settle() {} }, mediaExecutions });
  let done = false;
  const work = coordinator.shutdown("daemon_restart");
  const result = (refuse ? assert.rejects(work, { message: "runtime_shutdown_unverified" }) : work).then(() => { done = true; });
  t.after(async () => { mediaExecutions.beginShutdown(); tail.resolve(); await body; await parent; await result; });
  await nextTick();
  assert.equal(signal.aborted, true, "parent cannot drain until its captured media request receives local abort");
  assert.equal(run.abortController.signal.aborted, false, "media local abort is not parent cancellation");
  assert.equal(done, false, "local abort alone is not physical drain or a stopped receipt");
  assert.equal(writers.getSnapshot().writers.length, 1);
  tail.resolve(); await body; await parent; await result;
  assert.equal(mediaExecutions.getSnapshot().pendingReservations, 0);
});
