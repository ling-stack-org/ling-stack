import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { AttemptLocalWriterGroup } from "../dist/runtime/attempt-local-writers.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { scopeUserInputLocalWriters } from "../dist/features/runs/user-input-local-writer-scope.js";

const source = Object.freeze({ runId: "local-run", workUnitId: "local-work", attemptId: "local-attempt",
  runtimeInstanceId: "local-runtime", fencingToken: "local-token-1" });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function register(registry, group, completion) {
  registry.add(source.runId, { ...group.source, completion, abortController: new AbortController(), streamEnvelope() {} });
}

test("closed execution ignores late Runner events but still rejects new executable callbacks", () => {
  const group = new AttemptLocalWriterGroup(source);
  const events = [];
  const request = scopeUserInputLocalWriters({
    onEvent: event => { events.push(event); },
    onToolBefore: () => assert.fail("a closed execution must not admit a tool"),
  }, group);
  const event = { type: "provider_retry", phase: "scheduled" };
  request.onEvent(event);
  assert.deepEqual(events, [event]);
  assert.deepEqual(group.getSnapshot().writers, []);
  group.close();
  assert.doesNotThrow(() => request.onEvent({ ...event, phase: "settled" }));
  assert.deepEqual(events, [event], "late diagnostics cannot publish or reopen terminal state");
  assert.throws(() => request.onToolBefore({ toolCallId: "late", toolName: "read" }), /admission is closed/);
});

test("outer Host callback owns its final writes beyond the nested tool result", async () => {
  const group = new AttemptLocalWriterGroup(source);
  const work = deferred();
  let writes = 0, idle = false;
  const callback = group.wrapAsync("broker-post-result", async () => {
    try { await work.promise; } finally { writes++; }
  });
  const pending = callback();
  assert.deepEqual(group.getSnapshot().writers, ["broker-post-result"]);
  group.close();
  const drain = group.waitForIdle().then(() => { idle = true; });
  await tick();
  assert.equal(idle, false);
  assert.equal(writes, 0);
  work.resolve();
  await pending;
  await drain;
  assert.equal(writes, 1);
  assert.equal(idle, true);
});

for (const rejects of [false, true]) {
  test(`isolated Host callback drains after its final write on ${rejects ? "rejection" : "success"}`, async () => {
    const group = new AttemptLocalWriterGroup(source);
    const nestedResult = deferred(), finalWrite = deferred(), finalWriteStarted = deferred();
    const call = { toolCallId: "isolated-write", toolName: "write", input: { path: "result.txt", content: "done" }, cwd: "/workspace" };
    const result = { content: [{ type: "text", text: "written" }] }, failure = new Error("isolated callback failed");
    const boundaries = [], writes = [];
    const request = scopeUserInputLocalWriters({ onIsolatedToolCall: async captured => {
      assert.equal(captured, call);
      try {
        await nestedResult.promise;
        if (rejects) throw failure;
        return result;
      } finally {
        finalWriteStarted.resolve();
        await finalWrite.promise;
        writes.push(captured.toolCallId);
      }
    } }, group, { onToolBoundary: captured => { boundaries.push(captured); } });
    const pending = request.onIsolatedToolCall(call);
    const outcome = rejects ? assert.rejects(pending, error => error === failure)
      : pending.then(actual => { assert.equal(actual, result); });
    assert.deepEqual(boundaries, [call]);
    assert.deepEqual(group.getSnapshot().writers, ["isolated_tool"]);
    nestedResult.resolve();
    await finalWriteStarted.promise;
    group.close();
    let idle = false;
    const drain = group.waitForIdle().then(() => { idle = true; });
    await tick();
    assert.equal(idle, false, "the nested result cannot retire the outer callback's final write");
    assert.deepEqual(writes, []);
    assert.deepEqual(group.getSnapshot().writers, ["isolated_tool"]);
    finalWrite.resolve();
    await outcome;
    await drain;
    assert.deepEqual(writes, [call.toolCallId]);
    assert.equal(idle, true);
    assert.deepEqual(group.getSnapshot(), { closed: true, writers: [] });
  });
}

test("closed isolated Host admission rejects before invoking the captured callback", async () => {
  const group = new AttemptLocalWriterGroup(source), writes = [];
  const request = scopeUserInputLocalWriters({ onIsolatedToolCall: call => {
    writes.push(call.toolCallId);
    return { content: [] };
  } }, group);
  group.close();
  assert.throws(() => request.onIsolatedToolCall({ toolCallId: "late-isolated", toolName: "write", input: {}, cwd: "/workspace" }),
    /admission is closed/u);
  await group.waitForIdle();
  assert.deepEqual(writes, []);
  assert.deepEqual(group.getSnapshot(), { closed: true, writers: [] });
});

for (const [callback, label] of [["onTaskSettledBoundary", "settled_boundary"],
  ["onTaskRestoredCompleteBoundary", "restored_complete_boundary"]]) {
  test(`${callback} remains a tracked Host writer through its entire awaited fan-in`, async () => {
    const group = new AttemptLocalWriterGroup(source), work = deferred();
    const request = scopeUserInputLocalWriters({ [callback]: async modelView => {
      await work.promise; return modelView;
    } }, group);
    const view = [{ role: "assistant", stopReason: "stop" }];
    const pending = request[callback](view);
    assert.deepEqual(group.getSnapshot().writers, [label]);
    group.close();
    await assert.rejects(group.waitForIdle(0), /have not drained/u);
    work.resolve();
    assert.equal(await pending, view);
    await group.waitForIdle();
    assert.throws(() => request[callback](view), /admission is closed/u);
  });
}

test("rejection and synchronous errors finish local callbacks, not durable safety", async () => {
  const group = new AttemptLocalWriterGroup(source);
  await assert.rejects(group.wrapAsync("reject", async () => { throw new Error("business failed"); })(), /business failed/);
  assert.throws(group.wrapSync("sync", () => { throw new Error("sync failed"); }), /sync failed/);
  group.close();
  await group.waitForIdle();
  assert.throws(() => group.reserve("late"), /admission is closed/);
  assert.throws(group.wrapSync("late-effect", () => assert.fail("no late side effect")), /admission is closed/);
  assert.equal(Object.isFrozen(group.source), true);
});

test("a producer has independent membership; deadlines and parent return cannot release it", async () => {
  const group = new AttemptLocalWriterGroup(source);
  const finish = group.reserve("actual-background-producer");
  await group.wrapAsync("parent", () => "queued")();
  group.close();
  await assert.rejects(group.waitForIdle(0), /have not drained/);
  assert.deepEqual(group.getSnapshot().writers, ["actual-background-producer"]);
  finish(); finish();
  await group.waitForIdle();
});

test("retained source retires only local lifetime and keeps a separate blocked authority record", async () => {
  const group = new AttemptLocalWriterGroup(source);
  const registry = new ActiveRunRegistry();
  const work = deferred(), runCompletion = deferred();
  const callback = group.wrapAsync("live-writer", () => work.promise)();
  register(registry, group, runCompletion.promise);
  let timerStopped = false;
  registry.retainBlockedAttempt(source.runId, group, () => { timerStopped = true; runCompletion.resolve(); });
  registry.suspendAll("daemon_restart");
  await assert.rejects(registry.waitForIdle(0), /not idle/);
  assert.equal(timerStopped, false);
  assert.equal(registry.getRetainedAttempt(source.runId, source.attemptId).localDrainStatus, "draining");
  assert.ok(registry.get(source.runId));
  work.resolve();
  await callback;
  await registry.waitForIdle(100);
  assert.equal(timerStopped, true);
  assert.equal(registry.get(source.runId), undefined);
  assert.equal(registry.getRetainedAttempt(source.runId, source.attemptId).localDrainStatus, "drained");
});

test("old retained cleanup cannot delete or stop a replacement attempt", async () => {
  const group = new AttemptLocalWriterGroup(source);
  const registry = new ActiveRunRegistry(), work = deferred();
  const callback = group.wrapAsync("old-writer", () => work.promise)();
  register(registry, group);
  registry.retainBlockedAttempt(source.runId, group, () => {});
  const replacement = new AbortController();
  registry.add(source.runId, { ...source, attemptId: "successor", fencingToken: "local-token-2",
    abortController: replacement, streamEnvelope() {} });
  work.resolve();
  await callback;
  await tick();
  assert.equal(registry.get(source.runId).attemptId, "successor");
  assert.equal(replacement.signal.aborted, false);
  registry.delete(source.runId);
  await registry.waitForIdle();
});

test("old isolated Host drain cannot retire a successor's callback or close its admission", async () => {
  const registry = new ActiveRunRegistry(), oldGroup = new AttemptLocalWriterGroup(source);
  const oldWrite = deferred(), successorWrite = deferred(), oldDrained = deferred();
  const writes = [], cleanups = [];
  const oldRequest = scopeUserInputLocalWriters({ onIsolatedToolCall: async call => {
    await oldWrite.promise;
    writes.push([oldGroup.source.attemptId, call.toolCallId]);
    return { content: [] };
  } }, oldGroup);
  const call = { toolCallId: "old-isolated", toolName: "write", input: {}, cwd: "/workspace" };
  const oldPending = oldRequest.onIsolatedToolCall(call);
  register(registry, oldGroup);
  registry.retainBlockedAttempt(source.runId, oldGroup, () => {
    cleanups.push(oldGroup.source.attemptId);
    oldDrained.resolve();
  });
  assert.equal(registry.getRetainedAttempt(source.runId, source.attemptId).localDrainStatus, "draining");
  assert.deepEqual(oldGroup.getSnapshot(), { closed: true, writers: ["isolated_tool"] });

  const successorGroup = new AttemptLocalWriterGroup({ ...source, attemptId: "successor", fencingToken: "local-token-2" });
  const replacement = new AbortController();
  registry.add(source.runId, { ...successorGroup.source, abortController: replacement, streamEnvelope() {} });
  const successor = registry.get(source.runId);
  const successorRequest = scopeUserInputLocalWriters({ onIsolatedToolCall: async captured => {
    await successorWrite.promise;
    writes.push([successorGroup.source.attemptId, captured.toolCallId]);
    return { content: [] };
  } }, successorGroup);
  const successorPending = successorRequest.onIsolatedToolCall({ ...call, toolCallId: "successor-isolated" });
  oldWrite.resolve();
  await oldPending;
  await oldDrained.promise;
  assert.equal(registry.getRetainedAttempt(source.runId, source.attemptId).localDrainStatus, "drained");
  assert.deepEqual(cleanups, [source.attemptId]);
  assert.equal(registry.get(source.runId), successor);
  assert.equal(replacement.signal.aborted, false);
  assert.deepEqual(successorGroup.getSnapshot(), { closed: false, writers: ["isolated_tool"] });
  assert.throws(() => oldRequest.onIsolatedToolCall({ ...call, toolCallId: "stale-isolated" }), /admission is closed/u);
  assert.deepEqual(writes, [[source.attemptId, "old-isolated"]]);

  const nextPending = successorRequest.onIsolatedToolCall({ ...call, toolCallId: "successor-next" });
  assert.deepEqual(successorGroup.getSnapshot().writers, ["isolated_tool", "isolated_tool"]);
  successorGroup.close();
  await assert.rejects(successorGroup.waitForIdle(0), /have not drained/u);
  successorWrite.resolve();
  await Promise.all([successorPending, nextPending]);
  await successorGroup.waitForIdle();
  assert.deepEqual(writes, [[source.attemptId, "old-isolated"], ["successor", "successor-isolated"], ["successor", "successor-next"]]);
  assert.equal(registry.get(source.runId), successor);
  assert.equal(replacement.signal.aborted, false);
  assert.deepEqual(successorGroup.getSnapshot(), { closed: true, writers: [] });
  registry.delete(source.runId);
  await registry.waitForIdle();
});

test("retention rejects a different captured source before closing local admission", () => {
  const registry = new ActiveRunRegistry();
  const group = new AttemptLocalWriterGroup({ ...source, fencingToken: "local-token-2" });
  register(registry, new AttemptLocalWriterGroup(source));
  assert.throws(() => registry.retainBlockedAttempt(source.runId, group, () => {}), /captured source/);
  assert.equal(group.getSnapshot().closed, false);
  registry.delete(source.runId);
});
