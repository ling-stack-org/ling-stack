import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createSqliteRunStore } from "../dist/index.js";

const at = (tick) => new Date(Date.UTC(2026, 9, 14) + tick * 1_000).toISOString();
const ownerId = "teammate_builtin_engineer";

// Test-only source. Root's runner owns isolated execution and any fresh build.
// LING_A12_KEEP_FIXTURES=1 retains only each mkdtemp-owned root for DB evidence.
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a12-core-start-owner-"));
  const preserve = process.env.LING_A12_KEEP_FIXTURES === "1";
  if (preserve) t.diagnostic(`A12 Core retained fixture root: ${cwd}`);
  const f = { cwd };
  t.after(async () => {
    try { f.database?.close(); }
    finally {
      try { f.store?.close(); }
      finally { if (!preserve) await rm(cwd, { recursive: true, force: true }); }
    }
  });
  f.store = createSqliteRunStore(cwd);
  f.database = new DatabaseSync(f.store.paths.databasePath);
  f.database.exec("PRAGMA busy_timeout=1");
  f.channel = f.store.createChannel({ name: "A12 Core ownership", boundPath: cwd }, at(0));
  f.workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "A12 owned start",
    objective: "A current generation owns its Task, Run and exact lease", status: "ready", createdBy: "local-user" }, at(0));
  f.step = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Inspect owned input", prompt: "Read evidence.txt",
    toParticipantId: ownerId, toParticipantLabel: "Engineer", metadata: {
      policy: { onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true },
    } }, at(0));
  return f;
}

function expected(f) {
  const step = f.store.getChannelWorkflowStep(f.step.id);
  return { status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt };
}

function lease(f, tick = 1) {
  const result = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId,
    resourceType: "workflow_step", resourceKey: f.step.id, ownerType: "workflow_step", ownerId: f.step.id,
    acquiredAt: at(tick), expiresAt: at(tick + 3_600) });
  assert.ok(result);
  return result;
}

function beginInput(f, acquired, tick = 2) {
  return { workflowStepId: f.step.id, expected: expected(f), leaseId: acquired.id,
    task: { channelId: f.channel.id, title: "A12 generation Task", prompt: "Read evidence.txt", assigneeTeammateId: ownerId }, now: at(tick) };
}

function begin(f, acquired = lease(f), tick = 2) {
  const input = beginInput(f, acquired, tick);
  const result = f.store.beginChannelWorkflowStepStart(input);
  assert.equal(result.status, "begun", JSON.stringify(result));
  return { ...result, input, lease: acquired };
}

/** Real Task claim and Run/WorkUnit/activeAttempt links; no model or execution. */
function readyRun(f, generation, suffix = "B", { claim = true, unit = true, attempt = true, terminal = false } = {}) {
  const task = f.store.getTask(generation.task.id);
  const tick = Math.max(3, Math.floor((Date.parse(task.createdAt) - Date.parse(at(0))) / 1_000) + 1);
  if (claim && task.status === "todo") assert.equal(f.store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo",
    event: "claim", actor: "system", now: at(tick) }).ok, true);
  const runId = `a12-core-run-${suffix}`;
  const run = f.store.createRun({ id: runId, cwd: f.cwd, taskId: task.id, channelId: f.channel.id,
    teammateId: ownerId, workflowStepId: f.step.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: { cwd: f.cwd }, createdAt: at(tick) });
  let workUnit;
  if (unit) {
    workUnit = f.store.createWorkUnit({ id: `a12-core-unit-${suffix}`, workspaceId: f.channel.workspaceId,
      kind: "task_run", ownerType: "task", ownerId: task.id, taskId: task.id, channelId: f.channel.id, teammateId: ownerId,
      runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: `a12-core-unit-${suffix}`,
      createdByActor: "system", request: {}, now: at(tick) });
    f.store.linkRunToWorkUnit(run.id, workUnit.id, at(tick));
    if (attempt) f.store.createWorkUnitAttempt({ id: `a12-core-attempt-${suffix}`, workUnitId: workUnit.id,
      attemptNumber: 1, runtimeInstanceId: `a12-core-runtime-${suffix}`, runnerId: "pi", effectiveRunnerId: "pi", now: at(tick) });
  }
  if (terminal) {
    assert.equal(f.store.transitionRunStatus({ runId: run.id, event: "runner_started", actor: "runner", now: at(tick) }).ok, true);
    assert.equal(f.store.transitionRunStatus({ runId: run.id, event: "runner_succeeded", actor: "runner", now: at(tick + 1) }).ok, true);
  }
  return f.store.getRun(run.id);
}

function ready(f, generation, run, tick = 4) {
  return f.store.commitChannelWorkflowStepRunReady({ workflowStepId: f.step.id, owner: generation.owner, runId: run.id, now: at(tick) });
}

function settle(f, generation, tick = 5) {
  return f.store.settleChannelWorkflowStepStartFailure({ workflowStepId: f.step.id, owner: generation.owner,
    leaseId: generation.lease.id, blocker: "A12 owned startup failure", now: at(tick) });
}

/** Fixture-only raw rows expose partial audits and orphan Tasks, not just UI status. */
function snapshot(f) {
  return Object.fromEntries(["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions", "work_units",
    "work_unit_attempts", "resource_leases", "state_transition_events"].map((table) =>
    [table, f.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function exactLease(f, id) {
  return f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: f.step.id, limit: 100 }).find((entry) => entry.id === id);
}

test("A12 Core begin atomically installs one preparing generation and rejects an old basis from another Store", async (t) => {
  const f = await fixture(t);
  const acquired = lease(f);
  const input = beginInput(f, acquired);
  const other = createSqliteRunStore(f.cwd);
  try {
    const first = f.store.beginChannelWorkflowStepStart(input);
    assert.equal(first.status, "begun", JSON.stringify(first));
    const step = f.store.getChannelWorkflowStep(f.step.id);
    assert.equal(step.status, "running");
    assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "running");
    assert.equal(step.taskId, first.task.id);
    assert.equal(step.runId, undefined);
    assert.deepEqual(step.metadata.startOwner, first.owner);
    assert.equal(first.owner.phase, "preparing");
    assert.equal(first.owner.leaseId, acquired.id);
    const before = snapshot(f);
    assert.equal(other.beginChannelWorkflowStepStart(input).status, "stale");
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 1);
  } finally { other.close(); }
});

test("A12 Core concurrent begin uses SQLite CAS: only one worker creates the new Task", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const input = beginInput(f, lease(f));
  const source = `const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.moduleUrl).then(({ createSqliteRunStore }) => {
      const store = createSqliteRunStore(workerData.cwd);
      parentPort.once("message", () => {
        try { parentPort.postMessage({ type: "result", result: store.beginChannelWorkflowStepStart(workerData.input) }); }
        catch (error) { parentPort.postMessage({ type: "error", message: String(error) }); }
        finally { store.close(); }
      });
      parentPort.postMessage({ type: "ready" });
    }).catch(error => parentPort.postMessage({ type: "error", message: String(error) }));`;
  const data = { cwd: f.cwd, moduleUrl: new URL("../dist/index.js", import.meta.url).href, input };
  const workers = [new Worker(source, { eval: true, workerData: data }), new Worker(source, { eval: true, workerData: data })];
  try {
    await Promise.all(workers.map(async (worker) => {
      const [message] = await once(worker, "message", { signal: t.signal });
      assert.equal(message.type, "ready", JSON.stringify(message));
    }));
    const results = workers.map((worker) => once(worker, "message", { signal: t.signal }));
    workers.forEach((worker) => worker.postMessage("go"));
    const messages = (await Promise.all(results)).map(([message]) => message);
    assert.ok(messages.every((message) => message.type === "result"), JSON.stringify(messages));
    assert.deepEqual(messages.map((message) => message.result.status).sort(), ["begun", "stale"]);
    const winner = messages.find((message) => message.result.status === "begun").result;
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).taskId, winner.task.id);
    assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 1);
    assert.equal(exactLease(f, input.leaseId).status, "active");
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
});

for (const fault of ["task-insert", "owner-update"]) {
  test(`A12 Core begin rolls back workflow, step, audits and Task on ${fault} failure`, async (t) => {
    const f = await fixture(t);
    const input = beginInput(f, lease(f));
    const before = snapshot(f);
    const clause = fault === "task-insert" ? "BEFORE INSERT ON tasks" : "BEFORE UPDATE OF task_id ON channel_workflow_steps";
    f.database.exec(`CREATE TRIGGER a12_begin_fault ${clause} BEGIN SELECT RAISE(ABORT, 'A12_BEGIN_TRANSACTION_FAULT'); END`);
    assert.throws(() => f.store.beginChannelWorkflowStepStart(input), /A12_BEGIN_TRANSACTION_FAULT/);
    assert.deepEqual(snapshot(f), before);
    f.database.exec("DROP TRIGGER a12_begin_fault");
    assert.equal(f.store.beginChannelWorkflowStepStart(input).status, "begun");
    assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 1);
  });
}

test("A12 Core ready owns both Task and Step links and is durably idempotent after reopen", async (t) => {
  const f = await fixture(t);
  const generation = begin(f);
  const run = readyRun(f, generation);
  assert.equal(f.store.getTask(generation.task.id).currentRunId, undefined);
  assert.equal(ready(f, generation, run).status, "linked");
  assert.equal(f.store.getTask(generation.task.id).currentRunId, run.id);
  const linked = f.store.getChannelWorkflowStep(f.step.id);
  assert.equal(linked.runId, run.id);
  assert.equal(linked.metadata.startOwner.phase, "linked");
  assert.equal(linked.metadata.startOwner.taskId, generation.task.id);
  assert.equal(linked.metadata.startOwner.leaseId, generation.lease.id);
  const before = snapshot(f);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.equal(ready(f, generation, run, 6).status, "duplicate");
  assert.deepEqual(snapshot(f), before);
});

test("A12 Core ready rollback cannot leave Task.currentRunId linked while Step remains preparing", async (t) => {
  const f = await fixture(t);
  const generation = begin(f);
  const run = readyRun(f, generation);
  const before = snapshot(f);
  f.database.exec(`CREATE TRIGGER a12_ready_fault BEFORE UPDATE OF run_id ON channel_workflow_steps
    WHEN NEW.id='${f.step.id}' AND NEW.run_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'A12_READY_TRANSACTION_FAULT'); END`);
  assert.throws(() => ready(f, generation, run), /A12_READY_TRANSACTION_FAULT/);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.store.getTask(generation.task.id).currentRunId, undefined);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.startOwner.phase, "preparing");
  f.database.exec("DROP TRIGGER a12_ready_fault");
  assert.equal(ready(f, generation, run).status, "linked");
});

for (const invalid of ["unclaimed-task", "missing-unit", "missing-attempt", "terminal-run", "foreign-run", "sibling-run"]) {
  test(`A12 Core ready rejects ${invalid} without partial links or lease release`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    let run = readyRun(f, generation, "B", { claim: invalid !== "unclaimed-task", unit: invalid !== "missing-unit",
      attempt: invalid !== "missing-attempt", terminal: invalid === "terminal-run" });
    if (invalid === "foreign-run") {
      const foreign = f.store.createTask({ channelId: f.channel.id, title: "Other Task", prompt: "Other", assigneeTeammateId: ownerId }, at(3));
      run = readyRun(f, { task: foreign }, "foreign");
    }
    if (invalid === "sibling-run") readyRun(f, generation, "sibling");
    const before = snapshot(f);
    const result = ready(f, generation, run);
    assert.ok(["invalid", "stale"].includes(result.status), JSON.stringify(result));
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.store.getTask(generation.task.id).currentRunId, undefined);
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, undefined);
    assert.equal(exactLease(f, generation.lease.id).status, "active");
  });
}

test("A12 Core late B ready/failure cannot mutate replacement C or release C's exact lease", async (t) => {
  const f = await fixture(t);
  const b = begin(f);
  const runB = readyRun(f, b, "B");
  assert.equal(settle(f, b, 5).status, "linked");
  assert.equal(exactLease(f, b.lease.id).status, "released");
  const c = begin(f, lease(f, 6), 7);
  assert.notEqual(c.task.id, b.task.id);
  assert.notEqual(c.lease.id, b.lease.id);
  const before = snapshot(f);
  assert.equal(ready(f, b, runB, 8).status, "stale");
  assert.deepEqual(snapshot(f), before);
  assert.equal(settle(f, b, 8).status, "stale");
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).taskId, c.task.id);
  assert.equal(exactLease(f, c.lease.id).status, "active");
  assert.equal(f.store.getTask(c.task.id).currentRunId, undefined);
  const runC = readyRun(f, c, "C");
  assert.equal(ready(f, c, runC, 9).status, "linked");
  assert.equal(f.store.getTask(c.task.id).currentRunId, runC.id);
});

test("A12 Core failure settlement rolls back state and audits if exact lease release fails", async (t) => {
  const f = await fixture(t);
  const generation = begin(f);
  const unrelated = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workflow_step",
    resourceKey: "a12-unrelated-resource", ownerType: "system", ownerId: "a12-unrelated-owner", acquiredAt: at(1), expiresAt: at(3_601) });
  assert.ok(unrelated);
  const before = snapshot(f);
  f.database.exec(`CREATE TRIGGER a12_settle_fault BEFORE UPDATE OF status ON resource_leases
    WHEN OLD.id='${generation.lease.id}' AND NEW.status='released' BEGIN SELECT RAISE(ABORT, 'A12_SETTLE_TRANSACTION_FAULT'); END`);
  assert.throws(() => settle(f, generation), /A12_SETTLE_TRANSACTION_FAULT/);
  assert.deepEqual(snapshot(f), before);
  f.database.exec("DROP TRIGGER a12_settle_fault");
  assert.equal(settle(f, generation).status, "linked");
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "blocked");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "blocked");
  assert.equal(exactLease(f, generation.lease.id).status, "released");
  assert.equal(f.store.listResourceLeases({ resourceKey: "a12-unrelated-resource", limit: 100 })[0].status, "active");
  assert.equal(f.store.getTask(generation.task.id).currentRunId, undefined);
});

test("A12 Core pre-owner failure uses exact expected basis and cannot settle twice after lease release", async (t) => {
  const f = await fixture(t);
  const acquired = lease(f);
  const input = { workflowStepId: f.step.id, expected: expected(f), leaseId: acquired.id,
    blocker: "A12 preparation failed before Task", now: at(2) };
  assert.equal(f.store.settleChannelWorkflowStepStartFailure(input).status, "linked");
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "blocked");
  assert.equal(exactLease(f, acquired.id).status, "released");
  const before = snapshot(f);
  assert.equal(f.store.settleChannelWorkflowStepStartFailure(input).status, "stale");
  assert.deepEqual(snapshot(f), before);
});

test("A12 Core semantic authority drift rejects ready without changing either owned link", async (t) => {
  const f = await fixture(t);
  const generation = begin(f);
  const run = readyRun(f, generation);
  f.store.updateChannelWorkflowStep(f.step.id, { prompt: "Different authorized task definition" }, at(4));
  const before = snapshot(f);
  assert.equal(ready(f, generation, run, 5).status, "stale");
  assert.deepEqual(snapshot(f), before);
  assert.equal(exactLease(f, generation.lease.id).status, "active");
});

test("A12 Core expired lease rejects begin, ready and failure settlement without mutations", async (t) => {
  const f = await fixture(t);
  const acquired = lease(f);
  const input = beginInput(f, acquired);
  const initial = snapshot(f);
  assert.equal(f.store.beginChannelWorkflowStepStart({ ...input, now: at(3_602) }).status, "invalid");
  assert.deepEqual(snapshot(f), initial);
  const generation = begin(f, acquired);
  const run = readyRun(f, generation);
  const before = snapshot(f);
  assert.equal(ready(f, generation, run, 3_602).status, "stale");
  assert.equal(settle(f, generation, 3_602).status, "stale");
  assert.deepEqual(snapshot(f), before);
});

/** Match createQueuedRunForConflict plus its durable WorkUnit request producer. */
function queuedRun(f, generation, suffix = "queued-B", overrides = {}) {
  const task = f.store.getTask(generation.task.id);
  const tick = Math.max(3, Math.floor((Date.parse(task.createdAt) - Date.parse(at(0))) / 1_000) + 1);
  const runId = `a12-core-run-${suffix}`;
  const durableRequest = { cwd: f.cwd, workspaceCwd: f.cwd, task, workflowStepId: f.step.id, teammateId: ownerId };
  const requestSnapshot = Object.hasOwn(overrides, "snapshotValue") ? overrides.snapshotValue : {
    ...durableRequest, queued: true, queueReason: "resource_conflict", ...overrides.snapshot,
    task: { ...task, ...overrides.snapshotTask },
  };
  const request = Object.hasOwn(overrides, "requestValue") ? overrides.requestValue : {
    ...durableRequest, ...overrides.request, task: { ...task, ...overrides.requestTask },
  };
  const run = f.store.createRun({ id: runId, cwd: f.cwd, taskId: task.id, channelId: f.channel.id,
    teammateId: ownerId, workflowStepId: f.step.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot, createdAt: at(tick), ...overrides.run });
  const unit = f.store.createWorkUnit({ id: `a12-core-unit-${suffix}`, workspaceId: f.channel.workspaceId,
    kind: "task_run", ownerType: "task", ownerId: task.id, taskId: task.id, channelId: f.channel.id, teammateId: ownerId,
    runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: `a12-core-unit-${suffix}`, createdByActor: "user",
    request, now: at(tick), ...overrides.unit });
  f.store.linkRunToWorkUnit(run.id, unit.id, at(tick));
  const attempt = f.store.createWorkUnitAttempt({ id: `a12-core-attempt-${suffix}`, workUnitId: unit.id,
    attemptNumber: 1, runtimeInstanceId: `a12-core-runtime-${suffix}`, runnerId: "pi", effectiveRunnerId: "pi",
    now: at(tick), ...overrides.attempt });
  return { run: f.store.getRun(run.id), unit: f.store.getWorkUnit(unit.id), attempt };
}

/** All durable tables, read through the fixture's independent SQLite connection. */
function queuedSnapshot(f) {
  return Object.fromEntries(f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, f.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]));
}

function queuedReady(f, generation, queued, input = {}) {
  return f.store.commitChannelWorkflowStepRunReady({ workflowStepId: f.step.id, owner: generation.owner,
    runId: queued.run.id, claimQueuedTask: true, now: at(5), ...input });
}

function assertQueuedReadyRejected(f, generation, queued, input = {}) {
  const before = queuedSnapshot(f);
  const result = queuedReady(f, generation, queued, input);
  assert.ok(result.status === "invalid" || result.status === "stale", JSON.stringify(result));
  assert.deepEqual(queuedSnapshot(f), before);
  assert.equal(f.store.getTask(generation.task.id).status, "todo");
  assert.equal(f.store.getTask(generation.task.id).currentRunId, undefined);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, undefined);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.startOwner.phase, "preparing");
  assert.equal(exactLease(f, generation.lease.id).status, "active");
}

for (const queueReason of ["resource_conflict", "runtime_semaphore_conflict"]) {
  test(`A12 Core ${queueReason} queued ready atomically claims its todo Task and links one owned Run`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation, "positive", { snapshot: { queueReason } });
    assert.equal(f.store.getTask(generation.task.id).status, "todo");
    assert.equal(queued.run.status, "queued");
    assert.equal(queued.unit.status, "queued");
    assert.equal(queued.attempt.status, "created");
    assert.equal(queuedReady(f, generation, queued).status, "linked");
    const task = f.store.getTask(generation.task.id);
    const step = f.store.getChannelWorkflowStep(f.step.id);
    assert.equal(task.status, "claimed");
    assert.equal(task.currentRunId, queued.run.id);
    assert.equal(step.runId, queued.run.id);
    assert.equal(step.taskId, task.id);
    assert.deepEqual(step.metadata.startOwner, { ...generation.owner, phase: "linked" });
    assert.equal(f.store.getRun(queued.run.id).status, "queued");
    assert.equal(f.store.getWorkUnit(queued.unit.id).status, "queued");
    assert.deepEqual(f.store.getWorkUnitAttempt(queued.attempt.id), queued.attempt);
    assert.equal(f.store.listStateTransitionEvents({ entityType: "task", entityId: task.id, limit: 100 })
      .filter((event) => event.event === "claim").length, 1);
    assert.equal(exactLease(f, generation.lease.id).status, "active");
    const observedTask = f.database.prepare("SELECT status, current_run_id FROM tasks WHERE id=?").get(task.id);
    assert.equal(observedTask.status, "claimed");
    assert.equal(observedTask.current_run_id, queued.run.id);
    const beforeDuplicate = queuedSnapshot(f);
    assert.equal(queuedReady(f, generation, queued, { now: at(6) }).status, "duplicate");
    assert.deepEqual(queuedSnapshot(f), beforeDuplicate);
  });
}

for (const claimQueuedTask of [undefined, false]) {
  test(`A12 Core fresh queued evidence cannot claim todo Task when queued flag is ${String(claimQueuedTask)}`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation);
    assertQueuedReadyRejected(f, generation, queued, { claimQueuedTask });
  });
}

for (const [label, overrides] of [
  ["queue marker absent", { snapshot: { queued: undefined } }],
  ["queue marker false", { snapshot: { queued: false } }],
  ["queue marker string", { snapshot: { queued: "true" } }],
  ["queue reason absent", { snapshot: { queueReason: undefined } }],
  ["queue reason not conflict", { snapshot: { queueReason: "approval_pending" } }],
  ["Run snapshot not object", { snapshotValue: [] }],
  ["Run snapshot foreign workflow step", { snapshot: { workflowStepId: "foreign-step" } }],
  ["Run snapshot foreign teammate", { snapshot: { teammateId: "teammate_builtin_qa" } }],
  ["Run snapshot foreign Task", { snapshotTask: { id: "foreign-task" } }],
  ["Run snapshot foreign channel", { snapshotTask: { channelId: "foreign-channel" } }],
  ["Run snapshot foreign assignee", { snapshotTask: { assigneeTeammateId: "teammate_builtin_qa" } }],
  ["WorkUnit request not object", { requestValue: [] }],
  ["WorkUnit request foreign workflow step", { request: { workflowStepId: "foreign-step" } }],
  ["WorkUnit request foreign teammate", { request: { teammateId: "teammate_builtin_qa" } }],
  ["WorkUnit request foreign Task", { requestTask: { id: "foreign-task" } }],
  ["WorkUnit request foreign channel", { requestTask: { channelId: "foreign-channel" } }],
  ["WorkUnit request foreign assignee", { requestTask: { assigneeTeammateId: "teammate_builtin_qa" } }],
  ["WorkUnit foreign owner type", { unit: { ownerType: "run" } }],
  ["WorkUnit foreign owner ID", { unit: { ownerId: "foreign-task" } }],
  ["WorkUnit foreign kind", { unit: { kind: "conversation_run" } }],
  ["WorkUnit foreign channel", { unit: { channelId: "foreign-channel" } }],
  ["WorkUnit foreign teammate", { unit: { teammateId: "teammate_builtin_qa" } }],
]) {
  test(`A12 Core queued ready rejects ${label} without claiming or linking anything`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation, "invalid-evidence", overrides);
    assertQueuedReadyRejected(f, generation, queued);
  });
}

for (const runStatus of ["running", "waiting_for_approval", "succeeded", "failed", "cancelled"]) {
  test(`A12 Core queued claim rejects canonical Run state ${runStatus}`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation);
    if (runStatus !== "cancelled") assert.equal(f.store.transitionRunStatus({ runId: queued.run.id,
      expectedStatus: "queued", event: "runner_started", actor: "runner", now: at(4) }).ok, true);
    if (runStatus !== "running") assert.equal(f.store.transitionRunStatus({ runId: queued.run.id,
      expectedStatus: runStatus === "cancelled" ? "queued" : "running",
      event: runStatus === "waiting_for_approval" ? "approval_requested" : runStatus === "succeeded" ? "runner_succeeded"
        : runStatus === "failed" ? "runner_failed" : "cancel", actor: "runner", now: at(4) }).ok, true);
    assert.equal(f.store.getRun(queued.run.id).status, runStatus);
    assertQueuedReadyRejected(f, generation, queued);
  });
}

for (const unitStatus of ["claimed", "running", "waiting_for_approval", "failed", "cancelled"]) {
  test(`A12 Core queued claim rejects canonical WorkUnit state ${unitStatus}`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation, "unit-state", { unit: { status: unitStatus } });
    assert.equal(f.store.getWorkUnit(queued.unit.id).status, unitStatus);
    assertQueuedReadyRejected(f, generation, queued);
  });
}

for (const attemptState of ["started", "waiting_for_approval", "succeeded", "ended-created", "aborted-created", "started-created"]) {
  test(`A12 Core queued claim rejects active Attempt ${attemptState}`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation);
    const attempt = queued.attempt;
    const status = attemptState.endsWith("-created") ? "created" : attemptState;
    const updated = f.store.updateWorkUnitAttemptStatus({ attemptId: attempt.id, workUnitId: attempt.workUnitId,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken, status, now: at(4),
      ...(attemptState === "ended-created" ? { endedAt: at(4) } : {}),
      ...(attemptState === "aborted-created" ? { abortRequestedAt: at(4) } : {}),
      ...(attemptState === "started-created" ? { startedAt: at(4) } : {}),
    });
    assert.ok(updated);
    assert.equal(updated.status, status);
    assertQueuedReadyRejected(f, generation, queued);
  });
}

test("A12 Core old queued B ready cannot claim C's todo Task or release its current lease", async (t) => {
  const f = await fixture(t);
  const b = begin(f);
  const queuedB = queuedRun(f, b, "queued-B");
  assert.equal(settle(f, b, 5).status, "linked");
  const c = begin(f, lease(f, 6), 7);
  const queuedC = queuedRun(f, c, "queued-C");
  assert.notEqual(b.task.id, c.task.id);
  const before = queuedSnapshot(f);
  assert.equal(queuedReady(f, b, queuedB, { now: at(9) }).status, "stale");
  assert.deepEqual(queuedSnapshot(f), before);
  assert.equal(f.store.getTask(b.task.id).status, "todo");
  assert.equal(f.store.getTask(c.task.id).status, "todo");
  assert.equal(f.store.getTask(c.task.id).currentRunId, undefined);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).taskId, c.task.id);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, undefined);
  assert.equal(exactLease(f, c.lease.id).status, "active");
  assert.equal(queuedReady(f, c, queuedC, { now: at(10) }).status, "linked");
  assert.equal(f.store.getTask(c.task.id).currentRunId, queuedC.run.id);
});

function queuedReadyFaultTrigger(f, generation, fault) {
  const taskId = generation.task.id.replaceAll("'", "''");
  const stepId = f.step.id.replaceAll("'", "''");
  if (fault === "task-claim") return `BEFORE UPDATE OF status ON tasks
    WHEN OLD.id='${taskId}' AND OLD.status='todo' AND NEW.status='claimed'`;
  if (fault === "task-claim-audit") return `BEFORE INSERT ON state_transition_events
    WHEN NEW.entity_type='task' AND NEW.entity_id='${taskId}' AND NEW.event='claim'`;
  if (fault === "task-link") return `BEFORE UPDATE OF current_run_id ON tasks
    WHEN NEW.id='${taskId}' AND NEW.current_run_id IS NOT NULL`;
  return `BEFORE UPDATE OF run_id ON channel_workflow_steps WHEN NEW.id='${stepId}' AND NEW.run_id IS NOT NULL`;
}

for (const fault of ["task-claim", "task-claim-audit", "task-link", "step-link"]) {
  test(`A12 Core queued ready rolls back Task claim, audit and both links on ${fault} SQL failure`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation);
    const before = queuedSnapshot(f);
    f.database.exec(`CREATE TRIGGER a12_queued_ready_fault ${queuedReadyFaultTrigger(f, generation, fault)}
      BEGIN SELECT RAISE(ABORT, 'A12_QUEUED_READY_TRANSACTION_FAULT'); END`);
    assert.throws(() => queuedReady(f, generation, queued), /A12_QUEUED_READY_TRANSACTION_FAULT/);
    assert.deepEqual(queuedSnapshot(f), before);
    assert.equal(f.store.getTask(generation.task.id).status, "todo");
    assert.equal(f.store.getTask(generation.task.id).currentRunId, undefined);
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, undefined);
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.startOwner.phase, "preparing");
    assert.equal(exactLease(f, generation.lease.id).status, "active");
    f.database.exec("DROP TRIGGER a12_queued_ready_fault");
    assert.equal(queuedReady(f, generation, queued, { now: at(6) }).status, "linked");
    assert.equal(f.store.getTask(generation.task.id).status, "claimed");
    assert.equal(f.store.getTask(generation.task.id).currentRunId, queued.run.id);
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, queued.run.id);
    assert.equal(f.store.listStateTransitionEvents({ entityType: "task", entityId: generation.task.id, limit: 100 })
      .filter((event) => event.event === "claim").length, 1);
  });
}

for (const timestamp of ["startedAt", "endedAt"]) {
  test(`A12 Core queued claim rejects Run retry retaining ${timestamp} without any write`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation, `run-retry-${timestamp}`);
    if (timestamp === "startedAt") {
      assert.equal(f.store.transitionRunStatus({ runId: queued.run.id, expectedStatus: "queued",
        event: "runner_started", actor: "runner", startedAt: at(4), now: at(4) }).ok, true);
    }
    assert.equal(f.store.transitionRunStatus({ runId: queued.run.id,
      expectedStatus: timestamp === "startedAt" ? "running" : "queued", event: "runner_failed", actor: "runner",
      ...(timestamp === "endedAt" ? { endedAt: at(5) } : {}), now: at(5) }).ok, true);
    assert.equal(f.store.transitionRunStatus({ runId: queued.run.id, expectedStatus: "failed",
      event: "retry", actor: "system", now: at(6) }).ok, true);
    const retried = f.store.getRun(queued.run.id);
    assert.equal(retried.status, "queued");
    assert.equal(retried[timestamp], timestamp === "startedAt" ? at(4) : at(5));
    assert.equal(retried[timestamp === "startedAt" ? "endedAt" : "startedAt"], undefined);
    assert.equal(f.store.getWorkUnit(queued.unit.id).status, "queued");
    assert.equal(f.store.getWorkUnitAttempt(queued.attempt.id).status, "created");
    assertQueuedReadyRejected(f, generation, queued, { now: at(8) });
  });
}

for (const timestamp of ["startedAt", "endedAt"]) {
  test(`A12 Core queued claim rejects WorkUnit retry retaining ${timestamp} without any write`, async (t) => {
    const f = await fixture(t);
    const generation = begin(f);
    const queued = queuedRun(f, generation, `unit-retry-${timestamp}`);
    if (timestamp === "startedAt") {
      assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: queued.unit.id, expectedStatus: "queued",
        event: "claim", actor: "system", startedAt: at(4), now: at(4) }).ok, true);
    }
    assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: queued.unit.id,
      expectedStatus: timestamp === "startedAt" ? "claimed" : "queued", event: "runner_failed", actor: "system",
      ...(timestamp === "endedAt" ? { endedAt: at(5) } : {}), now: at(5) }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: queued.unit.id, expectedStatus: "failed",
      event: "retry", actor: "system", now: at(6) }).ok, true);
    const retried = f.store.getWorkUnit(queued.unit.id);
    assert.equal(retried.status, "queued");
    assert.equal(retried[timestamp], timestamp === "startedAt" ? at(4) : at(5));
    assert.equal(retried[timestamp === "startedAt" ? "endedAt" : "startedAt"], undefined);
    assert.equal(f.store.getRun(queued.run.id).status, "queued");
    assert.equal(f.store.getWorkUnitAttempt(queued.attempt.id).status, "created");
    assertQueuedReadyRejected(f, generation, queued, { now: at(8) });
  });
}
