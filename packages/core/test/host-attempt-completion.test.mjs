import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const now = "2026-10-15T00:00:00.000Z";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-completion-"));
  const store = createSqliteRunStore(cwd);
  const reopened = [];
  t.after(async () => { for (const reader of reopened) reader.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime",
    runnerId: "pi", status: "started", now });
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, taskId: "task", providerName: "fixture",
    providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
  const reopen = () => { const reader = createSqliteRunStore(cwd); reopened.push(reader); return reader; };
  return { cwd, store, unit, attempt, run, source, reopen };
}

test("original Host lifetime is pending until its real promise settles and survives SQLite reopen", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  const pending = f.reopen().getHostAttemptCompletion(f.source);
  assert.deepEqual(pending.source, f.source);
  assert.equal(pending.schemaVersion, 1);
  assert.equal(pending.drainedAt, undefined);
  lifetime.resolve();
  const completed = await completion;
  assert.ok(completed.drainedAt);
  assert.deepEqual(f.reopen().getHostAttemptCompletion(f.source), completed);
  assert.deepEqual(Object.keys(completed).sort(), ["drainedAt", "registeredAt", "schemaVersion", "source"]);
});

test("logical cancellation and a reopened registry cannot complete a pending Host lifetime", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  f.store.database.prepare("UPDATE run_sessions SET status='cancelled',ended_at=? WHERE id=?").run(now, f.run.id);
  f.store.database.prepare("UPDATE work_unit_attempts SET status='cancelled',ended_at=? WHERE id=?").run(now, f.attempt.id);
  f.store.database.prepare("UPDATE work_units SET status='cancelled' WHERE id=?").run(f.unit.id);
  assert.equal(f.reopen().getHostAttemptCompletion(f.source).drainedAt, undefined);
  lifetime.resolve();
  assert.ok((await completion).drainedAt, "original fact may settle after logical cancellation");
});

test("rejected Host execution is still an ended local lifetime, not successful execution or effect proof", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  lifetime.reject(new Error("controlled execution failure"));
  const fact = await completion;
  assert.ok(fact.drainedAt);
  assert.equal(f.store.getRun(f.run.id).status, "running", "observation does not transition a Run");
  assert.equal("effects" in fact, false);
});

for (const field of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`mismatched ${field} cannot register or read another Host source`, async t => {
    const f = await fixture(t), wrong = { ...f.source, [field]: "wrong-source" };
    assert.throws(() => f.store.trackHostAttemptCompletion(wrong, Promise.resolve()), /host_attempt_completion_invalid_source/);
    assert.equal(f.store.getHostAttemptCompletion(wrong), undefined);
    assert.equal(f.store.getHostAttemptCompletion(f.source), undefined);
  });
}

test("the original pending observation cannot be replaced by another callback or a restart", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  assert.throws(() => f.store.trackHostAttemptCompletion(f.source, Promise.resolve()), /host_attempt_completion_already_registered/);
  assert.throws(() => f.reopen().trackHostAttemptCompletion(f.source, Promise.resolve()), /host_attempt_completion_already_registered/);
  assert.equal(f.store.getHostAttemptCompletion(f.source).drainedAt, undefined);
  lifetime.resolve();
  await completion;
});

test("late completion records only the original Attempt and cannot complete a successor", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor", runnerId: "pi", status: "started", now });
  const next = { runId: f.run.id, ...toRuntimeAttemptFence(successor) };
  lifetime.resolve();
  assert.ok((await completion).drainedAt);
  assert.equal(f.reopen().getHostAttemptCompletion(next), undefined);
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, successor.id);
});

test("changed source linkage during execution prevents a durable completion fact", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  f.store.database.prepare("UPDATE work_unit_attempts SET fencing_token='replacement' WHERE id=?").run(f.attempt.id);
  lifetime.resolve();
  await assert.rejects(completion, /host_attempt_completion_invalid_source/);
  assert.equal(f.reopen().getHostAttemptCompletion(f.source), undefined);
  assert.equal(f.store.database.prepare("SELECT drained_at FROM host_attempt_completions").get().drained_at, null);
});

test("failed completion commit leaves the observation pending without partial terminal facts", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  f.store.database.exec("CREATE TABLE completion_commit_fault (id TEXT REFERENCES run_sessions(id) DEFERRABLE INITIALLY DEFERRED)");
  f.store.database.exec("CREATE TRIGGER fail_completion_commit AFTER UPDATE ON host_attempt_completions"
    + " BEGIN INSERT INTO completion_commit_fault VALUES ('missing-run'); END");
  lifetime.resolve();
  await assert.rejects(completion, /FOREIGN KEY/);
  assert.equal(f.reopen().getHostAttemptCompletion(f.source).drainedAt, undefined);
  assert.equal(f.store.database.isTransaction, false);
});

test("completion identity and the first drained timestamp are immutable", async t => {
  const f = await fixture(t);
  await f.store.trackHostAttemptCompletion(f.source, Promise.resolve());
  const before = f.store.getHostAttemptCompletion(f.source);
  assert.throws(() => f.store.database.exec("UPDATE host_attempt_completions SET runtime_instance_id='other'"), /immutable/);
  assert.throws(() => f.store.database.exec("UPDATE host_attempt_completions SET drained_at=NULL"), /immutable/);
  assert.deepEqual(f.reopen().getHostAttemptCompletion(f.source), before);
});

test("an ended original built-in read inventory permits cancelled resource cleanup after reopen", async t => {
  const f = await fixture(t);
  await resources(f);
  const observation = { schemaVersion: 1, toolCallIds: ["read-call"],
    settledBuiltinReads: [{ toolCallId: "read-call", toolName: "read" }] };
  await f.store.trackHostAttemptCompletion(f.source, Promise.resolve(), () => observation);
  f.store.database.prepare("UPDATE run_sessions SET status='cancelled',ended_at=? WHERE id=?").run(now, f.run.id);
  f.store.database.prepare("UPDATE work_unit_attempts SET status='cancelled',ended_at=? WHERE id=?").run(now, f.attempt.id);
  f.store.database.prepare("UPDATE work_units SET status='cancelled' WHERE id=?").run(f.unit.id);
  const reopened = f.reopen();
  assert.equal(reopened.getHostAttemptCompletion(f.source).effectCoverage, "pi_tracked_tools_v1");
  reopened.releaseHostAttemptResources(f.source, new Date().toISOString());
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
});

for (const invalid of [
  { toolCallIds: ["read-call", "unsettled"], settledBuiltinReads: [{ toolCallId: "read-call", toolName: "read" }] },
  { toolCallIds: ["read-call"], settledBuiltinReads: [{ toolCallId: "read-call", toolName: "bash" }] },
  { toolCallIds: ["read-call"], settledBuiltinReads: [{ toolCallId: "other", toolName: "read" }] },
  { toolCallIds: ["read-call"], settledBuiltinReads: [{ toolCallId: "read-call", toolName: "read" }, { toolCallId: "read-call", toolName: "read" }] },
]) test("incomplete or conflicting built-in read coverage cannot certify resource cleanup", async t => {
  const f = await fixture(t);
  await f.store.trackHostAttemptCompletion(f.source, Promise.resolve(), () => ({ schemaVersion: 1, ...invalid }));
  assert.equal(f.store.getHostAttemptCompletion(f.source).effectCoverage, undefined);
});

test("migration self-heals a missing completion table without backfilling historical proof", async t => {
  const f = await fixture(t);
  await f.store.trackHostAttemptCompletion(f.source, Promise.resolve());
  f.store.database.exec("DROP TABLE host_attempt_completions");
  const reopened = f.reopen();
  assert.equal(reopened.getHostAttemptCompletion(f.source), undefined);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM host_attempt_completions").get().count, 0);
});

async function resources(f) {
  assert.ok(f.store.acquireResourceLease({ ...f.source, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel",
    resourceKey: `owned-channel-${f.attempt.id}`, ownerType: "work_unit_attempt", ownerId: f.attempt.id, acquiredAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z" }));
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ ...f.source, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
    resourceKey: "pi", limit: 2, ownerType: "work_unit_attempt", ownerId: f.attempt.id, acquiredAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z" }));
}

test("deferred cleanup waits for durable drain and atomically releases only original resources", async t => {
  const f = await fixture(t), lifetime = deferred();
  await resources(f);
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  f.store.releaseHostAttemptResources(f.source, now);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  lifetime.resolve(); await completion;
  f.store.markRunSucceeded(f.run.id, now);
  f.store.database.exec("CREATE TRIGGER fail_resource_release BEFORE UPDATE ON runtime_semaphore_slots"
    + " BEGIN SELECT RAISE(ABORT,'controlled resource release failure'); END");
  assert.throws(() => f.store.releaseHostAttemptResources(f.source, now), /controlled resource release failure/);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1, "the first release rolls back too");
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
  f.store.database.exec("DROP TRIGGER fail_resource_release");
  f.reopen().releaseHostAttemptResources(f.source, now);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
  f.store.releaseHostAttemptResources(f.source, now);
});

test("deferred original cleanup cannot release successor resources", async t => {
  const f = await fixture(t), lifetime = deferred();
  await resources(f);
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise);
  const successor = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor", runnerId: "pi", status: "started", now });
  const next = { ...f, attempt: successor, source: { runId: f.run.id, ...toRuntimeAttemptFence(successor) } };
  await resources(next);
  lifetime.resolve(); await completion;
  f.store.markRunSucceeded(f.run.id, now);
  f.store.releaseHostAttemptResources(f.source, now);
  assert.equal(f.store.listResourceLeases({ status: "active", attemptId: successor.id }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 2);
});

test("Host-verified no-tool coverage is persisted only with the original durable drain", async t => {
  const f = await fixture(t), lifetime = deferred();
  let verified = false;
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise, () => verified);
  assert.equal(f.reopen().getHostAttemptCompletion(f.source).effectCoverage, undefined);
  verified = true; lifetime.resolve();
  const fact = await completion;
  assert.equal(fact.effectCoverage, "pi_no_tools_v1");
  assert.deepEqual(f.reopen().getHostAttemptCompletion(f.source), fact);
});

test("a failed no-tool verifier cannot persist partial completion or release resources", async t => {
  const f = await fixture(t), lifetime = deferred();
  await resources(f);
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime.promise, () => { throw new Error("observation unavailable"); });
  lifetime.resolve(); await assert.rejects(completion, /observation unavailable/);
  const fact = f.reopen().getHostAttemptCompletion(f.source);
  assert.equal(fact.drainedAt, undefined);
  assert.equal(fact.effectCoverage, undefined);
  f.store.releaseHostAttemptResources(f.source, now);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
});

for (const inventory of [[], ["invented-tool"], ["duplicate", "duplicate"], [null]]) {
  test(`a closed tool inventory without original durable executor receipts cannot prove effect coverage: ${JSON.stringify(inventory)}`, async t => {
    const f = await fixture(t);
    const fact = await f.store.trackHostAttemptCompletion(f.source, Promise.resolve(), () => inventory);
    assert.ok(fact.drainedAt);
    assert.equal(fact.effectCoverage, undefined);
    assert.equal(f.reopen().getHostAttemptCompletion(f.source).effectCoverage, undefined);
  });
}

test("durable local drain cannot release a still-owned nonterminal source", async t => {
  const f = await fixture(t);
  await resources(f);
  await f.store.trackHostAttemptCompletion(f.source, Promise.resolve(), () => true);
  f.store.releaseHostAttemptResources(f.source, now);
  assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
});

for (const status of ["succeeded", "failed"]) {
  for (const phase of ["admitted", "unknown_outcome"]) {
    test(`${status} completion cannot release a registered source with ${phase} Host effects`, async t => {
      const f = await fixture(t);
      await resources(f);
      const ticket = f.store.admitHostOperation({ operationId: "owned-effect", source: f.source,
        kind: "plugin", toolCallId: "owned-tool", admittedAt: now });
      if (phase === "unknown_outcome") {
        f.store.launchHostOperation(ticket, () => undefined);
        f.store.settleHostOperation(ticket, { kind: "unknown_outcome", code: "controlled_receipt_loss" });
      }
      await f.store.trackHostAttemptCompletion(f.source, Promise.resolve());
      if (status === "succeeded") f.store.markRunSucceeded(f.run.id, now);
      else f.store.markRunFailed(f.run.id, now, "controlled failure");
      const reopened = f.reopen();
      reopened.releaseHostAttemptResources(f.source, new Date().toISOString());
      assert.equal(reopened.expireResourceLeases("2099-01-02T00:00:00.000Z"), 0);
      assert.equal(reopened.expireRuntimeSemaphoreSlots("2099-01-02T00:00:00.000Z"), 0);
      assert.equal(f.store.listResourceLeases({ status: "active" }).length, 1);
      assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 1);
    });
  }

  test(`${status} ordinary completion preserves existing cleanup without certifying untracked effects`, async t => {
    const f = await fixture(t);
    await resources(f);
    await f.store.trackHostAttemptCompletion(f.source, Promise.resolve());
    if (status === "succeeded") f.store.markRunSucceeded(f.run.id, now);
    else f.store.markRunFailed(f.run.id, now, "controlled failure");
    f.reopen().releaseHostAttemptResources(f.source, now);
    assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
    assert.equal(f.store.getHostAttemptCompletion(f.source).effectCoverage, undefined);
  });
}
