import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

test("stale WorkUnit discovery reaches a real SQLite row beyond the first 500, including equal timestamps", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-recovery-discovery-pagination-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const createdAt = "2026-10-01T00:00:00.000Z";
  for (let index = 0; index < 501; index += 1) {
    store.createWorkUnit({
      id: `discovery-unit-${String(index).padStart(4, "0")}`,
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "conversation_run",
      ownerType: "conversation_turn",
      ownerId: "discovery-fixture-turn",
      idempotencyKey: `discovery-fixture-${index}`,
      status: "stale",
      createdByActor: "system",
      request: {},
      now: createdAt,
    });
  }
  const options = { kind: "conversation_run", status: "stale", limit: 500 };
  const first = store.listWorkUnits(options);
  assert.equal(first.length, 500);
  assert.equal(first[0].id, "discovery-unit-0500");
  const last = first.at(-1);
  const second = store.listWorkUnits({
    ...options,
    after: { createdAt: last.createdAt, id: last.id },
    createdAtOrBefore: createdAt,
  });
  assert.deepEqual(second.map((row) => row.id), ["discovery-unit-0000"],
    "A bounded scan must advance past the first page rather than repeatedly returning the same 500 rows.");
  assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 501);
});

const earlier = "2026-10-01T00:00:00.000Z";
const cutoff = "2026-10-01T00:01:00.000Z";
const later = "2026-10-01T00:02:00.000Z";
const scanNow = "2026-10-01T00:03:00.000Z";

for (const kind of ["task_run", "teammate_direct_reply"]) {
  test(`${kind} discovery advances beyond 500 equal-timestamp SQLite rows and reaches an empty tail`, async (t) => {
    const f = await fixture(t);
    for (let index = 0; index < 501; index += 1) {
      createWorkUnit(f, `unit-${String(index).padStart(4, "0")}`, earlier, { kind });
    }
    const options = { kind, status: "stale", limit: 500, createdAtOrBefore: earlier };
    const first = f.store.listWorkUnits(options);
    assert.equal(first.length, 500);
    assert.equal(first[0].id, "unit-0500");
    const second = f.store.listWorkUnits({ ...options, after: workUnitCursor(first.at(-1)) });
    assert.deepEqual(second.map((row) => row.id), ["unit-0000"]);
    assert.deepEqual(f.store.listWorkUnits({ ...options, after: workUnitCursor(second[0]) }), []);
    assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 501);
    assert.deepEqual(f.store.listWorkUnits(options).map((row) => row.id), first.map((row) => row.id),
      "A fresh discovery sweep can restart from the bounded head.");
  });
}

test("scheduled continuation discovery reaches row 501 with ascending tuple ties and persists across reopen", async (t) => {
  const f = await continuationFixture(t);
  for (let index = 0; index < 501; index += 1) {
    prepareContinuation(f, `scheduled-${String(index).padStart(4, "0")}`, earlier, earlier);
  }
  const options = { now: scanNow, scheduledOnly: true, limit: 500, createdAtOrBefore: earlier };
  const first = f.store.listClaimableRunnerContinuations(options);
  assert.equal(first.length, 500);
  assert.equal(first[0].id, "scheduled-0000");
  assert.equal(first.at(-1).id, "scheduled-0499");
  const after = continuationCursor(first.at(-1));
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  const second = f.store.listClaimableRunnerContinuations({ ...options, after });
  assert.deepEqual(second.map((row) => row.id), ["scheduled-0500"]);
  assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 501);
  assert.deepEqual(f.store.listClaimableRunnerContinuations({ ...options, after: continuationCursor(second[0]) }), []);
  assert.deepEqual(f.store.listClaimableRunnerContinuations(options).map((row) => row.id), first.map((row) => row.id));
});

test("WorkUnit discovery freezes creation cutoff without dropping descending time/id ties or filters", async (t) => {
  const f = await fixture(t);
  createWorkUnit(f, "tie-b", cutoff);
  createWorkUnit(f, "tie-a", cutoff);
  createWorkUnit(f, "older", earlier);
  createWorkUnit(f, "other-kind", cutoff, { kind: "task_run" });
  createWorkUnit(f, "other-status", cutoff, { status: "queued" });
  createWorkUnit(f, "other-owner", cutoff, { ownerId: "other-owner" });
  const options = { kind: "conversation_run", status: "stale", ownerId: "discovery-owner", limit: 1, createdAtOrBefore: cutoff };
  const first = f.store.listWorkUnits(options);
  assert.deepEqual(first.map((row) => row.id), ["tie-b"]);
  createWorkUnit(f, "new-after-sweep", later);
  const second = f.store.listWorkUnits({ ...options, after: workUnitCursor(first[0]) });
  assert.deepEqual(second.map((row) => row.id), ["tie-a"]);
  const third = f.store.listWorkUnits({ ...options, after: workUnitCursor(second[0]) });
  assert.deepEqual(third.map((row) => row.id), ["older"]);
  assert.deepEqual(f.store.listWorkUnits({ ...options, after: workUnitCursor(third[0]) }), []);
  assert.deepEqual(f.store.listWorkUnits({ ...options, createdAtOrBefore: later }).map((row) => row.id), ["new-after-sweep"]);
});

test("continuation discovery uses due/creation/id order, unscheduled fallback and a frozen creation cutoff", async (t) => {
  const f = await continuationFixture(t);
  prepareContinuation(f, "unscheduled", earlier);
  prepareContinuation(f, "due-b", earlier, later);
  prepareContinuation(f, "due-a", earlier, later);
  prepareContinuation(f, "created-later", cutoff, later);
  prepareContinuation(f, "not-due", earlier, "2026-10-01T00:04:00.000Z");
  const options = { now: scanNow, limit: 1, createdAtOrBefore: cutoff };
  const first = f.store.listClaimableRunnerContinuations(options);
  assert.deepEqual(first.map((row) => row.id), ["unscheduled"]);
  prepareContinuation(f, "new-after-sweep", later, later);
  const ids = first.map((row) => row.id);
  let after = continuationCursor(first[0]);
  for (let page = 0; page < 3; page += 1) {
    const rows = f.store.listClaimableRunnerContinuations({ ...options, after });
    assert.equal(rows.length, 1);
    ids.push(rows[0].id);
    after = continuationCursor(rows[0]);
  }
  assert.deepEqual(ids, ["unscheduled", "due-a", "due-b", "created-later"]);
  assert.deepEqual(f.store.listClaimableRunnerContinuations({ ...options, after }), []);
  assert.deepEqual(f.store.listClaimableRunnerContinuations({ ...options, scheduledOnly: true, limit: 500 }).map((row) => row.id),
    ["due-a", "due-b", "created-later"]);
  assert.deepEqual(f.store.listClaimableRunnerContinuations({ ...options, createdAtOrBefore: later, limit: 500 }).map((row) => row.id),
    ["unscheduled", "due-a", "due-b", "created-later", "new-after-sweep"]);
});

test("a due-time change behind the cursor is rediscovered on the next bounded sweep", async (t) => {
  const f = await continuationFixture(t);
  const firstPrepared = prepareContinuation(f, "first", earlier, cutoff);
  const secondPrepared = prepareContinuation(f, "second", earlier, later);
  const options = { now: scanNow, scheduledOnly: true, limit: 1, createdAtOrBefore: cutoff };
  const first = f.store.listClaimableRunnerContinuations(options);
  assert.deepEqual(first.map((row) => row.id), [firstPrepared.id]);
  assert.equal(f.store.deferRunnerContinuation({ continuationId: secondPrepared.id, expectedRevision: secondPrepared.revision,
    now: earlier, nextAttemptAt: earlier }).ok, true);
  assert.deepEqual(f.store.listClaimableRunnerContinuations({ ...options, after: continuationCursor(first[0]) }), []);
  assert.deepEqual(f.store.listClaimableRunnerContinuations(options).map((row) => row.id), [secondPrepared.id],
    "Discovery is not a durable authority snapshot; a wrapped sweep rechecks mutable due times.");
});

test("discovery retains eligibility predicates and old bounded no-cursor reads", async (t) => {
  const f = await continuationFixture(t);
  const claimed = prepareContinuation(f, "claimed", earlier, earlier);
  prepareContinuation(f, "eligible", earlier, earlier);
  prepareContinuation(f, "future", earlier, "2026-10-01T00:04:00.000Z");
  assert.equal(f.store.claimRunnerContinuation({ continuationId: claimed.id, expectedRevision: claimed.revision,
    claimOwner: "fixture-daemon", claimToken: "fixture-claim", claimExpiresAt: "2026-10-01T00:05:00.000Z", now: scanNow }).ok, true);
  assert.deepEqual(f.store.listClaimableRunnerContinuations({ now: scanNow, scheduledOnly: true }).map((row) => row.id), ["eligible"]);
  for (const limit of [0, 501, 1.5, NaN, Infinity]) {
    assert.throws(() => f.store.listClaimableRunnerContinuations({ now: scanNow, limit }), /between 1 and 500/u);
  }
  assert.throws(() => f.store.listClaimableRunnerContinuations({ now: "not-a-time" }), /canonical UTC/u);
  for (let index = 0; index < 501; index += 1) createWorkUnit(f, `bounded-${String(index).padStart(4, "0")}`, earlier);
  assert.equal(f.store.listWorkUnits({ status: "stale", limit: 900 }).length, 500);
  assert.equal(f.store.listWorkUnits({ status: "stale", limit: 0 }).length, 1);
});

test("discovery rejects malformed cursor/cutoff boundaries and binds ids as data", async (t) => {
  const f = await fixture(t);
  const invalidTimes = ["", "2026-10-01", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00.000+00:00",
    "2026-02-30T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", null, 1];
  for (const timestamp of invalidTimes) {
    assert.throws(() => f.store.listWorkUnits({ createdAtOrBefore: timestamp }), /canonical UTC/u);
    assert.throws(() => f.store.listWorkUnits({ after: { createdAt: timestamp, id: "unit" } }), /canonical UTC/u);
    assert.throws(() => f.store.listClaimableRunnerContinuations({ now: scanNow, createdAtOrBefore: timestamp }), /canonical UTC/u);
    assert.throws(() => f.store.listClaimableRunnerContinuations({ now: scanNow, after: { dueAt: timestamp, createdAt: earlier, id: "continuation" } }), /canonical UTC/u);
    assert.throws(() => f.store.listClaimableRunnerContinuations({ now: scanNow, after: { dueAt: earlier, createdAt: timestamp, id: "continuation" } }), /canonical UTC/u);
  }
  for (const id of ["", " ", " unit", "unit ", "unit\0tail", "x".repeat(1025), null, 1]) {
    assert.throws(() => f.store.listWorkUnits({ after: { createdAt: earlier, id } }), /cursor id/u);
    assert.throws(() => f.store.listClaimableRunnerContinuations({ now: scanNow, after: { dueAt: earlier, createdAt: earlier, id } }), /cursor id/u);
  }
  for (const after of [null, "cursor", 1, {}, []]) {
    assert.throws(() => f.store.listWorkUnits({ after }), /discovery|canonical UTC/u);
    assert.throws(() => f.store.listClaimableRunnerContinuations({ now: scanNow, after }), /discovery|canonical UTC/u);
  }
  createWorkUnit(f, "unit-a", earlier);
  createWorkUnit(f, "unit-z", earlier);
  assert.deepEqual(f.store.listWorkUnits({ status: "stale", after: { createdAt: earlier, id: "unit-b' OR 1=1 --" } }).map((row) => row.id), ["unit-a"]);
  assert.equal(f.store.listWorkUnits({ status: "stale" }).length, 2);
});

function workUnitCursor(row) {
  return { createdAt: row.createdAt, id: row.id };
}

function continuationCursor(row) {
  return { dueAt: row.nextAttemptAt ?? row.createdAt, createdAt: row.createdAt, id: row.id };
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-recovery-discovery-pagination-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  t.after(async () => {
    f.store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return f;
}

function createWorkUnit(f, id, now, overrides = {}) {
  return f.store.createWorkUnit({ id, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
    ownerType: "conversation_turn", ownerId: "discovery-owner", idempotencyKey: id, status: "stale",
    createdByActor: "system", request: {}, now, ...overrides });
}

async function continuationFixture(t) {
  const f = await fixture(t);
  const channel = f.store.createChannel({ name: "Recovery discovery", boundPath: f.cwd }, earlier);
  f.task = f.store.createTask({ channelId: channel.id, title: "Recovery discovery", prompt: "Fixture only" }, earlier);
  const sourceUnit = createWorkUnit(f, "source-unit", earlier, { kind: "task_run", ownerType: "run",
    ownerId: "source-run", status: "succeeded" });
  f.sourceAttempt = f.store.createWorkUnitAttempt({ id: "source-attempt", workUnitId: sourceUnit.id,
    attemptNumber: 1, runtimeInstanceId: "source-runtime", runnerId: "runner_pi_embedded", status: "succeeded", now: earlier });
  const sourceRun = f.store.createRun({ id: "source-run", cwd: f.cwd, taskId: f.task.id, workUnitId: sourceUnit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {},
    contextViewId: "source-context", contextViewCreatedAt: earlier, createdAt: earlier });
  f.store.linkRunToWorkUnit(sourceRun.id, sourceUnit.id, earlier);
  f.store.markRunSucceeded(sourceRun.id, earlier);
  return f;
}

function prepareContinuation(f, id, createdAt, dueAt) {
  const unit = createWorkUnit(f, `${id}-unit`, createdAt, { kind: "task_run", ownerType: "run",
    ownerId: `${id}-run`, status: "queued" });
  const run = f.store.createRun({ id: `${id}-run`, cwd: f.cwd, taskId: f.task.id, workUnitId: unit.id,
    parentRunId: "source-run", providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
    requestSnapshot: {}, contextViewId: `${id}-context`, contextViewCreatedAt: createdAt, createdAt });
  f.store.linkRunToWorkUnit(run.id, unit.id, createdAt);
  const artifact = f.store.createArtifact({ id: `${id}-artifact`, runId: run.id, type: "json", path: `fixture/${id}.json`,
    sealedPayload: { contextViewId: run.contextViewId }, createdAt });
  const prepared = f.store.prepareContinuationAndAttempt({ id, runId: run.id, workUnitId: unit.id,
    sourceFence: toRuntimeAttemptFence(f.sourceAttempt), expectedTargetAttemptId: null, origin: "queued_followup",
    strategy: "deterministic_replay", runnerId: "runner_pi_embedded", runnerCapabilityRevision: "pi:fixture",
    contextViewId: run.contextViewId, contextSnapshotArtifactId: artifact.id, idempotencyKey: id, generation: 0,
    targetAttempt: { id: `${id}-attempt`, runtimeInstanceId: `${id}-runtime`, runnerId: "runner_pi_embedded",
      effectiveRunnerId: "runner_pi_embedded" }, now: createdAt });
  if (dueAt === undefined) return prepared.continuation;
  const deferred = f.store.deferRunnerContinuation({ continuationId: id, expectedRevision: prepared.continuation.revision,
    now: createdAt, nextAttemptAt: dueAt });
  assert.equal(deferred.ok, true);
  return deferred.value;
}
