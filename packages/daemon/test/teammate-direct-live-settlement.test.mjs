import assert from "node:assert/strict";
import test from "node:test";
import { settleTeammateDirectMessage } from "../dist/features/teammates/direct-message-lifecycle.js";

const fence = { workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "token" };

/** Lifecycle unit ports only; real SQLite admission/recovery is covered by separate integration files. */
function fixture() {
  const message = { id: "reply", workspaceId: "workspace", teammateId: "engineer", threadId: "private",
    authorType: "ai-teammate", authorId: "engineer", linkedRunId: "run", body: "", status: "pending" };
  const run = { id: "run", teammateId: "engineer", threadId: "canonical", status: "failed", errorMessage: "actual failure" };
  const turn = { id: "turn", threadId: "canonical", teammateId: "engineer" };
  const attempt = { id: fence.attemptId, workUnitId: fence.workUnitId,
    runtimeInstanceId: fence.runtimeInstanceId, fencingToken: fence.fencingToken, status: "failed" };
  const commits = [];
  const store = {
    readSnapshot: read => read(), getTeammateDirectMessage: () => message,
    getTeammateDirectMessageRuntimeObservation: scope => ({ scope, message, run, turn, attempt,
      state: { kind: "terminal", status: "failed" }, fingerprint: "fixture-terminal", lastRunEventSeq: 0 }),
    getRun: () => run,
    getLingThread: () => ({ id: "canonical", kind: "teammate_direct", teammateId: "engineer" }),
    getLingTurnForRun: () => turn, listLingTurnRuns: () => [{ turnId: turn.id, runId: run.id }],
    listTeammateDirectThreads: () => [{ id: "private", teammateId: "engineer" }],
    listEvents: () => [],
    commitTeammateDirectMessageRuntime(input) { commits.push(input); return { kind: "applied", message: { ...message, ...input.operation.patch } }; },
  };
  return { message, attempt, store, commits };
}

test("A28 live settlement without a captured fence cannot borrow terminal Host authority", () => {
  const f = fixture();
  const result = settleTeammateDirectMessage(f.store, f.message, { runId: "run", requireSourceFence: true });
  assert.equal(result.terminal, false);
  assert.deepEqual(f.commits, []);
  assert.equal(f.message.status, "pending");
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`A28 late live settlement with foreign ${field} cannot finalize a successor`, () => {
    const f = fixture();
    const result = settleTeammateDirectMessage(f.store, f.message, { runId: "run", requireSourceFence: true,
      sourceFence: { ...fence, [field]: "foreign" } });
    assert.equal(result.terminal, false);
    assert.deepEqual(f.commits, []);
    assert.equal(f.message.status, "pending");
  });
}

for (const status of ["lost", "yielded"]) {
  test(`A28 a ${status} live source cannot finalize even with the same full fence`, () => {
    const f = fixture();
    f.attempt.status = status;
    const result = settleTeammateDirectMessage(f.store, f.message, { runId: "run", requireSourceFence: true, sourceFence: fence });
    assert.equal(result.terminal, false);
    assert.deepEqual(f.commits, []);
  });
}

test("A28 current live settlement and Host terminal reconciliation use their explicit authorities", () => {
  for (const options of [{ runId: "run", requireSourceFence: true, sourceFence: fence }, { runId: "run" }]) {
    const f = fixture();
    const result = settleTeammateDirectMessage(f.store, f.message, options);
    assert.equal(result.terminal, true);
    assert.equal(result.message.status, "failed");
    assert.equal(result.message.errorMessage, "actual failure");
    assert.equal(f.commits.length, 1);
    assert.equal(f.commits[0].operation.kind, "reconcile");
  }
});
