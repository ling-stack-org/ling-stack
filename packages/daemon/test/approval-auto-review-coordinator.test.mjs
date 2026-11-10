import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApprovalAutoReviewCoordinator,
} from "../dist/features/runs/approval-auto-review-coordinator.js";

const approve = '{"schemaVersion":1,"decision":"approve","reason":"The exact scoped check is necessary."}';
const deny = '{"schemaVersion":1,"decision":"deny","reason":"The action exceeds the requested workspace scope."}';
const manual = '{"schemaVersion":1,"decision":"manual","reason":"The evidence does not prove the destination."}';

test("automatic review coordinator accepts approve and deny without retrying a verdict", async () => {
  const coordinator = createApprovalAutoReviewCoordinator({
    maxConcurrent: 1,
    maxQueued: 2,
    deadlineMs: 1_000,
    maxTransientRetries: 1,
  });
  let approveCalls = 0;
  const approved = await coordinator.review({
    execute: async () => {
      approveCalls += 1;
      return approve;
    },
  });
  assert.equal(approved.status, "resolved");
  assert.equal(approved.verdict.decision, "approve");
  assert.equal(approved.attempts, 1);
  assert.equal(approveCalls, 1);

  let denyCalls = 0;
  const denied = await coordinator.review({
    execute: async () => {
      denyCalls += 1;
      return deny;
    },
  });
  assert.equal(denied.status, "resolved");
  assert.equal(denied.verdict.decision, "deny");
  assert.equal(denied.attempts, 1);
  assert.equal(denyCalls, 1);
});

test("automatic review coordinator sends manual and invalid output to a human without retrying", async () => {
  const coordinator = createApprovalAutoReviewCoordinator({
    maxConcurrent: 1,
    maxQueued: 2,
    deadlineMs: 1_000,
    maxTransientRetries: 2,
  });
  let manualCalls = 0;
  const manualResult = await coordinator.review({
    execute: async () => {
      manualCalls += 1;
      return manual;
    },
  });
  assert.deepEqual(manualResult, {
    status: "manual",
    code: "reviewer_manual",
    reason: "The evidence does not prove the destination.",
    attempts: 1,
  });
  assert.equal(manualCalls, 1);

  let invalidCalls = 0;
  const invalidResult = await coordinator.review({
    execute: async () => {
      invalidCalls += 1;
      return "approve";
    },
  });
  assert.equal(invalidResult.status, "manual");
  assert.equal(invalidResult.code, "invalid_output");
  assert.equal(invalidResult.attempts, 1);
  assert.equal(invalidCalls, 1);
});

for (const [label, decision] of [
  ["approve array", ["approve"]], ["deny array", ["deny"]], ["manual array", ["manual"]],
  ["nested approve array", [["approve"]]], ["nested manual array", [["manual"]]],
  ["object", { decision: "deny" }], ["null", null],
  ["non-callable toString object", { toString: "deny" }],
]) {
  test(`A22 automatic review coordinator keeps malformed ${label} manual without retry`, async () => {
    const coordinator = createApprovalAutoReviewCoordinator({ maxConcurrent: 1, maxTransientRetries: 2, deadlineMs: 1_000 });
    let calls = 0;
    const result = await coordinator.review({ execute: async () => {
      calls += 1;
      return JSON.stringify({ schemaVersion: 1, decision, reason: "Scoped decision." });
    } });
    assert.equal(result.status, "manual");
    assert.equal(result.code, "invalid_output");
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1, "invalid model output must not consume a transport retry");
  });
}

test("automatic review coordinator retries only a transient transport failure", async () => {
  const coordinator = createApprovalAutoReviewCoordinator({
    maxConcurrent: 1,
    maxQueued: 2,
    deadlineMs: 1_000,
    maxTransientRetries: 1,
  });
  let calls = 0;
  const result = await coordinator.review({
    execute: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("fetch failed: socket hang up");
        error.code = "ECONNRESET";
        throw error;
      }
      return approve;
    },
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);

  let permanentCalls = 0;
  const permanent = await coordinator.review({
    execute: async () => {
      permanentCalls += 1;
      throw new Error("invalid api key");
    },
  });
  assert.equal(permanent.status, "manual");
  assert.equal(permanent.code, "execution_failed");
  assert.equal(permanent.attempts, 1);
  assert.equal(permanentCalls, 1);
});

test("automatic review coordinator applies one deadline across queueing and retries", { timeout: 2_000 }, async t => {
  // Production has an active Host/Runner. This Promise-only fixture needs its
  // own bounded live handle; the coordinator deadline deliberately stays unref'ed.
  const liveHandle = setTimeout(() => {}, 1_000);
  t.after(() => clearTimeout(liveHandle));
  const coordinator = createApprovalAutoReviewCoordinator({
    maxConcurrent: 1,
    maxQueued: 2,
    deadlineMs: 25,
    maxTransientRetries: 3,
  });
  const result = await coordinator.review({
    execute: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  assert.equal(result.status, "manual");
  assert.equal(result.code, "deadline_exceeded");
  assert.equal(result.attempts, 1);
});

test("automatic review coordinator bounds the process queue and cancels queued work", async () => {
  const coordinator = createApprovalAutoReviewCoordinator({
    maxConcurrent: 1,
    maxQueued: 1,
    deadlineMs: 1_000,
    maxTransientRetries: 0,
  });
  const activeAbort = new AbortController();
  const queuedAbort = new AbortController();
  const block = (signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });

  const active = coordinator.review({ execute: block, signal: activeAbort.signal });
  const queued = coordinator.review({ execute: async () => approve, signal: queuedAbort.signal });
  const overflow = await coordinator.review({ execute: async () => approve });
  assert.deepEqual(overflow, {
    status: "manual",
    code: "queue_full",
    reason: "Automatic review queue is full; manual approval is required.",
    attempts: 0,
  });

  queuedAbort.abort();
  const cancelledQueued = await queued;
  assert.equal(cancelledQueued.status, "manual");
  assert.equal(cancelledQueued.code, "cancelled");
  assert.equal(cancelledQueued.attempts, 0);

  activeAbort.abort();
  const cancelledActive = await active;
  assert.equal(cancelledActive.status, "manual");
  assert.equal(cancelledActive.code, "cancelled");
  assert.equal(cancelledActive.attempts, 1);
});
