import assert from "node:assert/strict";
import test from "node:test";
import type { ListRunsOptions, RunStore } from "@ling-stack/core";
import { readPreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { isRecord } from "../dist/shared/validation.js";
import { createRecoveryDiscoveryFixture } from "./test-support/recovery-discovery-fixture.mjs";

test("500 stale blockers retain shared ownership with one bounded thread metadata read", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "prefix-cost");
  const valid = await fixture.seedRun("conversation", "a-valid");
  const { run: validRun, unit: validUnit } = valid;
  assert.ok(validRun);
  assert.ok(validUnit);
  const { id: validRunId, requestSnapshot: validRequestSnapshot } = validRun;
  const { id: validUnitId, ownerType: validOwnerType, ownerId: validOwnerId } = validUnit;
  const validTurn = fixture.store.getLingTurnForRun(validRunId);
  assert.ok(validTurn);
  const validTurnId = validTurn.id;
  const listRuns = fixture.store.listRuns.bind(fixture.store);
  let totalRowsRead = 0;
  let reads = 0;
  t.mock.method(fixture.store, "listRuns", (options: ListRunsOptions = {}) => {
    const runs = listRuns(options);
    totalRowsRead += runs.length;
    reads += 1;
    return runs;
  });
  fixture.seedBlockedStalePrefix(valid);
  assert.equal(reads, 1, "shared-thread source writes must flush one final metadata rebuild");
  assert.equal(totalRowsRead, 200, "the final projection reads the production-capped Run window only once");

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
      const turn = store.getLingTurn(unit.ownerId);
      assert.ok(turn);
      assert.ok(isRecord(run.requestSnapshot));
      assert.equal(run.status, "cancelled");
      assert.equal(run.workUnitId, unit.id);
      assert.equal(unit.linkedRunId, run.id);
      assert.equal(unit.ownerType, validOwnerType);
      assert.equal(unit.ownerId, validOwnerId);
      assert.equal(unit.ownerId, turn.id);
      assert.equal(turn.id, validTurnId);
      assert.equal(run.requestSnapshot.threadId, run.threadId);
      assert.equal(run.requestSnapshot.turnId, turn.id);
      assert.equal(turn.threadId, run.threadId);
      const attempts = store.listWorkUnitAttempts(unit.id);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].id, `attempt-${unit.id.slice("unit-".length)}`);
      assert.equal(attempts[0].workUnitId, unit.id);
      assert.equal(attempts[0].status, "lost");
      assert.equal(unit.activeAttemptId, attempts[0].id);
      assert.equal(run.threadId, valid.thread.id);
      // Blockers retain the source snapshot, not a new Turn-Run execution link.
      assert.equal(store.getLingTurnForRun(run.id), undefined);
      assert.deepEqual(run.requestSnapshot, validRequestSnapshot);
      assert.deepEqual(run.taskSnapshot, valid.execution.input.task);
      assert.equal(readPreparedRunnerInput(run.requestSnapshot.runnerExecutionInput,
        { cwd: run.cwd, task: valid.execution.input.task }).preparedInput.fingerprint, valid.execution.preparedInput.fingerprint);
      threads.add(run.threadId);
      turns.add(turn.id);
    }
    assert.deepEqual([...threads], [valid.thread.id]);
    assert.deepEqual([...turns], [validTurnId]);
    assert.deepEqual(store.listLingTurnRuns(validTurnId).map(link => link.runId), [validRunId]);
    assert.equal(store.getLingTurnForRun(validRunId)?.id, validTurnId);
    assert.equal(store.getRun(validRunId)?.status, targetStatus);
  }
  assertPrefix(fixture.store, "running");
  // RunStoreRegistry reconciles the unfinished target on reopen, not cancelled blockers.
  assertPrefix(fixture.reopenAfterRestart().store, "failed");
});
