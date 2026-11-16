import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { workflowIsolationSafetyFingerprint } from "../dist/index.js";
import { workflowParallelParentFixture } from "./support/workflow-parallel-parent-fixture.mjs";

const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = f => ({ ...f.snapshotIsolation(),
  ...Object.fromEntries(["channels", "workflow_isolation_selections", "workflow_parallel_parent_fences"]
    .map(table => [table, rows(f.peer.database, table)])) });
const unchanged = (f, action) => {
  const before = snapshot(f), result = action();
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.store.database.isTransaction, false);
  return result;
};

async function fixture(t, options = {}) {
  const f = await workflowParallelParentFixture(t, { create: false, count: 2, ...options });
  f.safetyPlans = f.members.map(member => f.current(member).metadata.safetyPlan);
  // Selection precedes planning; retain the valid fixture plans only as future freeze inputs.
  for (const member of f.members) {
    const { safetyPlan, ...metadata } = f.current(member).metadata;
    assert.ok(safetyPlan);
    f.store.updateChannelWorkflowStep(member.step.id, { metadata }, f.at(0));
  }
  f.selectionInput = (overrides = {}) => ({ workflowId: f.plan.workflowId, roundId: f.roundId, now: f.at(1), ...overrides });
  f.selection = () => f.isolation.getSelection(f.plan.workflowId);
  f.select = () => {
    const result = f.isolation.beginSelection(f.selectionInput());
    assert.equal(result.status, "created", JSON.stringify(result));
    return result.value;
  };
  f.freezeInput = (overrides = {}) => ({ roundId: f.roundId, inputs: f.inputs, plans: f.plans,
    safetyPlans: f.safetyPlans, expectedWorkflow: f.store.getChannelWorkflow(f.plan.workflowId),
    expectedChannel: f.store.getChannel(f.channel.id),
    expectedSteps: f.store.listChannelWorkflowSteps({ workflowId: f.plan.workflowId, complete: true }),
    now: f.at(3), ...overrides });
  f.freeze = () => {
    const result = f.isolation.freezePlan(f.freezeInput());
    assert.equal(result.status, "created", JSON.stringify(result));
    return result.value;
  };
  assert.equal(f.selection(), undefined);
  return f;
}

/** The barrier opens only after every independent Core SQLite connection is ready. */
async function race(t, f, operations) {
  const source = `const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      if (workerData.sourceLoaderUrl) await import(workerData.sourceLoaderUrl);
      const { createSqliteRunStore, createSqliteWorkflowIsolationStore } = await import(workerData.moduleUrl);
      const store = createSqliteRunStore(workerData.cwd, workerData.paths);
      const target = workerData.target === "isolation" ? createSqliteWorkflowIsolationStore(store) : store;
      parentPort.once("message", () => {
        try { parentPort.postMessage({ type: "result", result: target[workerData.method](workerData.input) }); }
        catch (error) { parentPort.postMessage({ type: "error", message: String(error) }); }
        finally { store.close(); }
      });
      parentPort.postMessage({ type: "ready" });
    })().catch(error => parentPort.postMessage({ type: "error", message: String(error) }));`;
  const moduleUrl = import.meta.resolve("../dist/index.js");
  const workers = operations.map(operation => new Worker(source, { eval: true, workerData: { ...operation,
    cwd: f.cwd, paths: f.paths, moduleUrl,
    ...(moduleUrl.endsWith(".ts")
      ? { sourceLoaderUrl: new URL("./support/workflow-step-admission-source-loader.mjs", import.meta.url).href } : {}) } }));
  try {
    await Promise.all(workers.map(async worker => {
      const [message] = await once(worker, "message", { signal: t.signal });
      assert.equal(message.type, "ready", JSON.stringify(message));
    }));
    const pending = workers.map(worker => once(worker, "message", { signal: t.signal }));
    workers.forEach(worker => worker.postMessage("go"));
    return (await Promise.all(pending)).map(([message]) => {
      assert.equal(message.type, "result", JSON.stringify(message));
      return message.result;
    });
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test("eight competing selection requests retain one Host-owned round and survive reopen", { timeout: 60_000 }, async t => {
  const f = await fixture(t), before = snapshot(f);
  const results = await race(t, f, Array.from({ length: 8 }, (_, index) => ({ target: "isolation", method: "beginSelection",
    input: f.selectionInput({ roundId: `selection-race-${index}`, now: f.at(index + 1) }) })));
  assert.equal(results.filter(result => result.status === "created").length, 1);
  assert.equal(results.filter(result => result.status === "duplicate").length, 7);
  const winner = results.find(result => result.status === "created").value;
  for (const result of results) assert.deepEqual(result.value, winner);
  assert.equal(winner.phase, "planning");
  assert.equal(winner.profile, "pi_host_isolated_files_v1");
  assert.equal(winner.workflowId, f.plan.workflowId);
  assert.deepEqual({ ...snapshot(f), workflow_isolation_selections: [] }, before);
  assert.equal(rows(f.peer.database, "workflow_isolation_selections").length, 1);
  f.reopenIsolation();
  assert.deepEqual(f.selection(), winner);
  assert.deepEqual(unchanged(f, () => f.isolation.beginSelection(f.selectionInput({ roundId: "later-proposal", now: f.at(20) }))),
    { status: "duplicate", value: winner });
});

test("selection and step admission have exactly one winner across independent SQLite writers", { timeout: 60_000 }, async t => {
  const f = await fixture(t), member = f.members[0], start = f.input(member), before = snapshot(f);
  const [selection, admission] = await race(t, f, [
    { target: "isolation", method: "beginSelection", input: f.selectionInput() },
    { target: "store", method: "beginChannelWorkflowStepStart", input: start },
  ]);
  assert.equal(Number(selection.status === "created") + Number(admission.status === "begun"), 1);
  if (selection.status === "created") {
    assert.deepEqual(admission, { status: "invalid", code: "workflow_isolation_selection_not_ready" });
    assert.equal(f.selection().phase, "planning");
    assert.deepEqual({ ...snapshot(f), workflow_isolation_selections: [] }, before);
  } else {
    assert.deepEqual(selection, { status: "stale", code: "workflow_isolation.selection_already_started" });
    assert.equal(admission.status, "begun");
    assert.equal(f.selection(), undefined);
    assert.equal(f.current(member).taskId, admission.task.id);
    assert.deepEqual(f.current(member).metadata.startOwner, admission.owner);
    assert.equal(f.count("tasks"), before.tasks.length + 1);
    assert.equal(f.count("workflow_step_admissions"), 1);
  }
  assert.equal(f.round(), undefined);
  assert.equal(rows(f.peer.database, "workflow_isolation_scope_plans").length, 0);
  assert.equal(rows(f.peer.database, "workflow_parallel_parent_fences").length, 0);
});

test("planning blocks manual run and create-task-only admission before and after reopen", async t => {
  const f = await fixture(t), inputs = f.members.map(member => f.input(member)), selected = f.select();
  for (const reopen of [false, true]) {
    if (reopen) f.reopenIsolation();
    for (const input of inputs) for (const createTaskOnly of [false, true]) {
      assert.deepEqual(unchanged(f, () => f.store.beginChannelWorkflowStepStart({ ...input, createTaskOnly })),
        { status: "invalid", code: "workflow_isolation_selection_not_ready" });
    }
    assert.deepEqual(f.selection(), selected);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "ready");
    assert.ok(f.members.every(member => f.current(member).status === "queued"));
  }
});

test("a prior successful admission prevents selection without disturbing its Task or reservations", async t => {
  const f = await fixture(t), generation = f.begin(f.members[0]), before = snapshot(f);
  assert.deepEqual(unchanged(f, () => f.isolation.beginSelection(f.selectionInput())),
    { status: "stale", code: "workflow_isolation.selection_already_started" });
  assert.deepEqual(f.admission(f.members[0], generation).plan, f.members[0].plan);
  f.reopenIsolation();
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(unchanged(f, () => f.isolation.beginSelection(f.selectionInput({ roundId: "after-reopen" }))),
    { status: "stale", code: "workflow_isolation.selection_already_started" });
});

test("selection rejects pre-planned, approval-owned, and historical Run workflows while still ready", async t => {
  for (const state of ["safety-plan", "scope-pin", "pre-approval", "historical-run"]) await t.test(state, async t => {
    const f = await fixture(t), member = f.members[0], step = f.current(member);
    if (state === "safety-plan") f.store.updateChannelWorkflowStep(step.id,
      { metadata: { ...step.metadata, safetyPlan: f.safetyPlans[0] } }, f.at(1));
    if (state === "scope-pin") f.store.updateChannelWorkflowStep(step.id,
      { metadata: { ...step.metadata, isolationScopePlan: { planId: f.plan.planId, planDigest: f.plan.planDigest } } }, f.at(1));
    if (state === "pre-approval") f.store.updateChannelWorkflowStep(step.id,
      { metadata: { ...step.metadata, preStepApprovalId: "prior-pre-approval" } }, f.at(1));
    if (state === "historical-run") {
      const task = f.store.createTask({ channelId: f.channel.id, title: step.title, prompt: step.prompt,
        assigneeTeammateId: step.toParticipantId }, f.at(1));
      const run = f.store.createRun({ id: "selection-historical-run", cwd: f.cwd, taskId: task.id,
        workflowStepId: step.id, channelId: f.channel.id, teammateId: step.toParticipantId,
        providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: f.at(1) });
      assert.equal(run.workflowStepId, step.id);
      assert.equal(f.current(member).taskId, undefined);
      assert.equal(f.current(member).runId, undefined);
    }
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "ready");
    assert.equal(f.current(member).status, "queued");
    assert.deepEqual(unchanged(f, () => f.isolation.beginSelection(f.selectionInput())),
      { status: "stale", code: "workflow_isolation.selection_already_started" });
    assert.equal(f.selection(), undefined);
  });
});

test("freeze rejects workflow, channel, or step snapshot drift without leaving planning writes", async t => {
  for (const drift of ["workflow", "channel", "step", "new-step"]) await t.test(drift, async t => {
    const f = await fixture(t); f.select();
    const input = f.freezeInput();
    if (drift === "workflow") f.peer.updateChannelWorkflow(f.plan.workflowId, { objective: "Changed during planning" }, f.at(2));
    if (drift === "channel") f.peer.updateChannel(f.channel.id,
      { runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 3 } }, f.at(2));
    if (drift === "step") f.peer.updateChannelWorkflowStep(f.members[1].step.id, { prompt: "Changed during planning" }, f.at(2));
    if (drift === "new-step") f.peer.createChannelWorkflowStep({ workflowId: f.plan.workflowId,
      title: "Late participant", prompt: "Do not freeze a stale participant inventory", toParticipantId: f.members[0].step.toParticipantId,
      toParticipantLabel: "Engineer" }, f.at(2));
    assert.deepEqual(unchanged(f, () => f.isolation.freezePlan(input)),
      { status: "stale", code: "workflow_isolation.planning_snapshot_changed" });
    assert.equal(f.selection().phase, "planning");
    assert.equal(f.round(), undefined);
    assert.equal(f.parent(), undefined);
    for (const member of f.members) {
      assert.equal(f.current(member).metadata.safetyPlan, undefined);
      assert.equal(f.current(member).metadata.isolationScopePlan, undefined);
    }
  });
});

test("failure at the second scope insert rolls back safety plans, first scope, round, parent and readiness", async t => {
  const f = await fixture(t); f.select();
  const input = f.freezeInput(), before = snapshot(f), db = f.store.database, prepare = db.prepare.bind(db);
  let inserts = 0;
  const fault = t.mock.method(db, "prepare", sql => {
    if (sql.startsWith("INSERT INTO workflow_isolation_scope_plans(")) {
      inserts++;
      if (inserts === 2) {
        assert.ok(db.isTransaction);
        assert.equal(rows(db, "workflow_isolation_scope_plans").length, 1);
        assert.ok(f.round());
        assert.equal(f.parent().state, "held");
        assert.ok(f.members.every(member => f.current(member).metadata.safetyPlan));
        assert.deepEqual(f.current(f.members[0]).metadata.isolationScopePlan,
          { planId: f.plans[0].planId, planDigest: f.plans[0].planDigest });
        assert.deepEqual(snapshot(f), before, "an independent reader must not see partial freeze writes");
        throw new Error("selection-second-scope-insert");
      }
    }
    return prepare(sql);
  });
  try { assert.throws(() => f.isolation.freezePlan(input), /selection-second-scope-insert/u); }
  finally { fault.mock.restore(); }
  assert.equal(inserts, 2);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(snapshot(f), before);
  f.reopenIsolation();
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.selection().phase, "planning");
  assert.equal(f.round(), undefined);
  assert.equal(f.parent(), undefined);
  const frozen = f.freeze();
  assert.equal(frozen.round.roundId, f.roundId);
  assert.equal(f.selection().phase, "ready");
  assert.equal(rows(f.peer.database, "workflow_isolation_scope_plans").length, 2);
});

test("a second-scope validation veto also leaves the entire freeze retryable", async t => {
  const f = await fixture(t); f.select();
  const input = f.freezeInput({ plans: [f.plans[0], { ...f.plans[1], planDigest: "forged-scope-digest" }] });
  assert.deepEqual(unchanged(f, () => f.isolation.freezePlan(input)),
    { status: "invalid", code: "workflow_isolation.scope_plan_invalid" });
  assert.equal(f.selection().phase, "planning");
  assert.equal(f.round(), undefined);
  assert.equal(f.parent(), undefined);
  f.freeze();
  assert.equal(f.selection().phase, "ready");
});

test("freeze commits every safety plan and pin before ready, and later requests retain the same round", async t => {
  const f = await fixture(t), selected = f.select(), frozen = f.freeze();
  const ready = { ...selected, phase: "ready", updatedAt: f.at(3) };
  assert.deepEqual(f.selection(), ready);
  assert.equal(frozen.round.roundId, selected.roundId);
  assert.equal(frozen.round.generation, 1);
  assert.deepEqual(frozen.plans, f.plans);
  assert.equal(f.parent().state, "held");
  for (const [index, member] of f.members.entries()) {
    assert.deepEqual(f.current(member).metadata.safetyPlan, f.safetyPlans[index]);
    assert.deepEqual(f.current(member).metadata.isolationScopePlan,
      { planId: member.scopePlan.planId, planDigest: member.scopePlan.planDigest });
    assert.deepEqual(f.isolation.getScopePlan(member.scopePlan.planId), member.scopePlan);
  }
  f.reopenIsolation();
  assert.deepEqual(f.selection(), ready);
  for (const [index, member] of f.members.entries()) {
    const read = f.current(member);
    assert.equal(JSON.stringify(read.metadata.safetyPlan.safety), JSON.stringify(f.safetyPlans[index].safety));
  }
  const generations = f.members.map(member => f.begin(member, f.input(member, f.lease(member, f.at(4)), { now: f.at(5) })));
  assert.equal(f.count("workflow_step_admissions"), 2, "ready must admit the two frozen siblings");
  for (const [index, generation] of generations.entries())
    assert.deepEqual(f.admission(f.members[index], generation).plan, f.members[index].scopePlan.resourcePlan);
  assert.deepEqual(unchanged(f, () => f.isolation.beginSelection(f.selectionInput({ roundId: "replacement-round", now: f.at(20) }))),
    { status: "duplicate", value: ready });
  assert.equal(rows(f.peer.database, "workflow_integration_rounds").length, 1);
  assert.equal(rows(f.peer.database, "workflow_parallel_parent_fences").length, 1);
  assert.deepEqual(f.peer.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("freeze cannot replace the selected round or weaken its parallel delivery policy", async t => {
  const f = await fixture(t); f.select();
  for (const change of [
    { roundId: "different-round" },
    { inputs: { ...f.inputs, parallelExecution: undefined } },
    { inputs: { ...f.inputs, mode: "apply_to_target" } },
    { inputs: { ...f.inputs, optionalFailurePolicy: "exclude_failed_with_evidence" } },
    { inputs: { ...f.inputs, parallelExecution: { ...f.inputs.parallelExecution, maxConcurrentSteps: 5 } } },
  ]) assert.deepEqual(unchanged(f, () => f.isolation.freezePlan(f.freezeInput(change))),
    { status: "invalid", code: "workflow_isolation.selection_plan_mismatch" });
  assert.equal(f.selection().phase, "planning");
  f.freeze();
  assert.equal(f.selection().roundId, f.roundId);
});

test("selection accepts the bounded Host parallel limits", async t => {
  for (const limit of [2, 3, 4]) await t.test(`limit ${limit}`, async t => {
    const f = await fixture(t, { count: limit, limit }), selected = f.select(), frozen = f.freeze();
    assert.equal(selected.phase, "planning");
    assert.equal(frozen.round.inputs.parallelExecution.maxConcurrentSteps, limit);
    assert.equal(f.selection().phase, "ready");
  });
});

test("a selected freeze must cover every workflow participant with one safety plan and one scope", async t => {
  const f = await fixture(t); f.select();
  const safetyPins = f.inputs.safetyPins.slice(0, 1);
  for (const change of [
    { inputs: { ...f.inputs, participants: f.inputs.participants.slice(0, 1), mergeOrder: f.inputs.mergeOrder.slice(0, 1),
      safetyPins, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins) },
    plans: f.plans.slice(0, 1), safetyPlans: f.safetyPlans.slice(0, 1) },
    { plans: [f.plans[0], f.plans[0]] },
    { safetyPlans: [f.safetyPlans[0], f.safetyPlans[0]] },
  ]) assert.deepEqual(unchanged(f, () => f.isolation.freezePlan(f.freezeInput(change))),
    { status: "invalid", code: "workflow_isolation.planning_members_invalid" });
  assert.equal(f.selection().phase, "planning");
  f.freeze();
  assert.equal(f.selection().phase, "ready");
});

test("selection identity is immutable while planning, and ready selections cannot be updated or deleted", async t => {
  const f = await fixture(t); f.select();
  const db = f.store.database;
  for (const [column, value] of [["workflow_id", "foreign-workflow"], ["profile", "serial_v1"],
    ["round_id", "foreign-round"], ["created_at", f.at(0)], ["updated_at", f.at(0)]]) {
    const before = snapshot(f);
    assert.throws(() => db.prepare(`UPDATE workflow_isolation_selections SET phase='ready',${column}=? WHERE workflow_id=?`)
      .run(value, f.plan.workflowId), /workflow_isolation\.selection_immutable/u);
    assert.deepEqual(snapshot(f), before);
  }
  for (const phase of ["planning", "ready"]) {
    if (phase === "ready") f.freeze();
    const before = snapshot(f);
    assert.throws(() => db.prepare("DELETE FROM workflow_isolation_selections WHERE workflow_id=?").run(f.plan.workflowId),
      /workflow_isolation\.selection_retained/u);
    assert.throws(() => db.prepare("UPDATE workflow_isolation_selections SET updated_at=? WHERE workflow_id=?")
      .run(f.at(20), f.plan.workflowId), /workflow_isolation\.selection_immutable/u);
    assert.deepEqual(snapshot(f), before);
  }
  const ready = f.selection();
  f.reopenIsolation();
  assert.deepEqual(f.selection(), ready);
});

test("selection and freeze never adopt or finish a caller transaction", async t => {
  const f = await fixture(t), db = f.store.database;
  for (const method of ["beginSelection", "freezePlan"]) {
    if (method === "freezePlan") f.select();
    const input = method === "beginSelection" ? f.selectionInput() : f.freezeInput();
    const committed = snapshot(f);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE channel_workflows SET title='caller-selection-wip' WHERE id=?").run(f.plan.workflowId);
      assert.throws(() => f.isolation[method](input), /transaction/iu);
      assert.equal(db.isTransaction, true);
      assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-selection-wip");
      assert.deepEqual(snapshot(f), committed);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    assert.deepEqual(snapshot(f), committed);
  }
});
