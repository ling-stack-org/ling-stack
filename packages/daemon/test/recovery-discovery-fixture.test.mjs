import assert from "node:assert/strict";
import test from "node:test";
import { readPreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { createRecoveryDiscoveryFixture, DISCOVERY_CREATED_AT, DISCOVERY_DUE_AT,
  seedScheduledBlockedPrefix } from "./test-support/recovery-discovery-fixture.mjs";

function recordMetadataWrites(t, store) {
  const writes = [];
  const prepare = store.database.prepare.bind(store.database);
  t.mock.method(store.database, "prepare", (sql) => {
    if (sql === "UPDATE ling_threads SET metadata_json = ? WHERE id = ?") writes.push(sql);
    return prepare(sql);
  });
  return writes;
}

test("stale prefix coalesces metadata rebuilds while persisting all 500 Runs and lost Attempts", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "fixture-stale");
  const valid = await fixture.seedRun("conversation", "a-valid");
  const metadata = fixture.store.lingThreadMetadata;
  const rebuild = metadata.rebuildLingThreadMetadata;
  const writes = recordMetadataWrites(t, fixture.store);
  fixture.seedBlockedStalePrefix(valid);
  assert.equal(writes.length, 1, "one final derived projection, not one rebuild per source write");
  assert.equal(metadata.rebuildLingThreadMetadata, rebuild);
  const before = fixture.store.getLingThread(valid.thread.id);
  assert.equal(fixture.store.getRun(valid.run.id).status, "running");
  assert.deepEqual(before, fixture.store.rebuildLingThreadMetadata(valid.thread.id, DISCOVERY_CREATED_AT),
    "batched projection must equal a fresh production rebuild before startup reconciliation");
  const { store } = fixture.reopenAfterRestart();
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM work_units").get().count, 501);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM run_sessions").get().count, 501);
  const units = store.listWorkUnits({ kind: valid.unit.kind, status: "stale", limit: 500 });
  assert.equal(units.length, 500);
  for (const unit of units) {
    assert.match(unit.id, /^unit-z-blocked-conversation_run-\d{4}$/);
    assert.equal(unit.ownerType, valid.unit.ownerType);
    assert.equal(unit.ownerId, valid.unit.ownerId);
    assert.equal(unit.taskId, valid.unit.taskId);
    assert.equal(unit.activeAttemptId, `attempt-${unit.id.slice("unit-".length)}`);
    assert.deepEqual(store.listWorkUnitAttempts(unit.id).map(attempt => attempt.status), ["lost"]);
    const run = store.getRun(unit.linkedRunId);
    assert.equal(run.status, "cancelled");
    assert.equal(run.workUnitId, unit.id);
    assert.equal(run.threadId, valid.thread.id);
    assert.deepEqual(run.requestSnapshot, valid.run.requestSnapshot);
  }
  const reopenedThread = store.getLingThread(valid.thread.id);
  assert.deepEqual(reopenedThread, store.rebuildLingThreadMetadata(valid.thread.id, reopenedThread.metadata.rebuiltAt),
    "batched projection must equal a fresh production rebuild after reopen");
});

test("scheduled prefix coalesces metadata rebuilds without caching policy or frozen Pi inputs", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "fixture-scheduled");
  const metadata = fixture.store.lingThreadMetadata;
  const rebuild = metadata.rebuildLingThreadMetadata;
  const writes = recordMetadataWrites(t, fixture.store);
  await seedScheduledBlockedPrefix(fixture);
  assert.equal(writes.length, 500, "each distinct Thread receives its final projection once");
  assert.equal(metadata.rebuildLingThreadMetadata, rebuild);
  const { store } = fixture.reopenAfterRestart();
  const continuations = store.listClaimableRunnerContinuations({ now: DISCOVERY_DUE_AT, scheduledOnly: true, limit: 500 });
  assert.equal(continuations.length, 500);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM work_units").get().count, 500);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM run_sessions").get().count, 500);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM work_unit_attempts").get().count, 1000);
  const fingerprints = new Set();
  const threadIds = new Set();
  for (const continuation of continuations) {
    assert.equal(continuation.state, "prepared");
    assert.equal(continuation.nextAttemptAt, DISCOVERY_DUE_AT);
    const unit = store.getWorkUnit(continuation.workUnitId);
    const run = store.getRun(continuation.runId);
    assert.equal(unit.status, "queued");
    assert.equal(run.status, "cancelled");
    assert.equal(unit.linkedRunId, run.id);
    assert.equal(run.workUnitId, unit.id);
    assert.equal(unit.activeAttemptId, continuation.targetAttemptId);
    assert.deepEqual(store.listWorkUnitAttempts(unit.id).map(attempt => attempt.status), ["lost", "created"]);
    const turn = store.getLingTurnForRun(run.id);
    assert.equal(unit.ownerId, turn.id);
    assert.equal(turn.threadId, run.threadId);
    assert.equal(turn.status, "cancelled");
    const execution = readPreparedRunnerInput(run.requestSnapshot.runnerExecutionInput, { cwd: run.cwd, task: run.taskSnapshot });
    assert.equal(execution.preparedInput.taskId, run.taskId);
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.workspaceAccessMode, "workspace_write");
    fingerprints.add(execution.preparedInput.fingerprint);
    threadIds.add(run.threadId);
    assert.deepEqual(store.getLingThread(run.threadId), store.rebuildLingThreadMetadata(run.threadId, DISCOVERY_CREATED_AT));
  }
  assert.equal(fingerprints.size, 500, "every Run retains its own SDK-prepared task input");
  assert.equal(threadIds.size, 500);
});

test("stale prefix restores metadata rebuilding and leaves no transaction open when a source write throws", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "fixture-stale-throw");
  const valid = await fixture.seedRun("conversation", "a-valid");
  const metadata = fixture.store.lingThreadMetadata;
  const rebuild = metadata.rebuildLingThreadMetadata;
  const createRun = fixture.store.createRun.bind(fixture.store);
  const failure = new Error("fixture-source-write-failed");
  const mocked = t.mock.method(fixture.store, "createRun", (input) => {
    if (input.id.endsWith("0001")) throw failure;
    return createRun(input);
  });
  assert.throws(() => fixture.seedBlockedStalePrefix(valid), error => error === failure);
  assert.equal(metadata.rebuildLingThreadMetadata, rebuild);
  assert.equal(fixture.store.database.isTransaction, false);
  mocked.mock.restore();
  const next = await fixture.seedRun("conversation", "after-failed-prefix");
  assert.equal(fixture.store.getLingThread(next.thread.id).metadata.lastTurnId, fixture.store.getLingTurnForRun(next.run.id).id);
  const before = fixture.store.getLingThread(valid.thread.id);
  assert.deepEqual(before, fixture.store.rebuildLingThreadMetadata(valid.thread.id, DISCOVERY_CREATED_AT));
});

test("scheduled prefix restores metadata rebuilding after asynchronous input preparation rejects", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "fixture-scheduled-throw");
  const metadata = fixture.store.lingThreadMetadata;
  const rebuild = metadata.rebuildLingThreadMetadata;
  const seedRun = fixture.seedRun;
  const failure = new Error("fixture-input-preparation-failed");
  const mocked = t.mock.method(fixture, "seedRun", async (...args) => {
    if (args[1].endsWith("0001")) throw failure;
    return seedRun(...args);
  });
  await assert.rejects(seedScheduledBlockedPrefix(fixture), error => error === failure);
  assert.equal(metadata.rebuildLingThreadMetadata, rebuild);
  assert.equal(fixture.store.database.isTransaction, false);
  mocked.mock.restore();
  const { store } = fixture.reopenAfterRestart();
  const continuations = store.listClaimableRunnerContinuations({ now: DISCOVERY_DUE_AT, scheduledOnly: true, limit: 500 });
  assert.equal(continuations.length, 1);
  const run = store.getRun(continuations[0].runId);
  assert.equal(run.status, "cancelled");
  assert.deepEqual(store.getLingThread(run.threadId), store.rebuildLingThreadMetadata(run.threadId, DISCOVERY_CREATED_AT));
});
