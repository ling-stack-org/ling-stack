import assert from "node:assert/strict";
import test from "node:test";
import { SqliteRuntimeSemaphoreStore } from "../dist/storage/sqlite/runtime-semaphore-store.js";
import { b013PermitFixture } from "./support/b013-permit-lifecycle-fixture.mjs";
import { admissionRace, workflowAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";

const resource = (type, key, limit = 1) => ({ resourceType: type, resourceKey: key, limit });
const active = f => f.peer.database.prepare("SELECT * FROM runtime_semaphore_slots WHERE status='active' ORDER BY id").all();
const assertNoWrites = (f, action) => { const before = f.snapshot(); const result = action(); assert.deepEqual(f.snapshot(), before); return result; };
const narrowPlan = f => f.plan({ entries: f.plan().entries.map(entry => ({ ...entry, limit: 1 })), resourceKeys: [] });

test("begin reserves the entire normalized plan before Run/Attempt creation, and replay/reopen never double counts", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("reopen");
  scope.plan.resourceKeys.push(`workflow:${scope.workflow.id}`, "workspace:canonical");
  const generation = f.begin(scope), initial = f.admission(scope, generation);
  assert.equal(initial.status, "preparing");
  assert.equal(initial.slotIds.length, 0);
  assert.equal(f.count("workflow_step_admission_entries"), 6);
  for (const table of ["run_sessions", "work_units", "work_unit_attempts", "runtime_semaphore_slots"]) assert.equal(f.count(table), 0);
  assert.equal(assertNoWrites(f, () => f.store.beginChannelWorkflowStepStart(generation.input)).status, "stale");
  f.reopen();
  assert.deepEqual(f.admission(scope, generation), initial);
  assert.equal(assertNoWrites(f, () => f.store.beginChannelWorkflowStepStart(generation.input)).status, "stale");
  assert.equal(f.count("tasks"), 1);
});

for (const kind of ["provider", "exclusive"]) {
  test(`competing real SQLite begin writers reserve one complete ${kind} group`, async t => {
    const f = await workflowAdmissionFixture(t), plan = kind === "provider" ? narrowPlan(f) : f.plan();
    const left = f.scope("left", { plan }), right = f.scope("right", { plan });
    const results = await admissionRace(t, f, [left, right].map(scope => ({ method: "beginChannelWorkflowStepStart", input: f.input(scope) })));
    assert.deepEqual(results.map(result => result.status).sort(), ["begun", "conflict"]);
    assert.equal(f.count("tasks"), 1);
    assert.equal(f.count("workflow_step_admissions"), 1);
    assert.equal(f.count("workflow_step_admission_entries"), plan.entries.length + plan.resourceKeys.length);
  });
}

test("ordinary acquisition racing begin sees preparing capacity, not an empty runtime table", async t => {
  const f = await workflowAdmissionFixture(t), plan = narrowPlan(f), scope = f.scope("race-acquire", { plan });
  const outsider = f.outsider("race");
  const results = await admissionRace(t, f, [
    { method: "beginChannelWorkflowStepStart", input: f.input(scope) },
    { method: "acquireRuntimeSemaphoreSlot", input: f.slotInput(outsider, plan.entries[0]) },
  ]);
  const beginWon = results[0].status === "begun", acquireWon = results[1] !== undefined;
  assert.notEqual(beginWon, acquireWon);
  assert.equal(Number(f.peer.database.prepare("SELECT COUNT(*) n FROM workflow_step_admissions WHERE status='preparing'").get().n) + active(f).length, 1);
});

test("transfer racing an ordinary acquire has no release/reacquire capacity gap", async t => {
  const f = await workflowAdmissionFixture(t), plan = narrowPlan(f), scope = f.scope("no-gap", { plan });
  const generation = f.begin(scope), prepared = f.prepare(scope, generation), outsider = f.outsider("transfer");
  const results = await admissionRace(t, f, [
    { method: "transferChannelWorkflowStepStartAdmission", input: f.transferInput(scope, generation, prepared) },
    { method: "acquireRuntimeSemaphoreSlot", input: f.slotInput(outsider, plan.entries[0]) },
  ]);
  assert.equal(results[0].status, "transferred");
  assert.equal(results[1], undefined);
  assert.equal(active(f).length, 3);
  assert.equal(f.admission(scope, generation).status, "transferred");
});

for (const method of ["acquireRuntimeSemaphoreSlot", "ensureRuntimeSemaphoreSlotForAttempt"]) {
  for (const kind of ["provider", "runner", "channel_parallel", "media_provider", "workflow_resource"]) {
    test(`${method} includes durable preparing ${kind} reservations even when caller widens its limit`, async t => {
      const f = await workflowAdmissionFixture(t), plan = narrowPlan(f);
      plan.entries.push(resource("media_provider", "p1c-media")); plan.resourceKeys.push("p1c-exclusive");
      const scope = f.scope(`${method}-${kind}`, { plan }), generation = f.begin(scope), outsider = f.outsider(kind);
      const entry = kind === "workflow_resource" ? resource(kind, "p1c-exclusive") : plan.entries.find(value => value.resourceType === kind);
      const semaphores = new SqliteRuntimeSemaphoreStore({ database: f.store.database });
      const result = assertNoWrites(f, () => semaphores[method](f.slotInput(outsider, { ...entry, limit: 999 })));
      assert.equal(method === "acquireRuntimeSemaphoreSlot" ? result : result.status, method === "acquireRuntimeSemaphoreSlot" ? undefined : "full");
      assert.equal(f.admission(scope, generation).status, "preparing");
    });
  }
}

test("capacity conflict does not consume a real approved pre-gate marker or create a Task/audit", async t => {
  const f = await b013PermitFixture(t); f.approved();
  const unit = f.store.createWorkUnit({ workspaceId: f.channel.workspaceId, kind: "task_run", ownerType: "task", ownerId: "outside",
    idempotencyKey: "outside", createdByActor: "system", request: {}, now: f.at(3) });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "outside-runtime", runnerId: "pi", now: f.at(3) });
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ workspaceId: f.channel.workspaceId, resourceType: "provider", resourceKey: "approved-provider",
    workUnitId: unit.id, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
    ownerType: "work_unit_attempt", ownerId: attempt.id, limit: 1, acquiredAt: f.at(3), expiresAt: f.at(200) }));
  const input = { ...f.beginInput(f.lease()), admission: { entries: [resource("provider", "approved-provider"), resource("runner", "pi"),
    resource("channel_parallel", f.channel.id)], resourceKeys: ["workspace:approved"] } };
  const before = f.snapshot(), marker = f.current().metadata.preStepApprovalMarker;
  assert.equal(f.store.beginChannelWorkflowStepStart(input).status, "conflict");
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.current().metadata.preStepApprovalMarker, marker);
  assert.equal(f.count("tasks"), 0);
  assert.equal(f.count("workflow_step_admissions"), 0);
});

test("begin rolls Task, audit, owner and every reservation back when a later entry insert fails", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("begin-rollback"), input = f.input(scope), before = f.snapshot();
  f.store.database.exec("CREATE TRIGGER p1c_fail_begin BEFORE INSERT ON workflow_step_admission_entries WHEN NEW.resource_type='runner' BEGIN SELECT RAISE(ABORT,'p1c-begin-fault'); END");
  assert.throws(() => f.store.beginChannelWorkflowStepStart(input), /p1c-begin-fault/);
  assert.deepEqual(f.snapshot(), before);
});

test("transfer rolls every slot and receipt back on a later slot failure", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("transfer-rollback"), generation = f.begin(scope), prepared = f.prepare(scope, generation);
  const before = f.snapshot();
  f.store.database.exec("CREATE TRIGGER p1c_fail_slot BEFORE INSERT ON runtime_semaphore_slots WHEN NEW.resource_type='runner' BEGIN SELECT RAISE(ABORT,'p1c-slot-fault'); END");
  assert.throws(() => f.transfer(scope, generation, prepared), /p1c-slot-fault/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.admission(scope, generation).status, "preparing");
});

test("commitReady cannot link before handoff and its optional handoff shares one rollback boundary", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("ready-rollback"), generation = f.begin(scope), prepared = f.prepare(scope, generation);
  assert.equal(assertNoWrites(f, () => f.ready(scope, generation, prepared)).code, "workflow_admission_not_transferred");
  f.store.database.exec("CREATE TRIGGER p1c_fail_ready BEFORE UPDATE OF current_run_id ON tasks WHEN NEW.current_run_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'p1c-ready-fault'); END");
  const before = f.snapshot();
  const admission = { admission: scope.plan, ...prepared.fence, expiresAt: f.at(200) };
  assert.throws(() => f.ready(scope, generation, prepared, { admission }), /p1c-ready-fault/);
  assert.deepEqual(f.snapshot(), before);
  f.store.database.exec("DROP TRIGGER p1c_fail_ready");
  assert.equal(f.ready(scope, generation, prepared, { admission }).status, "linked");
  assert.equal(f.ready(scope, generation, prepared).status, "duplicate");
});

test("exact transfer replay survives reopen with the same slot ids and no double counting", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("transfer-reopen"), generation = f.begin(scope), prepared = f.prepare(scope, generation);
  const first = f.transfer(scope, generation, prepared);
  assert.equal(first.status, "transferred");
  assert.equal(f.ready(scope, generation, prepared).status, "linked");
  f.reopen();
  const replay = assertNoWrites(f, () => f.transfer(scope, generation, prepared));
  assert.equal(replay.status, "duplicate");
  assert.deepEqual(replay.slots.map(slot => slot.id).sort(), first.slots.map(slot => slot.id).sort());
});

for (const change of ["omit-entry", "omit-exclusive", "limit", "provider", "duplicate-key"]) {
  test(`handoff rejects semantic plan drift without consuming its reservation: ${change}`, async t => {
    const f = await workflowAdmissionFixture(t), scope = f.scope(change), generation = f.begin(scope), prepared = f.prepare(scope, generation);
    const admission = structuredClone(scope.plan);
    if (change === "omit-entry") admission.entries.pop();
    if (change === "omit-exclusive") admission.resourceKeys = [];
    if (change === "limit") admission.entries[0].limit++;
    if (change === "provider") admission.entries[0].resourceKey = "different";
    if (change === "duplicate-key") admission.resourceKeys.push(admission.resourceKeys[0]);
    assert.equal(assertNoWrites(f, () => f.transfer(scope, generation, prepared, { admission })).code, "workflow_admission_plan_mismatch");
  });
}

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`handoff and release reject a stale exact ${field}`, async t => {
    const f = await workflowAdmissionFixture(t), scope = f.scope(field), generation = f.begin(scope), prepared = f.prepare(scope, generation);
    assert.equal(assertNoWrites(f, () => f.transfer(scope, generation, prepared, { [field]: "stale" })).status, "stale");
    assert.equal(f.transfer(scope, generation, prepared).status, "transferred");
    assert.equal(assertNoWrites(f, () => f.transfer(scope, generation, prepared, { [field]: "stale" })).status, "stale");
    assert.equal(assertNoWrites(f, () => f.release(scope, generation, prepared, { fence: { ...prepared.fence, [field]: "stale" } })).status, "stale");
  });
}

test("handoff rejects foreign workspace, sibling Run and unplanned active Attempt slots", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("lineage"), generation = f.begin(scope), prepared = f.prepare(scope, generation);
  f.store.database.prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('foreign','Foreign',?,?)").run(f.at(0), f.at(0));
  f.store.database.prepare("UPDATE work_units SET workspace_id='foreign' WHERE id=?").run(prepared.unit.id);
  assert.equal(assertNoWrites(f, () => f.transfer(scope, generation, prepared)).status, "stale");
  f.store.database.prepare("UPDATE work_units SET workspace_id=? WHERE id=?").run(f.channel.workspaceId, prepared.unit.id);
  assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.slotInput(prepared, resource("media_provider", "unplanned"))));
  assert.equal(assertNoWrites(f, () => f.transfer(scope, generation, prepared)).code, "workflow_admission_unplanned_attempt_slots");
  f.store.releaseRuntimeSemaphoreSlotsForAttempt(prepared.fence, f.at(4), "test cleanup");
  f.store.createRun({ id: "p1c-sibling-run", cwd: f.cwd, taskId: generation.task.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: f.at(4) });
  assert.equal(assertNoWrites(f, () => f.transfer(scope, generation, prepared)).status, "stale");
});

for (const change of ["missing-receipt", "wrong-resource", "extra-slot"]) {
  test(`transfer replay fails closed on receipt/slot corruption: ${change}`, async t => {
    const f = await workflowAdmissionFixture(t), scope = f.scope(change), generation = f.begin(scope), prepared = f.prepare(scope, generation);
    const result = f.transfer(scope, generation, prepared);
    if (change === "missing-receipt") f.store.database.prepare("UPDATE workflow_step_admission_entries SET slot_id=NULL WHERE slot_id=?").run(result.slots[0].id);
    if (change === "wrong-resource") f.store.database.prepare("UPDATE runtime_semaphore_slots SET resource_key='wrong' WHERE id=?").run(result.slots[0].id);
    if (change === "extra-slot") assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.slotInput(prepared, resource("media_provider", "extra"))));
    assert.equal(assertNoWrites(f, () => f.transfer(scope, generation, prepared)).code, "workflow_admission_slots_changed");
  });
}

test("unknown preparation dispatch retains admission; proven no-Run failure releases only the matching owner", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("no-run"), generation = f.begin(scope);
  assert.equal(assertNoWrites(f, () => f.release(scope, generation, undefined, { dispatchState: "unknown" })).code, "workflow_admission_dispatch_unknown");
  assert.equal(assertNoWrites(f, () => f.release(scope, { ...generation, owner: { ...generation.owner, leaseId: "old" } })).status, "stale");
  assert.equal(f.release(scope, generation).status, "released");
  assert.equal(f.release(scope, generation).status, "duplicate");
});

test("proven never-dispatched failed Run releases its exact transferred slots and cannot release with a stale fence on replay", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("failed-preparation"), generation = f.begin(scope), prepared = f.prepare(scope, generation);
  assert.equal(f.transfer(scope, generation, prepared).status, "transferred");
  assert.equal(f.release(scope, generation, prepared).releasedSlots, 4);
  assert.equal(active(f).length, 0);
  assert.equal(f.release(scope, generation, prepared).status, "duplicate");
  assert.equal(assertNoWrites(f, () => f.release(scope, generation, prepared, { fence: { ...prepared.fence, fencingToken: "stale" } })).status, "stale");
});

for (const evidence of ["missing-proof", "heartbeat", "started-run", "runtime-start"]) {
  test(`preparation release retains resources without strict no-dispatch proof: ${evidence}`, async t => {
    const f = await workflowAdmissionFixture(t), scope = f.scope(evidence), generation = f.begin(scope), prepared = f.prepare(scope, generation);
    assert.equal(f.transfer(scope, generation, prepared).status, "transferred");
    if (evidence === "heartbeat") f.store.database.prepare("UPDATE work_unit_attempts SET last_heartbeat_at=? WHERE id=?").run(f.at(6), prepared.attempt.id);
    if (evidence === "started-run") f.store.database.prepare("UPDATE run_sessions SET started_at=? WHERE id=?").run(f.at(6), prepared.run.id);
    if (evidence === "runtime-start") f.store.appendRuntimeEvent({ ...prepared.fence, type: "work_unit_started", actor: "system", ts: f.at(6), data: {} });
    const result = assertNoWrites(f, () => evidence === "missing-proof" ? f.release(scope, generation) : f.release(scope, generation, prepared));
    assert.ok(["stale", "retained"].includes(result.status));
    assert.equal(active(f).length, 4);
  });
}

test("partial release veto restores every slot via savepoint and leaves the reservation owner unchanged", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("release-veto"), generation = f.begin(scope), prepared = f.prepare(scope, generation);
  f.transfer(scope, generation, prepared);
  f.store.database.exec("CREATE TRIGGER p1c_veto_release BEFORE UPDATE OF status ON runtime_semaphore_slots WHEN OLD.resource_type='runner' AND NEW.status='released' BEGIN SELECT RAISE(IGNORE); END");
  assert.equal(assertNoWrites(f, () => f.release(scope, generation, prepared)).code, "workflow_admission_effects_unconfirmed");
  assert.equal(active(f).length, 4);
});

test("TTL cannot expire preparing ownership or terminal receipt-backed/exclusive slots", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("ttl"), generation = f.begin(scope), prepared = f.prepare(scope, generation);
  assert.equal(f.store.expireRuntimeSemaphoreSlots(f.at(10_000)), 0);
  assert.equal(f.admission(scope, generation).status, "preparing");
  assert.equal(f.transfer(scope, generation, prepared).status, "transferred");
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...prepared.fence, status: "lost", endedAt: f.at(7), now: f.at(7) }));
  assert.equal(assertNoWrites(f, () => f.store.expireRuntimeSemaphoreSlots(f.at(10_000))), 0);
  assert.equal(active(f).length, 4);
});
