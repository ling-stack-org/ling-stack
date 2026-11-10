import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { MediaLocalExecutionAdmissionError, MediaLocalExecutionRegistry } from "../dist/runtime/media-local-executions.js";
import { AttemptLocalWriterGroup } from "../dist/runtime/attempt-local-writers.js";

const source = Object.freeze({ runId: "media-run", workUnitId: "parent-work", attemptId: "parent-attempt",
  runtimeInstanceId: "runtime", fencingToken: "parent-fence" });
const binding = Object.freeze({ cwd: "/workspace/media", mediaJobId: "job", workUnitId: "child-work" });
const childAttempt = Object.freeze({ workUnitId: "child-work", attemptId: "child-attempt", runtimeInstanceId: "runtime", fencingToken: "child-fence" });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const registry = new MediaLocalExecutionRegistry(options);
  const group = new AttemptLocalWriterGroup(source);
  const input = { source, toolCallId: "media-call", requestDigest: "digest", localWriters: group };
  return { registry, group, input, reserve: overrides => registry.reserve({ ...input, ...overrides }) };
}
function runInput(handle) { return { cwd: handle.cwd, mediaJobId: handle.mediaJobId, execution: handle }; }

test("reservation precedes first metadata await; bind remains prepared until actual dispatch", async () => {
  const { registry, group, reserve } = fixture();
  const ticket = reserve();
  assert.equal(group.getSnapshot().writers.length, 1);
  assert.equal(registry.getSnapshot().pendingReservations, 1);
  const handle = registry.bindNew(ticket, binding);
  await tick();
  assert.equal(registry.getSnapshot().executions[0].phase, "prepared");
  assert.equal(group.getSnapshot().writers.length, 1);
  group.close();
  await assert.rejects(registry.waitForIdle(0), /have not drained/);
  await registry.track(handle, () => assert.equal(group.getSnapshot().writers.length, 1));
  await handle.completion;
  await group.waitForIdle();
  await registry.waitForIdle();
});

test("only unbound reservation can abandon; completion tail still retains its writer", async () => {
  const { registry, group, reserve } = fixture();
  const tail = deferred();
  const ticket = reserve({ onLocalCompleted: () => tail.promise });
  assert.equal(registry.abandon(ticket), true);
  assert.equal(registry.abandon(ticket), false);
  group.close();
  await assert.rejects(group.waitForIdle(0), /have not drained/);
  assert.throws(() => registry.bindNew(ticket, binding), /already been consumed/);
  tail.resolve();
  await ticket.completion;
  await registry.waitForIdle();
  await group.waitForIdle();
});

test("shutdown cannot turn an unbound ticket into drain or permit a late bind", async () => {
  const { registry, group, reserve } = fixture();
  const ticket = reserve();
  registry.beginShutdown();
  assert.throws(() => registry.bindNew(ticket, binding), /shutdown/);
  await assert.rejects(registry.waitForIdle(0), /have not drained/);
  assert.equal(registry.getSnapshot().pendingReservations, 1);
  registry.abandon(ticket);
  group.close();
  await ticket.completion;
  await group.waitForIdle();
  await registry.waitForIdle();
});

for (const settlement of ["resolve", "reject"]) {
  test(`actual provider ${settlement} and its catch cleanup retain ownership after shutdown`, async () => {
    const { registry, group, reserve } = fixture();
    const handle = registry.bindNew(reserve(), binding);
    const actual = deferred(), cleanup = deferred(), enteredCleanup = deferred();
    const dispatch = registry.track(handle, async () => {
      try { await registry.runTick(runInput(handle), () => actual.promise); }
      catch { /* Dispatch error is handled by the existing tail. */ }
      enteredCleanup.resolve();
      await cleanup.promise;
    });
    registry.beginShutdown();
    group.close();
    await assert.rejects(registry.waitForIdle(0), /have not drained/);
    assert.equal(registry.getSnapshot().executions[0].active, 2);
    actual[settlement](settlement === "resolve" ? "done" : new Error("late provider failure"));
    await enteredCleanup.promise;
    await assert.rejects(registry.waitForIdle(0), /have not drained/);
    assert.equal(group.getSnapshot().writers.length, 1, "catch/status/projection writes are still actual local work");
    cleanup.resolve();
    await dispatch;
    await handle.completion;
    await registry.waitForIdle();
    await group.waitForIdle();
  });
}

test("same-stack owner throw is observed and releases only its own generation", async () => {
  const { registry, group, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding);
  await assert.rejects(registry.runTick(runInput(handle), () => { throw new Error("sync dispatch failure"); }), /sync dispatch failure/);
  await handle.completion;
  group.close();
  await group.waitForIdle();
  assert.match(registry.getSnapshot().executions[0].lastError, /sync dispatch failure/);
});

test("exclusive duplicate tick joins while an outer track can independently own the catch tail", async () => {
  const { registry, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding), actual = deferred();
  let calls = 0;
  const first = registry.runTick(runInput(handle), () => { calls++; return actual.promise; });
  const duplicate = registry.runTick(runInput(handle), () => { calls++; assert.fail("duplicate must not dispatch"); });
  assert.equal(duplicate, first);
  const outer = registry.track(handle, () => first);
  assert.equal(registry.getSnapshot().executions[0].active, 2);
  actual.resolve("provider value");
  assert.equal(await first, "provider value");
  assert.equal(await outer, "provider value");
  await handle.completion;
  assert.equal(calls, 1);
});

test("202 pending tick cannot release the reserved future poll", async () => {
  const { registry, group, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding), poll = deferred(), started = deferred();
  await registry.runTick(runInput(handle), current => {
    registry.schedule(current, 10, original => registry.runTick(runInput(original), () => { started.resolve(); return poll.promise; }));
    return { status: "pending" };
  });
  group.close();
  assert.equal(registry.getSnapshot().executions[0].scheduled, true);
  await assert.rejects(registry.waitForIdle(0), /have not drained/);
  await started.promise;
  assert.equal(registry.getSnapshot().executions[0].scheduled, false);
  assert.equal(group.getSnapshot().writers.length, 1);
  poll.resolve();
  await handle.completion;
  await registry.waitForIdle();
  await group.waitForIdle();
});

test("timer firing transfers ownership before waiting for the old exclusive owner", async () => {
  const { registry, group, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding), actual = deferred(), next = deferred(), started = deferred();
  let polls = 0;
  const first = registry.runTick(runInput(handle), current => {
    registry.schedule(current, 0, original => registry.runTick(runInput(original), () => {
      polls++; started.resolve(); return next.promise;
    }));
    return actual.promise;
  });
  group.close();
  await delay(10);
  assert.equal(polls, 0, "timer must not join and swallow the next poll while first owner is pending");
  assert.equal(registry.getSnapshot().executions[0].active, 2, "fired timer owns its transfer/wait callback");
  assert.equal(registry.getSnapshot().executions[0].scheduled, false);
  await assert.rejects(registry.waitForIdle(0), /have not drained/);
  actual.resolve();
  await first;
  await started.promise;
  assert.equal(polls, 1);
  assert.equal(group.getSnapshot().writers.length, 1);
  next.resolve();
  await handle.completion;
  await registry.waitForIdle();
  await group.waitForIdle();
});

test("timer callback late rejection is observed, including after shutdown", async () => {
  const { registry, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding), actual = deferred(), started = deferred();
  await registry.runTick(runInput(handle), current => {
    registry.schedule(current, 0, async () => { started.resolve(); await actual.promise; });
  });
  await started.promise;
  registry.beginShutdown();
  await assert.rejects(registry.waitForIdle(0), /have not drained/);
  actual.reject(new Error("late timer collector failure"));
  await handle.completion;
  await registry.waitForIdle();
  assert.match(registry.getSnapshot().executions[0].lastError, /late timer collector failure/);
  await tick();
});

test("same generation atomically refreshes a pending timer without releasing its writer", async () => {
  const { registry, group, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding);
  let staleCalls = 0, currentCalls = 0;
  await registry.runTick(runInput(handle), current => registry.schedule(current, 1000, () => { staleCalls++; }));
  group.close();
  registry.schedule(handle, 0, () => { currentCalls++; });
  assert.equal(group.getSnapshot().writers.length, 1);
  await handle.completion;
  await group.waitForIdle();
  assert.equal(staleCalls, 0);
  assert.equal(currentCalls, 1);
});

test("shutdown clears future timers but not the entered callback or its completion tail", async () => {
  const { registry, group, reserve } = fixture();
  const callback = deferred(), completionTail = deferred();
  const handle = registry.bindNew(reserve({ onLocalCompleted: () => completionTail.promise }), binding);
  let nextCalls = 0;
  const first = registry.runTick(runInput(handle), current => {
    registry.schedule(current, 1000, () => { nextCalls++; });
    return callback.promise;
  });
  registry.beginShutdown();
  group.close();
  assert.equal(registry.getSnapshot().executions[0].scheduled, false);
  callback.resolve();
  await first;
  await tick();
  assert.equal(registry.getSnapshot().executions[0].phase, "completing");
  await assert.rejects(registry.waitForIdle(0), /have not drained/);
  await assert.rejects(group.waitForIdle(0), /have not drained/);
  completionTail.resolve();
  await handle.completion;
  await registry.waitForIdle();
  await group.waitForIdle();
  assert.equal(nextCalls, 0);
});

test("required-input close forbids forward effects but admits the original observation and cleanup", async () => {
  const { registry, group, reserve } = fixture();
  let forwardClosed = false, observations = 0;
  const handle = registry.bindNew(reserve({ effectGate(mode) {
    if (mode === "forward" && forwardClosed) throw new Error("required input admission closed");
  } }), binding);
  await registry.runTick(runInput(handle), current => {
    forwardClosed = true;
    group.close();
    assert.throws(() => registry.assertEffectAllowed(current), /required input/);
    registry.assertEffectAllowed(current, "observation");
    registry.schedule(current, 0, original => {
      registry.assertEffectAllowed(original, "observation");
      observations++;
    });
  });
  await handle.completion;
  assert.equal(observations, 1);
  await group.waitForIdle();
});

test("trusted launch hook encloses actual synchronous send and cannot bypass shutdown", async () => {
  const { registry, reserve } = fixture();
  const order = [];
  const handle = registry.bindNew(reserve({ effectGate(mode) { order.push(`guard:${mode}`); },
    launchEffect(mode, effect) { order.push(`transaction:${mode}`); effect(); order.push("commit"); } }), binding);
  order.length = 0;
  await registry.track(handle, () => {
    registry.launchEffect(handle, "forward", () => order.push("actual fetch start"));
    assert.deepEqual(order, ["guard:forward", "transaction:forward", "actual fetch start", "commit"]);
    registry.beginShutdown();
    assert.throws(() => registry.launchEffect(handle, "observation", () => assert.fail("no send after shutdown")), /shutdown/);
  });
  await handle.completion;
});

test("source-obsolete closes only the exact full fence, preserving entered callbacks", async () => {
  const { registry, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding), actual = deferred();
  const entered = registry.runTick(runInput(handle), () => actual.promise);
  registry.stopSource({ ...source, fencingToken: "other-token" });
  registry.assertEffectAllowed(handle);
  registry.stopSource(source);
  assert.throws(() => registry.getOrStart(runInput(handle)), /stopped/);
  assert.throws(() => reserve(), /obsolete/);
  await assert.rejects(registry.waitForIdle(0), /have not drained/);
  actual.resolve();
  await entered;
  await handle.completion;
  await registry.waitForIdle();
});

test("completion writes allow entered shutdown tails but reject source-obsolete and unentered callbacks", async () => {
  const { registry, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding), actual = deferred();
  assert.throws(() => registry.assertCompletionAllowed(handle), error => error instanceof MediaLocalExecutionAdmissionError && error.code === "completed");
  const entered = registry.runTick(runInput(handle), () => actual.promise);
  registry.beginShutdown();
  registry.assertCompletionAllowed(handle);
  registry.stopSource(source);
  assert.throws(() => registry.assertCompletionAllowed(handle), error => error instanceof MediaLocalExecutionAdmissionError && error.code === "source_obsolete");
  actual.resolve();
  await entered;
  await handle.completion;
  assert.throws(() => registry.assertCompletionAllowed(handle), error => error instanceof MediaLocalExecutionAdmissionError);
});

test("trusted completion lineage permits terminal parent/shutdown tail but rejects parent replacement", async () => {
  const { registry, group, reserve } = fixture();
  let parentTerminal = false, parentReplaced = false, finished = 0, reads = 0;
  const handle = registry.bindNew(reserve({ completionGate() {
    reads++;
    if (parentReplaced) throw new MediaLocalExecutionAdmissionError("source_obsolete", "Parent Attempt replaced.");
    // Original full fence is immutable even when its parent Run has ended.
    assert.equal(parentTerminal, true);
  }, onLocalCompleted() { finished++; } }), binding);
  const actual = deferred(), entered = registry.runTick(runInput(handle), () => actual.promise);
  parentTerminal = true;
  registry.beginShutdown();
  group.close();
  registry.assertCompletionAllowed(handle);
  assert.equal(reads, 1);
  parentReplaced = true;
  assert.throws(() => registry.assertCompletionAllowed(handle), error => error.code === "source_obsolete");
  assert.equal(reads, 2);
  actual.resolve();
  await entered;
  await handle.completion;
  await registry.waitForIdle();
  await group.waitForIdle();
  assert.equal(finished, 1, "lineage veto must not prevent the Host callback from retaining unknown and finally releasing its writer");
});

test("strict reuse attaches only the exact source, digest, tool and child work unit", async () => {
  const { registry, group, reserve } = fixture();
  const firstTicket = reserve(), handle = registry.bindNew(firstTicket, binding), actual = deferred();
  const entered = registry.runTick(runInput(handle), () => actual.promise);
  for (const [overrides, target] of [
    [{ requestDigest: "other" }, binding], [{ toolCallId: "other" }, binding],
    [{ source: { ...source, attemptId: "other" }, localWriters: undefined }, binding],
    [{}, { ...binding, workUnitId: "other" }],
  ]) {
    const badTicket = reserve(overrides);
    assert.throws(() => registry.attachReused(badTicket, target), /no exact/);
    assert.equal(registry.abandon(badTicket), true);
    await badTicket.completion;
  }
  const reusedTicket = reserve();
  assert.equal(registry.attachReused(reusedTicket, binding), handle);
  assert.equal(registry.abandon(reusedTicket), false, "bound reuse does not release an active chain");
  assert.equal(group.getSnapshot().writers.length, 2);
  actual.resolve();
  await entered;
  await handle.completion;
  await reusedTicket.completion;
  group.close();
  await group.waitForIdle();
});

test("completed strict reuse only attaches; ordinary new execution receives a new generation", async () => {
  const { registry, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding);
  await registry.runTick(runInput(handle), () => undefined);
  await handle.completion;
  const reused = reserve();
  assert.equal(registry.attachReused(reused, binding), handle);
  await reused.completion;
  assert.throws(() => registry.runTick(runInput(handle), () => assert.fail("completed reuse cannot redispatch")), /completed/);
  const successor = registry.getOrStart(binding);
  assert.notEqual(successor.generation, handle.generation);
  await registry.runTick(runInput(successor), () => undefined);
  await successor.completion;
  await registry.waitForIdle();
});

test("manual lookup cannot upgrade itself to an active captured source by job id", async () => {
  const { registry, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding);
  assert.throws(() => registry.getOrStart(binding), /original opaque handle/);
  assert.equal(registry.getOrStart(runInput(handle)), handle);
  registry.beginShutdown();
  await handle.completion;
  await registry.waitForIdle();
});

test("job/workspace mismatch, structural clones and other registries cannot acquire ownership", async () => {
  const { registry, reserve } = fixture();
  const foreign = new MediaLocalExecutionRegistry(), ticket = reserve(), handle = registry.bindNew(ticket, binding);
  assert.throws(() => registry.getOrStart({ ...runInput(handle), cwd: "/another/workspace" }), /does not match/);
  assert.throws(() => registry.track({ ...handle }, () => undefined), /Unknown/);
  assert.throws(() => foreign.track(handle, () => undefined), /foreign/);
  assert.throws(() => registry.abandon({ ...ticket }), /Unknown/);
  assert.throws(() => foreign.abandon(ticket), /foreign/);
  assert.throws(() => registry.reserve({ source: { ...source, runId: "other" }, toolCallId: "x", requestDigest: "d",
    localWriters: fixture().group }), /does not match/);
  registry.beginShutdown();
  await handle.completion;
  await registry.waitForIdle();
});

test("child fence binding is immutable and standalone child has no fabricated run id", async () => {
  const registry = new MediaLocalExecutionRegistry(), handle = registry.getOrStart(binding);
  registry.bindAttempt(handle, childAttempt);
  registry.bindAttempt(handle, { ...childAttempt });
  for (const key of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    assert.throws(() => registry.bindAttempt(handle, { ...childAttempt, [key]: "replacement" }), /replace|does not match/);
  }
  assert.throws(() => registry.bindAttempt(handle, { ...childAttempt, runId: "fabricated" }), /replace/);
  await registry.runTick(runInput(handle), () => undefined);
  await handle.completion;
  assert.throws(() => registry.bindAttempt(handle, childAttempt), /completed/);
});

test("completion verification rejection remains visible while writer releases in finally", async () => {
  const { registry, group, reserve } = fixture();
  const tail = deferred(), ticket = reserve({ onLocalCompleted: () => tail.promise });
  const handle = registry.bindNew(ticket, binding);
  await registry.runTick(runInput(handle), () => undefined);
  group.close();
  await assert.rejects(group.waitForIdle(0), /have not drained/);
  tail.reject(new Error("durable settlement unavailable"));
  await assert.rejects(handle.completion, /durable settlement unavailable/);
  await assert.rejects(ticket.completion, /durable settlement unavailable/);
  await registry.waitForIdle();
  await group.waitForIdle();
  assert.match(registry.getSnapshot().executions[0].lastError, /durable settlement/);
  await tick();
});

test("bounded deadline is observation only and does not evict active or unknown work", async () => {
  const registry = new MediaLocalExecutionRegistry({ completedLimit: 1 }), actual = deferred();
  const active = registry.getOrStart(binding), entered = registry.runTick(runInput(active), () => actual.promise);
  for (let index = 0; index < 4; index++) {
    const finished = registry.getOrStart({ ...binding, mediaJobId: `done-${index}` });
    await registry.runTick(runInput(finished), () => undefined);
    await finished.completion;
  }
  await assert.rejects(registry.waitForIdle(0), /have not drained/);
  assert.equal(registry.getSnapshot().retainedCompleted, 1);
  assert.equal(registry.getOrStart(runInput(active)), active);
  assert.equal(registry.getSnapshot().executions.filter(entry => entry.phase === "active").length, 1);
  actual.resolve();
  await entered;
  await active.completion;
  await registry.waitForIdle();
});

test("retention eviction and old generation cleanup never remove a new generation", async () => {
  const registry = new MediaLocalExecutionRegistry({ completedLimit: 1 });
  const first = registry.getOrStart(binding);
  await registry.runTick(runInput(first), () => undefined);
  await first.completion;
  const second = registry.getOrStart(binding), actual = deferred();
  const entered = registry.runTick(runInput(second), () => actual.promise);
  const unrelated = registry.getOrStart({ ...binding, mediaJobId: "other" });
  await registry.runTick(runInput(unrelated), () => undefined);
  await unrelated.completion;
  assert.throws(() => registry.cancelScheduled(first), /expired/);
  assert.equal(registry.getOrStart(runInput(second)), second);
  actual.resolve();
  await entered;
  await second.completion;
  await registry.waitForIdle();
});

test("shutdown guard runs before any new owner callback, and drain validates finite deadlines", async () => {
  const registry = new MediaLocalExecutionRegistry();
  registry.beginShutdown();
  assert.throws(() => registry.runTick(binding, () => assert.fail("must not reopen closed Store")), /shutdown/);
  for (const value of [-1, NaN, Infinity, 2_147_483_648]) await assert.rejects(registry.waitForIdle(value), /finite and non-negative/);
  await registry.waitForIdle();
  assert.throws(() => new MediaLocalExecutionRegistry({ completedLimit: -1 }), /non-negative/);
});

test("captured binding validation is read-only and requires every exact source/digest/tool/child identity", async () => {
  const { registry, group, reserve } = fixture();
  const handle = registry.bindNew(reserve(), binding);
  const persisted = { source, requestDigest: "digest", toolCallId: "media-call", workUnitId: "child-work" };
  const before = registry.getSnapshot();
  registry.assertCapturedBinding(handle, persisted);
  registry.assertCapturedBinding(handle, { ...persisted, source: { ...source } });
  assert.deepEqual(registry.getSnapshot(), before, "validation cannot reserve, start, release or mutate the local chain");
  for (const key of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    assert.throws(() => registry.assertCapturedBinding(handle, { ...persisted, source: { ...source, [key]: "replacement" } }),
      error => error instanceof MediaLocalExecutionAdmissionError && error.code === "captured_binding_mismatch");
    const incompleteSource = { ...source };
    delete incompleteSource[key];
    assert.throws(() => registry.assertCapturedBinding(handle, { ...persisted, source: incompleteSource }),
      error => error instanceof MediaLocalExecutionAdmissionError && error.code === "captured_binding_invalid");
  }
  for (const key of ["requestDigest", "toolCallId", "workUnitId"]) {
    assert.throws(() => registry.assertCapturedBinding(handle, { ...persisted, [key]: "replacement" }),
      error => error instanceof MediaLocalExecutionAdmissionError && error.code === "captured_binding_mismatch");
    const incomplete = { ...persisted };
    delete incomplete[key];
    assert.throws(() => registry.assertCapturedBinding(handle, incomplete),
      error => error instanceof MediaLocalExecutionAdmissionError && error.code === "captured_binding_invalid");
  }
  for (const incomplete of [undefined, null, {}, { ...persisted, source: undefined }]) {
    assert.throws(() => registry.assertCapturedBinding(handle, incomplete), error => error instanceof MediaLocalExecutionAdmissionError);
  }
  assert.deepEqual(registry.getSnapshot(), before);
  assert.equal(group.getSnapshot().writers.length, 1);
  registry.beginShutdown();
  await handle.completion;
  group.close();
  await group.waitForIdle();
  await registry.waitForIdle();
});

test("captured binding validation rejects standalone, clones, foreign/new-process and completed generations", async () => {
  const { registry, reserve } = fixture();
  const persisted = { source, requestDigest: "digest", toolCallId: "media-call", workUnitId: "child-work" };
  const handle = registry.bindNew(reserve(), binding);
  const otherProcess = new MediaLocalExecutionRegistry();
  const standalone = otherProcess.getOrStart(binding);
  assert.throws(() => registry.assertCapturedBinding({ ...handle }, persisted), error => error instanceof MediaLocalExecutionAdmissionError);
  assert.throws(() => otherProcess.assertCapturedBinding(handle, persisted), error => error instanceof MediaLocalExecutionAdmissionError);
  assert.throws(() => otherProcess.assertCapturedBinding(standalone, persisted),
    error => error instanceof MediaLocalExecutionAdmissionError && error.code === "captured_binding_mismatch");
  assert.throws(() => registry.assertCapturedBinding({ ...persisted, mediaJobId: binding.mediaJobId }, persisted),
    error => error instanceof MediaLocalExecutionAdmissionError);
  await registry.runTick(runInput(handle), () => undefined);
  await handle.completion;
  assert.throws(() => registry.assertCapturedBinding(handle, persisted),
    error => error instanceof MediaLocalExecutionAdmissionError && error.code === "completed");
  otherProcess.beginShutdown();
  await standalone.completion;
  await otherProcess.waitForIdle();
});

test("real workspace symlink joins the same job owner while different real workspaces remain isolated", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-media-local-workspace-alias-"));
  const registry = new MediaLocalExecutionRegistry(), actual = deferred(), otherActual = deferred();
  t.after(async () => {
    actual.resolve();
    otherActual.resolve();
    registry.beginShutdown();
    await registry.waitForIdle();
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "workspace"), alias = join(root, "workspace-alias"), sibling = join(root, "sibling");
  await Promise.all([mkdir(cwd), mkdir(sibling)]);
  await symlink(cwd, alias, "dir");
  const handle = registry.getOrStart({ cwd, mediaJobId: "same-job" });
  assert.equal(handle.cwd, await realpath(cwd));
  assert.equal(registry.getOrStart({ cwd: alias, mediaJobId: "same-job" }), handle);
  let sameOwnerCalls = 0, siblingOwnerCalls = 0;
  const entered = registry.runTick({ cwd, mediaJobId: "same-job", execution: handle }, () => {
    sameOwnerCalls++;
    return actual.promise;
  });
  const joined = registry.runTick({ cwd: alias, mediaJobId: "same-job" }, () => {
    sameOwnerCalls++;
    assert.fail("path alias must not start a second paid submit");
  });
  assert.equal(joined, entered);
  const siblingHandle = registry.getOrStart({ cwd: sibling, mediaJobId: "same-job" });
  assert.notEqual(siblingHandle.generation, handle.generation);
  const siblingEntered = registry.runTick({ cwd: sibling, mediaJobId: "same-job", execution: siblingHandle }, () => {
    siblingOwnerCalls++;
    return otherActual.promise;
  });
  assert.equal(sameOwnerCalls, 1);
  assert.equal(siblingOwnerCalls, 1);
  assert.equal(registry.getSnapshot().executions.length, 2);
  actual.resolve("first workspace");
  otherActual.resolve("second workspace");
  assert.equal(await entered, "first workspace");
  assert.equal(await joined, "first workspace");
  assert.equal(await siblingEntered, "second workspace");
  await Promise.all([handle.completion, siblingHandle.completion]);
  await registry.waitForIdle();
});
