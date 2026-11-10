import assert from "node:assert/strict";
import test from "node:test";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { setImmediate as nextTick } from "node:timers/promises";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createDelegatedTerminalHandoff } from "../dist/runtime/delegated-terminal-handoff.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function register(registry, id, callback, overrides = {}) {
  const lifetime = deferred(), abortController = new AbortController();
  registry.add(id, { abortController, streamEnvelope() {}, completion: lifetime.promise,
    workUnitId: `unit-${id}`, attemptId: `attempt-${id}`, runtimeInstanceId: "original-runtime",
    fencingToken: `fence-${id}`, requestGracefulSuspension: callback, ...overrides });
  return { lifetime, abortController, close() { registry.delete(id); lifetime.resolve(); } };
}

test("graceful admission closure captures the original source without aborting it or claiming drain", async () => {
  const registry = new ActiveRunRegistry(), accepted = deferred();
  const observations = [];
  const run = register(registry, "root", request => { observations.push(request); return accepted.promise; });
  try {
    let requested = false;
    const pending = registry.requestGracefulSuspension("daemon_restart").then(() => { requested = true; });
    assert.equal(registry.isShuttingDown(), true);
    assert.equal(observations.length, 1, "the durable request callback starts synchronously, before another dispatch");
    assert.deepEqual(observations[0], { cause: "daemon_restart", source: { runId: "root", workUnitId: "unit-root",
      attemptId: "attempt-root", runtimeInstanceId: "original-runtime", fencingToken: "fence-root" } });
    assert.equal(Object.isFrozen(observations[0]), true);
    assert.equal(Object.isFrozen(observations[0].source), true);
    assert.equal(run.abortController.signal.aborted, false);
    assert.equal(registry.getStopIntent("root"), undefined, "a request is not an abort intent");
    await nextTick();
    assert.equal(requested, false);
    accepted.resolve(); await pending;
    await assert.rejects(registry.waitForIdle(0), /not idle/i, "accepted request is not stopped proof");
  } finally { accepted.resolve(); run.close(); await registry.waitForIdle(); }
});

test("repeated graceful shutdown requests share the first cause and one captured request", async () => {
  const registry = new ActiveRunRegistry();
  let calls = 0, cause;
  const run = register(registry, "root", request => { calls += 1; cause = request.cause; });
  try {
    const first = registry.requestGracefulSuspension("desktop_quit");
    assert.equal(registry.requestGracefulSuspension("process_signal"), first);
    await first;
    assert.equal(calls, 1); assert.equal(cause, "desktop_quit");
    assert.equal(run.abortController.signal.aborted, false);
  } finally { run.close(); await registry.waitForIdle(); }
});

test("a late exact source joins the pending request barrier without an invented runtime or abort", async () => {
  const registry = new ActiveRunRegistry(), first = deferred(), late = deferred();
  const root = register(registry, "root", () => first.promise);
  const requests = [];
  const pending = registry.requestGracefulSuspension("daemon_restart");
  const child = register(registry, "child", request => { requests.push(request); return late.promise; });
  try {
    first.resolve(); let settled = false;
    void pending.then(() => { settled = true; });
    await nextTick(); assert.equal(settled, false);
    assert.equal(requests.length, 1); assert.equal(requests[0].source.attemptId, "attempt-child");
    assert.equal(child.abortController.signal.aborted, false);
    late.resolve(); await pending;
  } finally { first.resolve(); late.resolve(); root.close(); child.close(); await registry.waitForIdle(); }
});

test("failed persistence stays a failed request, not an abort or idle receipt", async () => {
  const registry = new ActiveRunRegistry(), error = new Error("original SQLite request failed");
  const run = register(registry, "root", () => { throw error; });
  try {
    const pending = registry.requestGracefulSuspension("daemon_restart");
    await assert.rejects(pending, failure => failure instanceof AggregateError && failure.errors.includes(error));
    await assert.rejects(registry.requestGracefulSuspension("daemon_restart"), AggregateError);
    assert.equal(run.abortController.signal.aborted, false);
    await assert.rejects(registry.waitForIdle(0), /not idle/i);
  } finally { run.close(); await registry.waitForIdle(); }
});

for (const missing of ["runtimeInstanceId", "workUnitId", "attemptId", "fencingToken", "completion", "requestGracefulSuspension"]) {
  test(`graceful request rejects an unverifiable original handle: ${missing}`, async () => {
    const registry = new ActiveRunRegistry(); let calls = 0;
    const run = register(registry, "root", () => { calls += 1; }, { [missing]: undefined });
    try {
      await assert.rejects(registry.requestGracefulSuspension("daemon_restart"), AggregateError);
      assert.equal(calls, 0); assert.equal(run.abortController.signal.aborted, false);
    } finally { run.close(); await registry.waitForIdle(); }
  });
}

test("admission closes before any suspension callback or abort, while late original lifetimes remain tracked", async () => {
  const registry = new ActiveRunRegistry(); let requests = 0;
  const run = register(registry, "admission-root", () => { requests++; });
  let late;
  try {
    registry.stopAdmission();
    assert.equal(registry.isShuttingDown(), true);
    assert.equal(requests, 0);
    assert.equal(run.abortController.signal.aborted, false);
    late = register(registry, "already-entered-preflight", () => { requests++; });
    assert.equal(requests, 0, "registering an original lifetime is not permission to launch it");
    assert.equal(late.abortController.signal.aborted, false);
    await assert.rejects(registry.waitForIdle(0), /not idle/i);
    await registry.requestGracefulSuspension("daemon_restart");
    assert.equal(requests, 2, "the real abort phase must still collect both original sources");
    assert.equal(run.abortController.signal.aborted, false);
    assert.equal(late.abortController.signal.aborted, false);
  } finally { run.close(); late?.close(); await registry.waitForIdle(); }
});

for (const native of [false, true]) test(`a queued real Run entry observes synchronous closed admission before any dispatch: native=${native}`, async () => {
  const registry = new ActiveRunRegistry(), failures = [];
  let dispatches = 0;
  const sink = { ...createDetachedRunExecutionSink(), writeError(status, body) { failures.push({ status, body }); } };
  const request = { cwd: "/unused-admission-boundary", task: { id: "no-launch", title: "No launch", prompt: "Must not execute" },
    ...(native ? { executionBinding: { kind: "native_profile", profileId: "no-launch" } } : {}) };
  const forbidden = new Proxy({}, { get() { assert.fail("closed admission must not access execution dependencies"); } });
  const work = executeRunRequest(request, sink, forbidden, forbidden, registry, forbidden, forbidden, forbidden,
    { nativeRunDispatcher: { dispatch() { dispatches++; assert.fail("closed native admission must not dispatch"); } } });
  registry.stopAdmission();
  assert.equal(await work, undefined);
  assert.equal(dispatches, 0);
  assert.deepEqual(failures, [{ status: 503, body: { error: "runtime_shutting_down", message: "Runtime is shutting down." } }]);
  await registry.waitForIdle();
});

test("a pending graceful request does not overwrite explicit user cancellation", async () => {
  const registry = new ActiveRunRegistry(), accepted = deferred();
  const run = register(registry, "root", () => accepted.promise);
  try {
    const pending = registry.requestGracefulSuspension("daemon_restart");
    const cancel = { kind: "user_cancel", actor: "local-user", reason: "user changed their mind" };
    assert.equal(registry.requestStop("root", cancel), true);
    assert.deepEqual(run.abortController.signal.reason, cancel);
    assert.deepEqual(registry.getStopIntent("root"), cancel);
    accepted.resolve(); await pending;
  } finally { accepted.resolve(); run.close(); await registry.waitForIdle(); }
});

test("late request failure remains visible at the final request barrier after initial acceptance", async () => {
  const registry = new ActiveRunRegistry(), error = new Error("late source persistence failed");
  await registry.requestGracefulSuspension("daemon_restart");
  const run = register(registry, "late", () => { throw error; });
  try {
    await assert.rejects(registry.waitForGracefulSuspensionRequests(),
      failure => failure instanceof AggregateError && failure.errors.includes(error));
    assert.equal(run.abortController.signal.aborted, false);
  } finally { run.close(); await registry.waitForIdle(); }
});

test("reentrant request callbacks observe the same single-flight barrier", async () => {
  const registry = new ActiveRunRegistry(); let captured;
  const run = register(registry, "root", () => { captured = registry.requestGracefulSuspension("process_signal"); });
  try {
    const pending = registry.requestGracefulSuspension("desktop_quit");
    assert.equal(captured, pending); await pending;
    assert.throws(() => registry.suspendAll("daemon_restart"), /cannot_be_replaced_by_abort/);
    assert.equal(run.abortController.signal.aborted, false);
  } finally { run.close(); await registry.waitForIdle(); }
});

test("an already aborted source cannot be reclassified as gracefully requested", async () => {
  const registry = new ActiveRunRegistry(); let calls = 0;
  const run = register(registry, "root", () => { calls += 1; });
  registry.requestStop("root", { kind: "runtime_failure", code: "hard_timeout", reason: "deadline expired" });
  try {
    await assert.rejects(registry.requestGracefulSuspension("daemon_restart"), AggregateError);
    assert.equal(calls, 0);
    assert.equal(run.abortController.signal.reason.kind, "runtime_failure");
  } finally { run.close(); await registry.waitForIdle(); }
});

test("a nominal terminal handoff is distinct from suspension and still needs final proof", async () => {
  const registry = new ActiveRunRegistry(), phases = [];
  const source = { runId: "child", workUnitId: "unit-child", attemptId: "attempt-child",
    runtimeInstanceId: "original-runtime", fencingToken: "fence-child" };
  let terminal = false, requests = 0;
  // Plumbing test only: production creates this observer in original Store custody.
  const terminalHandoff = createDelegatedTerminalHandoff(source, phase => {
    phases.push(phase); if (phase === "settled" && !terminal) throw new Error("actual terminal facts pending");
  });
  const run = register(registry, "child", () => { requests++; }, { terminalHandoff });
  registry.requestStop("child", { kind: "workflow_cancel", workflowId: "workflow", reason: "Host stop_with_parent" });
  await registry.requestGracefulSuspension("daemon_restart");
  assert.equal(requests, 0); assert.deepEqual(phases, ["capture"]);
  assert.throws(() => registry.verifyTerminalShutdownHandoffs(), /runtime_terminal_handoff_unverified/);
  run.close(); await registry.waitForIdle();
  assert.throws(() => registry.verifyTerminalShutdownHandoffs(), /runtime_terminal_handoff_unverified/,
    "removal and completion alone are not terminal facts");
  terminal = true; registry.verifyTerminalShutdownHandoffs();
});

for (const kind of ["structural", "clone", "foreign-source"]) test(`terminal handoff refuses ${kind} reference`, async () => {
  const registry = new ActiveRunRegistry(); let calls = 0;
  const source = { runId: "child", workUnitId: "unit-child", attemptId: "attempt-child",
    runtimeInstanceId: "original-runtime", fencingToken: kind === "foreign-source" ? "foreign" : "fence-child" };
  const original = createDelegatedTerminalHandoff(source, () => { calls++; });
  const terminalHandoff = kind === "structural" ? Object.freeze({}) : kind === "clone" ? structuredClone(original) : original;
  const run = register(registry, "child", () => assert.fail("must not request a resumable suspension"), { terminalHandoff });
  registry.requestStop("child", { kind: "workflow_cancel", workflowId: "workflow", reason: "Host stop_with_parent" });
  try { await assert.rejects(registry.requestGracefulSuspension("daemon_restart"), AggregateError); assert.equal(calls, 0); }
  finally { run.close(); await registry.waitForIdle(); }
});

test("terminal candidate cannot hide another source's real request persistence failure", async () => {
  const registry = new ActiveRunRegistry(), failure = new Error("SQLite request failed");
  const source = { runId: "child", workUnitId: "unit-child", attemptId: "attempt-child",
    runtimeInstanceId: "original-runtime", fencingToken: "fence-child" };
  const child = register(registry, "child", () => assert.fail(), { terminalHandoff: createDelegatedTerminalHandoff(source, () => {}) });
  const root = register(registry, "root", () => { throw failure; });
  registry.requestStop("child", { kind: "workflow_cancel", workflowId: "workflow", reason: "Host stop_with_parent" });
  try {
    await assert.rejects(registry.requestGracefulSuspension("daemon_restart"), error => error.errors.includes(failure));
    registry.verifyTerminalShutdownHandoffs();
    await assert.rejects(registry.waitForGracefulSuspensionRequests(), error => error.errors.includes(failure));
  } finally { child.close(); root.close(); await registry.waitForIdle(); }
});
