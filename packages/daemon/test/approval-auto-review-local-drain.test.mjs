import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createApprovalAutoReviewCoordinator } from "../dist/features/runs/approval-auto-review-coordinator.js";
import { executeApprovalAutoReviewModel } from "../dist/features/runs/approval-auto-review-executor.js";
import { AttemptLocalWriterGroup } from "../dist/runtime/attempt-local-writers.js";

const approve = '{"schemaVersion":1,"decision":"approve","reason":"Scoped check."}';
const source = Object.freeze({ runId: "review-source", workUnitId: "source-work", attemptId: "source-attempt",
  runtimeInstanceId: "source-runtime", fencingToken: "source-token" });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function reviewerInput(runner, localWriters) {
  return { runner, localWriters, provider: { provider: "fixture", model: "fixture" }, cwd: "/workspace/project",
    approvalId: "approval-local-drain", evidenceFingerprint: "a".repeat(64), serializedEvidence: '{"schemaVersion":1}' };
}

for (const settlement of ["resolve", "reject"]) {
  test(`manual cancellation retains its physical scheduler slot until late ${settlement}`, async t => {
    const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxQueued: 1, deadlineMs: 1000 });
    const underlying = deferred();
    t.after(() => underlying.resolve(approve));
    const abort = new AbortController();
    let firstCalls = 0, nextCalls = 0;
    const first = coordinator.review({ signal: abort.signal, execute: () => { firstCalls++; return underlying.promise; } });
    abort.abort();
    const fallback = await first;
    assert.equal(fallback.code, "cancelled");
    assert.equal(fallback.attempts, 1);
    assert.equal(firstCalls, 1);
    await tick();
    const next = coordinator.review({ execute: async () => { nextCalls++; return approve; } });
    await tick();
    assert.equal(nextCalls, 0, "manual response does not free a physically pending execution slot");
    const overflow = await coordinator.review({ execute: () => assert.fail("overflow must not dispatch") });
    assert.equal(overflow.code, "queue_full");
    underlying[settlement](settlement === "resolve" ? approve : new Error("late provider cleanup failed"));
    assert.equal((await next).status, "resolved");
    assert.equal(nextCalls, 1);
    await tick(); // Late rejection must be observed, including after logical fallback.
  });
}

test("deadline fallback stays prompt while the underlying slot remains bounded", async t => {
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxQueued: 0, deadlineMs: 10 });
  const underlying = deferred();
  t.after(() => underlying.resolve(approve));
  const pending = coordinator.review({ execute: () => underlying.promise });
  await delay(25);
  const fallback = await pending;
  assert.equal(fallback.code, "deadline_exceeded");
  assert.equal(fallback.attempts, 1);
  await tick();
  assert.equal((await coordinator.review({ execute: () => assert.fail("pending timeout must still occupy the slot") })).code, "queue_full");
  underlying.resolve(approve);
  await tick();
  assert.equal((await coordinator.review({ execute: async () => approve })).status, "resolved");
});

test("a completed review through an async Host wrapper frees a zero-queue slot before the next invocation", async () => {
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxQueued: 0, deadlineMs: 1000 });
  async function hostReview() {
    const outcome = await coordinator.review({ execute: async () => approve });
    return outcome;
  }
  assert.equal((await hostReview()).status, "resolved");
  assert.equal((await hostReview()).status, "resolved", "settled execution must not create a false queue_full through Host await");
});

test("the actual reviewer reserves before dispatch and cancellation cannot release its local writer", async t => {
  const group = new AttemptLocalWriterGroup(source);
  const underlying = deferred();
  t.after(() => underlying.resolve({ messages: [{ role: "assistant", content: approve }] }));
  const abort = new AbortController();
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxQueued: 1, deadlineMs: 1000 });
  let calls = 0;
  const runner = { runTask(options) {
    calls++;
    assert.equal(group.getSnapshot().writers.length, 1, "producer admission precedes the real Runner call");
    assert.equal(options.signal.aborted, false);
    return underlying.promise;
  } };
  const pending = coordinator.review({ signal: abort.signal,
    execute: signal => executeApprovalAutoReviewModel({ ...reviewerInput(runner, group), signal }) });
  assert.equal(calls, 1);
  abort.abort();
  assert.equal((await pending).code, "cancelled");
  group.close();
  await assert.rejects(group.waitForIdle(0), /have not drained/);
  assert.equal(group.getSnapshot().writers.length, 1);
  underlying.reject(new Error("cleanup complete with provider error"));
  await group.waitForIdle(100);
  assert.deepEqual(group.getSnapshot().writers, []);
  await tick();
});

test("closed local admission rejects execution before any Runner dispatch", async () => {
  const group = new AttemptLocalWriterGroup(source);
  group.close();
  let calls = 0;
  await assert.rejects(executeApprovalAutoReviewModel(reviewerInput({ runTask: async () => { calls++; return { messages: [] }; } }, group)),
    /admission is closed/);
  assert.equal(calls, 0);
  await group.waitForIdle();
});

test("an already-aborted execution releases only its own producer without dispatch", async () => {
  const group = new AttemptLocalWriterGroup(source);
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await assert.rejects(executeApprovalAutoReviewModel({ ...reviewerInput({ runTask() { calls++; } }, group), signal: abort.signal }),
    error => error.name === "AbortError");
  assert.equal(calls, 0);
  assert.deepEqual(group.getSnapshot().writers, []);
  group.close();
  await group.waitForIdle();
});

test("every admitted retry has a distinct producer and settles the prior one first", async () => {
  const group = new AttemptLocalWriterGroup(source);
  const tickets = [];
  const reserve = group.reserve.bind(group);
  group.reserve = label => { const finish = reserve(label); tickets.push(finish); return finish; };
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxTransientRetries: 1, deadlineMs: 1000 });
  let calls = 0;
  const runner = { runTask() {
    calls++;
    assert.equal(group.getSnapshot().writers.length, 1, "a completed retry cannot leave its writer behind");
    if (calls === 1) throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    return Promise.resolve({ messages: [{ role: "assistant", content: approve }] });
  } };
  const outcome = await coordinator.review({ execute: signal => executeApprovalAutoReviewModel({ ...reviewerInput(runner, group), signal }) });
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.attempts, 2);
  assert.equal(calls, 2);
  assert.equal(tickets.length, 2);
  assert.notEqual(tickets[0], tickets[1]);
  assert.deepEqual(group.getSnapshot().writers, []);
  group.close();
  await group.waitForIdle();
});

test("a pending second retry resets physical settlement and retains its writer and slot after abort", { timeout: 1000 }, async t => {
  const group = new AttemptLocalWriterGroup(source);
  const abort = new AbortController();
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxQueued: 1, maxTransientRetries: 1, deadlineMs: 1000 });
  const underlying = deferred(), secondStarted = deferred();
  t.after(() => underlying.resolve({ messages: [{ role: "assistant", content: approve }] }));
  let calls = 0, nextCalls = 0;
  const runner = { runTask() {
    calls++;
    assert.equal(group.getSnapshot().writers.length, 1);
    if (calls === 1) throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    secondStarted.resolve();
    return underlying.promise;
  } };
  const pending = coordinator.review({ signal: abort.signal,
    execute: signal => executeApprovalAutoReviewModel({ ...reviewerInput(runner, group), signal }) });
  await secondStarted.promise;
  abort.abort();
  const fallback = await pending;
  assert.equal(fallback.code, "cancelled");
  assert.equal(fallback.attempts, 2);
  assert.equal(calls, 2);
  group.close();
  await assert.rejects(group.waitForIdle(0), /have not drained/);
  const next = coordinator.review({ execute: async () => { nextCalls++; return approve; } });
  await tick();
  assert.equal(nextCalls, 0, "the first retry's settled flag must not release the pending second retry");
  underlying.reject(new Error("second retry cleanup rejected"));
  await group.waitForIdle(100);
  assert.equal((await next).status, "resolved");
  assert.equal(nextCalls, 1);
  assert.deepEqual(group.getSnapshot().writers, []);
  await tick();
});

test("transient retry uses a fresh producer and closure forbids a second dispatch", async () => {
  const group = new AttemptLocalWriterGroup(source);
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxTransientRetries: 1, deadlineMs: 1000 });
  const underlying = deferred();
  const tickets = [];
  const reserve = group.reserve.bind(group);
  group.reserve = label => { const finish = reserve(label); tickets.push(finish); return finish; };
  let calls = 0;
  const runner = { runTask() { calls++; return underlying.promise; } };
  const pending = coordinator.review({ execute: signal => executeApprovalAutoReviewModel({ ...reviewerInput(runner, group), signal }) });
  group.close();
  underlying.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }));
  const outcome = await pending;
  assert.equal(outcome.code, "execution_failed");
  assert.equal(outcome.attempts, 2);
  assert.equal(calls, 1, "the closed source cannot dispatch the scheduled retry");
  assert.equal(tickets.length, 1);
  await group.waitForIdle();
});

test("synchronous abort inside execute still observes its late rejection", async () => {
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxQueued: 0, deadlineMs: 1000 });
  const abort = new AbortController();
  const underlying = deferred();
  const pending = coordinator.review({ signal: abort.signal, execute: () => { abort.abort(); return underlying.promise; } });
  assert.equal((await pending).code, "cancelled");
  assert.equal((await coordinator.review({ execute: () => assert.fail("late rejection still owns its slot") })).code, "queue_full");
  underlying.reject(new Error("late SDK dispose rejection"));
  await tick();
  assert.equal((await coordinator.review({ execute: async () => approve })).status, "resolved");
  await tick();
});

test("synchronous Runner failure and output validation failure both release the actual producer", async () => {
  const group = new AttemptLocalWriterGroup(source);
  await assert.rejects(executeApprovalAutoReviewModel(reviewerInput({ runTask() { throw new Error("sync transport failure"); } }, group)),
    /sync transport failure/);
  assert.deepEqual(group.getSnapshot().writers, []);
  await assert.rejects(executeApprovalAutoReviewModel(reviewerInput({ runTask: async () => ({ messages: [] }) }, group)),
    error => error.code === "empty_output");
  assert.deepEqual(group.getSnapshot().writers, []);
  group.close();
  await group.waitForIdle();
});

test("queue cancellation and expiry never invoke execute or reserve a writer", async t => {
  const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxQueued: 2, deadlineMs: 20 });
  const underlying = deferred();
  t.after(() => underlying.resolve(approve));
  const activeAbort = new AbortController(), queuedAbort = new AbortController();
  const first = coordinator.review({ signal: activeAbort.signal, execute: () => underlying.promise });
  const group = new AttemptLocalWriterGroup(source);
  let calls = 0;
  const queuedExecute = signal => executeApprovalAutoReviewModel({ ...reviewerInput({ runTask() { calls++; return Promise.resolve({ messages: [] }); } }, group), signal });
  const queued = coordinator.review({ signal: queuedAbort.signal, execute: queuedExecute });
  const expired = coordinator.review({ execute: queuedExecute });
  queuedAbort.abort();
  assert.equal((await queued).code, "cancelled");
  await delay(35);
  const expiry = await expired;
  assert.equal(expiry.code, "deadline_exceeded");
  assert.equal(expiry.attempts, 0);
  assert.equal((await first).code, "deadline_exceeded");
  assert.equal(calls, 0);
  assert.deepEqual(group.getSnapshot().writers, []);
  group.close();
  await group.waitForIdle();
});
