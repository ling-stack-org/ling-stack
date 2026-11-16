import assert from "node:assert/strict";
import test from "node:test";
import { admissionRace, workflowResumeAdmissionFixture, workflowUserInputAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";

const slotIds = result => result.slots.map(slot => slot.id).sort();
const semaphoreIds = result => result.semaphores.map(slot => slot.id).sort();
const assertNoWrites = (f, action) => { const before = f.snapshot(); const result = action(); assert.deepEqual(f.snapshot(), before); return result; };
const activeSlots = f => f.peer.database.prepare("SELECT * FROM runtime_semaphore_slots WHERE status='active' ORDER BY id").all();
const assertFence = (slot, fence) => {
  assert.equal(slot.workUnitId, fence.workUnitId);
  assert.equal(slot.attemptId, fence.attemptId);
  assert.equal(slot.runtimeInstanceId, fence.runtimeInstanceId);
  assert.equal(slot.fencingToken, fence.fencingToken);
  assert.equal(slot.ownerId, fence.attemptId);
};
const assertCompletePlan = (slots, plan) => {
  const key = value => JSON.stringify([value.resourceType, value.resourceKey]);
  const expected = [...plan.entries, ...plan.resourceKeys.map(resourceKey => ({ resourceType: "workflow_resource", resourceKey }))];
  assert.equal(slots.length, expected.length);
  assert.deepEqual(slots.map(key).sort(), expected.map(key).sort());
};

test("same-Run continuation atomically admits the complete plan to new slots and reopens idempotently", async t => {
  const f = await workflowResumeAdmissionFixture(t), before = f.admission(f.scopeResume, f.generation);
  const first = f.resume(), targetFence = f.resumeInput();
  assert.equal(first.status, "resumed");
  assertCompletePlan(first.slots, f.scopeResume.plan);
  first.slots.forEach(slot => { assertFence(slot, targetFence); assert.ok(!before.slotIds.includes(slot.id)); });
  assert.deepEqual(f.admission(f.scopeResume, f.generation).fence, {
    workUnitId: targetFence.workUnitId, attemptId: targetFence.attemptId,
    runtimeInstanceId: targetFence.runtimeInstanceId, fencingToken: targetFence.fencingToken,
  });
  f.reopen();
  const replay = assertNoWrites(f, () => f.resume());
  assert.equal(replay.status, "duplicate");
  assert.deepEqual(slotIds(replay), slotIds(first));
  assert.equal(activeSlots(f).length, 6);
  assert.equal(assertNoWrites(f, () => f.store.releaseRuntimeSemaphoreSlotsForAttempt(f.source.fence, f.at(11), "stale source")), 0);
  assert.equal(assertNoWrites(f, () => f.transfer(f.scopeResume, f.generation, f.source)).status, "stale");
});

test("competing same-Run SQLite recoverers produce one new complete slot group", async t => {
  const f = await workflowResumeAdmissionFixture(t);
  const results = await admissionRace(t, f, [0, 1].map(() => ({ method: "resumeChannelWorkflowStepStartAdmission", input: f.resumeInput() })));
  assert.deepEqual(results.map(result => result.status).sort(), ["duplicate", "resumed"]);
  assert.deepEqual(slotIds(results[0]), slotIds(results[1]));
  assert.equal(activeSlots(f).length, 6);
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`same-Run continuation rejects an exact stale target/source ${field}`, async t => {
    const f = await workflowResumeAdmissionFixture(t);
    assert.equal(assertNoWrites(f, () => f.resume({ [field]: "stale" })).status, "stale");
    assert.equal(assertNoWrites(f, () => f.resume({ sourceFence: { ...f.source.fence, [field]: "stale" } })).status, "stale");
  });
}

for (const overrides of [
  { continuationId: "unknown" }, { expectedContinuationRevision: 0 }, { claimOwner: "old-host" },
  { claimToken: "old-token" }, { nowTick: 69 }, { ownerLease: "old-lease" },
]) {
  test(`same-Run continuation requires its live durable claim and owner: ${Object.keys(overrides)[0]}`, async t => {
    const f = await workflowResumeAdmissionFixture(t);
    const input = { ...overrides };
    if (input.nowTick) { input.now = f.at(input.nowTick); delete input.nowTick; }
    if (input.ownerLease) { input.owner = { ...f.generation.owner, leaseId: input.ownerLease }; delete input.ownerLease; }
    assert.equal(assertNoWrites(f, () => f.resume(input)).status, "stale");
  });
}

test("same-Run continuation retains admission for active or unconfirmed source lifetimes", async t => {
  const f = await workflowResumeAdmissionFixture(t);
  // Preparing the replacement already retires the old slots; inject contradictory durable ownership explicitly.
  f.store.database.prepare("UPDATE runtime_semaphore_slots SET status='active',released_at=NULL,release_reason=NULL WHERE attempt_id=?")
    .run(f.source.attempt.id);
  assert.equal(assertNoWrites(f, () => f.resume()).code, "workflow_admission_source_unconfirmed");
  f.store.database.prepare("UPDATE runtime_semaphore_slots SET status='released',released_at=?,release_reason='test confirmed stop' WHERE attempt_id=?")
    .run(f.at(7), f.source.attempt.id);
  f.store.database.prepare("UPDATE work_unit_attempts SET started_at=? WHERE id=?").run(f.at(6), f.source.attempt.id);
  assert.equal(assertNoWrites(f, () => f.resume()).code, "workflow_admission_source_unconfirmed");
});

test("same-Run continuation refuses a partial plan or pre-acquired target slots", async t => {
  const f = await workflowResumeAdmissionFixture(t);
  const admission = { ...f.scopeResume.plan, resourceKeys: [] };
  assert.equal(assertNoWrites(f, () => f.resume({ admission })).code, "workflow_admission_plan_mismatch");
  assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.slotInput({ attempt: f.target.attempt, fence: f.resumeInput() }, f.scopeResume.plan.entries[0])));
  assert.equal(assertNoWrites(f, () => f.resume()).code, "workflow_admission_unplanned_attempt_slots");
});

test("same-Run continuation counts preparing reservations and rolls back on capacity conflict", async t => {
  const f = await workflowResumeAdmissionFixture(t);
  f.begin(f.scope("resume-blocker", { plan: f.scopeResume.plan }));
  const result = assertNoWrites(f, () => f.resume());
  assert.equal(result.status, "conflict");
  assert.equal(result.resourceType, "workflow_resource");
  assert.equal(activeSlots(f).length, 0);
});

for (const stage of ["slot", "receipt"]) {
  test(`same-Run continuation rolls back every slot and receipt after a late ${stage} write failure`, async t => {
    const f = await workflowResumeAdmissionFixture(t);
    const trigger = stage === "slot"
      ? "BEFORE INSERT ON runtime_semaphore_slots WHEN NEW.resource_type='runner'"
      : "BEFORE UPDATE OF slot_id ON workflow_step_admission_entries WHEN OLD.resource_type='runner'";
    f.store.database.exec(`CREATE TRIGGER p1c_resume_fault ${trigger} BEGIN SELECT RAISE(ABORT,'p1c-resume-fault'); END`);
    const before = f.snapshot();
    assert.throws(() => f.resume(), /p1c-resume-fault/);
    assert.deepEqual(f.snapshot(), before);
  });
}

test("user-input successor atomically reacquires the full plan for its new lease, Run and fence", async t => {
  const f = await workflowUserInputAdmissionFixture(t), source = f.admission(f.scopeInput, f.generation);
  assert.notEqual(f.binding.workflowStartOwner.leaseId, f.sourceOwner.leaseId);
  assert.equal(f.store.getChannelWorkflowStepStartAdmission(f.scopeInput.step.id, f.binding.workflowStartOwner), undefined);
  const result = f.recover();
  assert.equal(result.status, "ready");
  assertCompletePlan(result.semaphores, f.scopeInput.plan);
  result.semaphores.forEach(slot => { assertFence(slot, f.binding.fence); assert.ok(!source.slotIds.includes(slot.id)); });
  const admission = f.store.getChannelWorkflowStepStartAdmission(f.scopeInput.step.id, f.binding.workflowStartOwner);
  assert.equal(admission.runId, f.binding.runId);
  assert.deepEqual(admission.fence, f.binding.fence);
  assert.deepEqual([...admission.slotIds].sort(), semaphoreIds(result));
  assert.equal(f.admission(f.scopeInput, f.generation), undefined);
  assert.equal(assertNoWrites(f, () => f.release(f.scopeInput, f.generation, f.source)).status, "stale");
  assert.equal(assertNoWrites(f, () => f.transfer(f.scopeInput, f.generation, f.source)).status, "stale");
  f.reopen();
  const replay = assertNoWrites(f, () => f.recover());
  assert.equal(replay.status, "ready");
  assert.deepEqual(semaphoreIds(replay), semaphoreIds(result));
  assert.equal(activeSlots(f).length, 6);
  assert.equal(f.peer.database.prepare("SELECT COUNT(*) n FROM runtime_events WHERE attempt_id=? AND type='semaphore_acquired'")
    .get(f.binding.fence.attemptId).n, 6);
});

test("competing user-input SQLite recoverers share only the exact target group", async t => {
  const f = await workflowUserInputAdmissionFixture(t);
  const results = await admissionRace(t, f, [0, 1].map(() => ({ method: "recoverUserInputContinuationPrestart", input: f.recoveryInput() })));
  assert.deepEqual(results.map(result => result.status), ["ready", "ready"]);
  assert.deepEqual(semaphoreIds(results[0]), semaphoreIds(results[1]));
  assert.equal(activeSlots(f).length, 6);
});

test("user-input prestart reopen creates fresh full-group slots after a safe release, preserving old evidence", async t => {
  const f = await workflowUserInputAdmissionFixture(t), first = f.recover();
  assert.equal(first.status, "ready");
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(f.binding.fence, f.at(15), "confirmed prestart stop"), 6);
  f.reopen();
  const recovered = f.recover({ now: f.at(16) });
  assert.equal(recovered.status, "ready");
  assertCompletePlan(recovered.semaphores, f.scopeInput.plan);
  recovered.semaphores.forEach(slot => assert.ok(!semaphoreIds(first).includes(slot.id)));
  assert.equal(f.peer.database.prepare("SELECT COUNT(*) n FROM runtime_events WHERE attempt_id=? AND type='semaphore_acquired'")
    .get(f.binding.fence.attemptId).n, 12);
  assert.equal(activeSlots(f).length, 6);
});

for (const change of ["missing", "exclusive", "provider", "limit"]) {
  test(`user-input recovery rejects incomplete or changed frozen plans: ${change}`, async t => {
    const f = await workflowUserInputAdmissionFixture(t), workflowAdmission = structuredClone(f.scopeInput.plan);
    if (change === "exclusive") workflowAdmission.resourceKeys = [];
    if (change === "provider") workflowAdmission.entries[0].resourceKey = "other-provider";
    if (change === "limit") workflowAdmission.entries[0].limit++;
    assert.equal(assertNoWrites(f, () => f.recover({ workflowAdmission: change === "missing" ? undefined : workflowAdmission })).status, "changed");
  });
}

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`user-input recovery requires the exact new ${field}`, async t => {
    const f = await workflowUserInputAdmissionFixture(t);
    assert.equal(assertNoWrites(f, () => f.recover({ sourceFence: { ...f.binding.fence, [field]: "stale" } })).status, "changed");
    const input = f.recoveryInput();
    assert.equal(assertNoWrites(f, () => f.recover({ leases: input.leases.map(lease => ({ ...lease, [field]: "stale" })) })).status, "changed");
  });
}

for (const change of ["claim-owner", "claim-token", "claim-revision", "binding-ref", "expired-claim", "target-lease", "source-lease", "source-fence"]) {
  test(`user-input recovery fences immutable lineage and live lease/claim: ${change}`, async t => {
    const f = await workflowUserInputAdmissionFixture(t), input = f.recoveryInput();
    if (change === "claim-owner") input.claim = { ...input.claim, ownerId: "stale" };
    if (change === "claim-token") input.claim = { ...input.claim, claimToken: "stale" };
    if (change === "claim-revision") input.claim = { ...input.claim, expectedRevision: input.claim.expectedRevision + 1 };
    if (change === "binding-ref") input.bindingRef = { ...input.bindingRef, fingerprint: "stale" };
    if (change === "expired-claim") input.now = f.at(73);
    if (change === "target-lease") f.store.database.prepare("UPDATE resource_leases SET expires_at=? WHERE id=?")
      .run(f.at(14), f.binding.workflowStartOwner.leaseId);
    if (change === "source-lease") f.store.database.prepare("UPDATE resource_leases SET release_reason='unknown' WHERE id=?").run(f.sourceOwner.leaseId);
    if (change === "source-fence") f.store.database.prepare("UPDATE work_unit_attempts SET fencing_token='stale-source' WHERE id=?").run(f.source.attempt.id);
    assert.equal(assertNoWrites(f, () => f.store.recoverUserInputContinuationPrestart(input)).status, "changed");
  });
}

for (const snapshot of [null, [], "unknown", 1, {}, { workflowStartOwner: null }]) {
  test(`user-input recovery guards unknown requestSnapshot without unsafe property access: ${JSON.stringify(snapshot)}`, async t => {
    const f = await workflowUserInputAdmissionFixture(t);
    f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), f.source.run.id);
    assert.equal(assertNoWrites(f, () => f.recover()).status, "changed");
  });
}

test("user-input recovery refuses source active slots, changed stopping proof and ordinary target acquisition", async t => {
  const f = await workflowUserInputAdmissionFixture(t);
  f.store.database.prepare("UPDATE runtime_semaphore_slots SET status='active',released_at=NULL,release_reason=NULL WHERE attempt_id=?").run(f.source.attempt.id);
  assert.equal(assertNoWrites(f, () => f.recover()).status, "changed");
  f.store.database.prepare("UPDATE runtime_semaphore_slots SET status='released',released_at=?,release_reason='user_input_yielded' WHERE attempt_id=?")
    .run(f.at(10), f.source.attempt.id);
  f.store.database.prepare("UPDATE work_unit_attempts SET ended_at=? WHERE id=?").run(f.at(12), f.source.attempt.id);
  assert.equal(assertNoWrites(f, () => f.recover()).status, "changed");
  f.store.database.prepare("UPDATE work_unit_attempts SET ended_at=? WHERE id=?").run(f.at(10), f.source.attempt.id);
  assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.recoveryInput().semaphores[0]));
  assert.equal(assertNoWrites(f, () => f.recover()).status, "changed");
});

test("user-input recovery accounts for preparing reservations and rolls back leases and partial slots on busy", async t => {
  const f = await workflowUserInputAdmissionFixture(t);
  f.begin(f.scope("input-blocker", { plan: f.scopeInput.plan }));
  const result = assertNoWrites(f, () => f.recover());
  assert.equal(result.status, "busy");
  assert.equal(result.kind, "semaphore");
  assert.equal(result.resourceType, "workflow_resource");
  assert.equal(activeSlots(f).length, 0);
  assert.ok(f.admission(f.scopeInput, f.generation));
});

for (const stage of ["slot", "evidence", "receipt", "owner"]) {
  test(`user-input recovery rolls back the entire group and lease handoff on ${stage} write failure`, async t => {
    const f = await workflowUserInputAdmissionFixture(t);
    const trigger = {
      slot: "BEFORE INSERT ON runtime_semaphore_slots WHEN NEW.resource_type='runner'",
      evidence: "BEFORE INSERT ON runtime_events WHEN NEW.type='semaphore_acquired'",
      receipt: "BEFORE UPDATE OF slot_id ON workflow_step_admission_entries WHEN OLD.resource_type='runner'",
      owner: "BEFORE UPDATE OF lease_id ON workflow_step_admissions",
    }[stage];
    f.store.database.exec(`CREATE TRIGGER p1c_recover_fault ${trigger} BEGIN SELECT RAISE(ABORT,'p1c-recover-fault'); END`);
    const before = f.snapshot();
    assert.throws(() => f.recover(), /p1c-recover-fault/);
    assert.deepEqual(f.snapshot(), before);
    assert.ok(f.admission(f.scopeInput, f.generation));
  });
}

test("user-input recovery rolls back an ignored final owner CAS after all resource writes", async t => {
  const f = await workflowUserInputAdmissionFixture(t);
  f.store.database.exec("CREATE TRIGGER p1c_veto_owner BEFORE UPDATE OF lease_id ON workflow_step_admissions BEGIN SELECT RAISE(IGNORE); END");
  assert.equal(assertNoWrites(f, () => f.recover()).status, "changed");
  assert.ok(f.admission(f.scopeInput, f.generation));
});
