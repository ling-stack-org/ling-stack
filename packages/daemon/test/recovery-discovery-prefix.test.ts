import assert from "node:assert/strict";
import test from "node:test";
import type { ListRunsOptions, RunStore } from "@ling-stack/core";
import { readPreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { isRecord } from "../dist/shared/validation.js";
import { createRecoveryDiscoveryFixture } from "./test-support/recovery-discovery-fixture.mjs";

test("500 stale blockers retain durable ownership without growing thread metadata reads", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "prefix-cost");
  const valid = await fixture.seedRun("conversation", "a-valid");
  const { run: validRun, unit: validUnit } = valid;
  assert.ok(validRun);
  assert.ok(validUnit);
  const validRunId = validRun.id;
  const validUnitId = validUnit.id;
  const listRuns = fixture.store.listRuns.bind(fixture.store);
  let largestRead = 0;
  let reads = 0;
  t.mock.method(fixture.store, "listRuns", (options: ListRunsOptions = {}) => {
    const runs = listRuns(options);
    largestRead = Math.max(largestRead, runs.length);
    reads += 1;
    return runs;
  });
  fixture.seedBlockedStalePrefix(valid);
  assert.ok(reads > 0, "seeding must still exercise real thread metadata rebuilding");
  assert.equal(largestRead, 1, "one blocker's writes must not reread earlier blockers");

  function assertPrefix(store: RunStore, targetStatus: "running" | "failed"): void {
    const blockers = store.listWorkUnits({ kind: "conversation_run", status: "stale", limit: 500 });
    assert.equal(blockers.length, 500);
    assert.ok(blockers.every(unit => unit.id !== validUnitId));
    const last = blockers[blockers.length - 1];
    assert.deepEqual(store.listWorkUnits({ kind: "conversation_run", status: "stale", limit: 500,
      after: { createdAt: last.createdAt, id: last.id } }).map(unit => unit.id), [validUnitId]);
    const threads = new Set<string>();
    const turns = new Set<string>();
    for (const unit of blockers) {
      const run = store.getRun(`run-${unit.id.slice("unit-".length)}`);
      assert.ok(run?.threadId);
      const turn = store.getLingTurnForRun(run.id);
      assert.ok(turn);
      assert.ok(isRecord(run.requestSnapshot));
      assert.equal(run.status, "cancelled");
      assert.equal(run.workUnitId, unit.id);
      assert.equal(unit.ownerId, turn.id);
      assert.equal(run.requestSnapshot.threadId, run.threadId);
      assert.equal(run.requestSnapshot.turnId, turn.id);
      assert.equal(turn.threadId, run.threadId);
      assert.equal(store.listWorkUnitAttempts(unit.id)[0]?.status, "lost");
      assert.notEqual(run.threadId, valid.thread.id);
      assert.deepEqual(run.taskSnapshot, valid.execution.input.task);
      assert.equal(readPreparedRunnerInput(run.requestSnapshot.runnerExecutionInput,
        { cwd: run.cwd, task: valid.execution.input.task }).preparedInput.fingerprint, valid.execution.preparedInput.fingerprint);
      threads.add(run.threadId);
      turns.add(turn.id);
    }
    assert.equal(threads.size, 500);
    assert.equal(turns.size, 500);
    assert.equal(store.getRun(validRunId)?.status, targetStatus);
  }
  assertPrefix(fixture.store, "running");
  // RunStoreRegistry reconciles the unfinished target on reopen, not cancelled blockers.
  assertPrefix(fixture.reopenAfterRestart().store, "failed");
});
