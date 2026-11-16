import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowIntegrationRoundInputs, workflowIntegrationRoundInputsDigest, workflowIsolationScopePlanDigest,
  workflowIsolationDigest, toRuntimeAttemptFence } from "../dist/index.js";
import { workflowMergeApplyWorkspaceBusy } from "../dist/storage/sqlite/workflow-merge-lease-guard.js";
import { SqliteRuntimeSemaphoreStore } from "../dist/storage/sqlite/runtime-semaphore-store.js";
import { workflowAdmissionFixture, admissionRace } from "./support/workflow-step-admission-fixture.mjs";
import { workflowParallelParentFixture } from "./support/workflow-parallel-parent-fixture.mjs";

test("immutable opt-in rejects malformed policies, binds its digest, and preserves the absent-policy digest", async t => {
  const f = await workflowParallelParentFixture(t, { create: false });
  const legacy = { ...f.inputs }; delete legacy.parallelExecution;
  assert.equal(workflowIntegrationRoundInputsDigest(legacy), workflowIsolationDigest(normalizeWorkflowIntegrationRoundInputs(legacy), "wir1_"));
  assert.equal("parallelExecution" in normalizeWorkflowIntegrationRoundInputs(legacy), false);
  assert.equal(workflowIntegrationRoundInputsDigest({ ...legacy, parallelExecution: undefined }), workflowIntegrationRoundInputsDigest(legacy));
  assert.notEqual(workflowIntegrationRoundInputsDigest(f.inputs), workflowIntegrationRoundInputsDigest(legacy));
  for (const parallelExecution of [null, {}, { ...f.inputs.parallelExecution, profile: "unknown" },
    { ...f.inputs.parallelExecution, writeLockScope: "workspace" }, { ...f.inputs.parallelExecution, extra: true },
    ...[1, 5, 2.1, "2", NaN].map(maxConcurrentSteps => ({ ...f.inputs.parallelExecution, maxConcurrentSteps }))]) {
    assert.equal(normalizeWorkflowIntegrationRoundInputs({ ...f.inputs, parallelExecution }), undefined);
  }
});

test("preparing-before-Run owns only its frozen bound_path via exact durable Task/WorkUnit/Attempt and task lease", async t => {
  const f = await workflowParallelParentFixture(t), prepared = f.prepareOriginal();
  assert.equal(f.store.getRun(prepared.runId), undefined);
  assert.equal(f.store.getWorkUnit(prepared.unit.id).linkedRunId, undefined);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM workflow_isolation_bindings").get().n, 0);
  const lease = f.store.acquireResourceLease(prepared.leaseInput);
  assert.ok(lease, "the real pre-persistRun order must be admitted");
  f.persistOriginal(prepared); f.readyOriginal(prepared);
  assert.equal(f.store.getChannelWorkflowStep(prepared.plan.workflowStepId).metadata.startOwner.phase, "linked");
  assert.equal(f.parent().state, "held");
});

for (const fault of ["no-task-lease", "foreign-run-id", "foreign-root", "workspace-lock", "channel-lock", "stale-attempt",
  "stale-runtime", "stale-token", "unplanned-owner", "request-pin", "request-owner", "unit-owner", "request-task", "policy-drift", "admission-entry"]) {
  test(`pre-Run parent guard rejects ${fault} without writing a side-effect lease`, async t => {
    const f = await workflowParallelParentFixture(t), prepared = f.prepareOriginal(0, { taskLease: fault !== "no-task-lease" });
    const input = { ...prepared.leaseInput }, db = f.store.database;
    if (fault === "foreign-run-id") input.ownerId = "unbound-proposed-run";
    if (fault === "foreign-root") input.resourceKey = f.plans[1].executionRoot;
    if (fault === "workspace-lock") { input.resourceType = "workspace"; input.resourceKey = f.channel.workspaceId; }
    if (fault === "channel-lock") { input.resourceType = "channel"; input.resourceKey = f.channel.id; }
    if (fault === "stale-attempt") input.attemptId = "stale-attempt";
    if (fault === "stale-runtime") input.runtimeInstanceId = "stale-runtime";
    if (fault === "stale-token") input.fencingToken = "999";
    if (fault === "unplanned-owner") { input.ownerType = "work_unit_attempt"; input.ownerId = prepared.attempt.id; }
    if (["request-pin", "request-owner", "request-task"].includes(fault)) {
      const request = structuredClone(prepared.unit.request);
      if (fault === "request-pin") request.workflowIsolationPlan.planDigest = "forged";
      if (fault === "request-owner") request.workflowStartOwner.authorityBasis = "forged";
      if (fault === "request-task") request.task.id = "foreign-task";
      db.prepare("UPDATE work_units SET request_json=? WHERE id=?").run(JSON.stringify(request), prepared.unit.id);
    }
    if (fault === "unit-owner") db.prepare("UPDATE work_units SET owner_id='foreign-task' WHERE id=?").run(prepared.unit.id);
    if (fault === "policy-drift") f.store.updateChannel(f.channel.id,
      { runtimePolicy: { ...f.channel.runtimePolicy, writeLockScope: "workspace" } }, f.at(4));
    if (fault === "admission-entry") db.prepare("DELETE FROM workflow_step_admission_entries WHERE task_id=? AND resource_type='runner'").run(prepared.task.id);
    assert.equal(f.noWrites(() => f.store.acquireResourceLease(input)), undefined);
  });
}

test("two same-round siblings reserve and transfer concurrently while the frozen limit rejects a third", async t => {
  const f = await workflowParallelParentFixture(t), first = f.prepareOriginal(0), second = f.prepareOriginal(1);
  assert.ok(f.store.acquireResourceLease(first.leaseInput));
  assert.ok(f.peer.acquireResourceLease(second.leaseInput));
  const thirdInput = f.input(f.members[2]);
  assert.equal(f.noWrites(() => f.store.beginChannelWorkflowStepStart(thirdInput)).status, "conflict");
  f.persistOriginal(first); f.readyOriginal(first); f.persistOriginal(second); f.readyOriginal(second);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 14);
  const unplanned = { workspaceId: f.channel.workspaceId, ...first.fence, ownerType: "work_unit_attempt", ownerId: first.attempt.id,
    resourceType: "channel_parallel", resourceKey: "unplanned", limit: 4, acquiredAt: f.at(12), expiresAt: f.at(100) };
  assert.equal(f.noWrites(() => f.store.acquireRuntimeSemaphoreSlot(unplanned)), undefined);
  assert.equal(f.noWrites(() => f.store.resumeChannelWorkflowStepStartAdmission({ workflowStepId: first.plan.workflowStepId,
    owner: first.generation.owner, runId: first.runId, ...first.fence, admission: first.plan.resourcePlan,
    now: f.at(12), expiresAt: f.at(100) })).code, "workflow_admission_isolated_resume_unsupported");
});

test("parallel generation rollover cannot move the persistent parent or its original reservations", async t => {
  const f = await workflowParallelParentFixture(t), prepared = f.prepareOriginal();
  const semaphores = new SqliteRuntimeSemaphoreStore({ database: f.store.database }, f.store);
  assert.ok(f.store.acquireResourceLease(prepared.leaseInput)); f.persistOriginal(prepared); f.readyOriginal(prepared);
  assert.equal(f.isolation.advanceIntegrationRound({ commandId: "block-parallel-round", roundId: f.roundId, generation: 1,
    expectedRevision: f.round().revision, from: "preparing", to: "blocked", reason: "Stop before integration",
    writer: prepared.writer, now: f.at(12) }).status, "updated");
  assert.equal(f.round().writerBindingId, prepared.writer.bindingId);
  assert.deepEqual(f.noWrites(() => f.isolation.beginIntegrationRoundGeneration({ commandId: "parallel-next-generation",
    roundId: f.roundId, expectedGeneration: 1, expectedRevision: f.round().revision, writer: prepared.writer,
    inputs: { ...f.inputs, integration: { executionRoot: `${f.root}/parallel-integration-2`, worktreeId: "parallel-integration-2",
      branchRef: "refs/heads/ling/parallel-integration-2" } }, now: f.at(13) })),
  { status: "conflict", code: "workflow_isolation.parallel_generation_requires_new_round" });
  assert.equal(f.isolation.getIntegrationRound(f.roundId, 2), undefined);
  assert.equal(f.parent().state, "held");
  assert.equal(f.noWrites(() => semaphores.ensureRuntimeSemaphoreSlotForAttempt(f.slotInput(prepared,
    prepared.plan.resourcePlan.entries[0], { acquiredAt: f.at(14) }))).status, "existing");
});

test("replacing a real Attempt neither lets its old fence reacquire resources nor grants its successor the isolated admission", async t => {
  const f = await workflowParallelParentFixture(t), prepared = f.prepareOriginal();
  const semaphores = new SqliteRuntimeSemaphoreStore({ database: f.store.database }, f.store);
  const peerSemaphores = new SqliteRuntimeSemaphoreStore({ database: f.peer.database }, f.peer);
  assert.ok(f.store.acquireResourceLease(prepared.leaseInput)); f.persistOriginal(prepared); f.readyOriginal(prepared);
  const entries = [...prepared.plan.resourcePlan.entries, ...prepared.plan.resourcePlan.resourceKeys.map(resourceKey =>
    ({ resourceType: "workflow_resource", resourceKey, limit: 1 }))];
  const slots = f.store.listRuntimeSemaphoreSlots({ workUnitId: prepared.unit.id, status: "active" });
  assert.equal(slots.length, entries.length);
  for (const entry of entries) {
    const result = f.noWrites(() => semaphores.ensureRuntimeSemaphoreSlotForAttempt(f.slotInput(prepared, entry, { acquiredAt: f.at(12) })));
    assert.equal(result.status, "existing");
    assert.equal(result.slot.id, slots.find(slot => slot.resourceType === entry.resourceType && slot.resourceKey === entry.resourceKey).id);
  }
  const successor = f.store.createWorkUnitAttempt({ id: "parallel-successor-attempt", workUnitId: prepared.unit.id, attemptNumber: 2,
    runtimeInstanceId: "parallel-successor-host", runnerId: "pi", now: f.at(13) }), successorFence = toRuntimeAttemptFence(successor);
  assert.equal(f.store.getWorkUnitAttempt(prepared.attempt.id).status, "lost");
  assert.equal(f.store.getWorkUnit(prepared.unit.id).activeAttemptId, successor.id);
  assert.notEqual(successor.fencingToken, prepared.fence.fencingToken);
  assert.deepEqual(f.store.listResourceLeases({ attemptId: prepared.attempt.id, status: "active" }), []);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ workUnitId: prepared.unit.id, status: "active" }), []);
  for (const fence of [prepared.fence, successorFence]) {
    assert.equal(f.noWrites(() => f.peer.acquireResourceLease({ ...prepared.leaseInput, ...fence, acquiredAt: f.at(14) })), undefined);
    for (const entry of entries) {
      const input = f.slotInput(prepared, entry, { ...fence, ownerId: fence.attemptId, acquiredAt: f.at(14) });
      assert.equal(f.noWrites(() => f.peer.acquireRuntimeSemaphoreSlot(input)), undefined);
      assert.deepEqual(f.noWrites(() => peerSemaphores.ensureRuntimeSemaphoreSlotForAttempt(input)), { status: "changed" });
    }
  }
  assert.ok(f.store.acquireResourceLease({ ...prepared.leaseInput, ...successorFence, resourceType: "task",
    resourceKey: prepared.task.id, acquiredAt: f.at(14) }), "the current successor fence remains valid outside isolated side-effect admission");
  assert.equal(f.parent().state, "held");
});

test("preparing reservation is atomic across independent SQLite writers and exclusive declared resources remain exclusive", async t => {
  const f = await workflowParallelParentFixture(t, { resources: () => ["port:17001"] });
  const results = await admissionRace(t, f, f.members.slice(0, 2).map(member => ({ method: "beginChannelWorkflowStepStart", input: f.input(member) })));
  assert.deepEqual(results.map(result => result.status).sort(), ["begun", "conflict"]);
});

for (const existing of ["writer", "preparing", "runtime-slot"]) {
  test(`parallel parent acquisition rejects a pre-existing ordinary ${existing} in the same transaction`, async t => {
    const f = await workflowParallelParentFixture(t, { create: false });
    if (existing === "writer") assert.ok(f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId,
      resourceType: "bound_path", resourceKey: f.cwd, ownerType: "system", ownerId: "ordinary-writer", acquiredAt: f.at(0), expiresAt: f.at(300) }));
    if (existing === "preparing") f.begin(f.scope("ordinary", { plan: { entries: [
      { resourceType: "provider", resourceKey: "ordinary", limit: 4 }, { resourceType: "runner", resourceKey: "pi", limit: 4 },
      { resourceType: "channel_parallel", resourceKey: f.channel.id, limit: 4 }], resourceKeys: [] } }));
    if (existing === "runtime-slot") {
      const outsider = f.outsider("ordinary");
      assert.equal(f.store.acquireRuntimeSemaphoreSlot({ workspaceId: f.channel.workspaceId, ...outsider.fence, ownerType: "work_unit_attempt",
        ownerId: outsider.attempt.id, resourceType: "provider", resourceKey: "ordinary", limit: 4, acquiredAt: f.at(3), expiresAt: f.at(300) }).status, "active");
    }
    assert.equal(f.noWrites(() => f.isolation.createIntegrationRound({ roundId: f.roundId, inputs: f.inputs, now: f.at(4) })).code,
      "workflow_isolation.parallel_parent_busy");
  });
}

test("held parent rejects foreign round and ordinary writers bidirectionally, and never disappears on TTL or reopen", async t => {
  const f = await workflowParallelParentFixture(t);
  assert.equal(f.noWrites(() => f.isolation.createIntegrationRound({ roundId: "foreign-round", inputs: { ...f.inputs,
    integration: { ...f.inputs.integration, executionRoot: `${f.root}/foreign-integration`, worktreeId: "foreign", branchRef: "refs/heads/foreign" } }, now: f.at(1) })).code,
  "workflow_isolation.parallel_parent_busy");
  for (const resourceType of ["workspace", "channel", "bound_path"]) assert.equal(f.noWrites(() => f.store.acquireResourceLease({
    workspaceId: f.channel.workspaceId, resourceType, resourceKey: f.cwd, ownerType: "system", ownerId: "ordinary",
    acquiredAt: f.at(1), expiresAt: f.at(300) })), undefined);
  assert.equal(f.store.expireResourceLeases(f.at(10000)), 0);
  f.reopenIsolation();
  assert.equal(f.parent().state, "held");
  assert.equal(f.noWrites(() => f.reconcile(f.at(10000))).status, "retained");
  assert.equal(workflowMergeApplyWorkspaceBusy(f.store.database, f.channel.workspaceId), true);
  assert.equal(workflowMergeApplyWorkspaceBusy(f.store.database, f.channel.workspaceId, { roundId: f.roundId, generation: 1 }), false);
});

test("no-parent legacy ordinary runs retain normal side-effect lease and runtime slot admission", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("legacy"), generation = f.begin(scope), prepared = f.prepare(scope, generation, "legacy");
  for (const ownerType of ["run", "work_unit_attempt", "system"]) for (const resourceType of ["workspace", "channel", "bound_path"]) {
    const input = { workspaceId: f.channel.workspaceId, resourceType, resourceKey: `legacy-${ownerType}-${resourceType}`,
      ownerType, ownerId: ownerType === "run" ? prepared.run.id : ownerType === "system" ? "legacy-system" : prepared.attempt.id,
      acquiredAt: f.at(4), expiresAt: f.at(300) };
    if (ownerType !== "system") {
      assert.equal(f.store.acquireResourceLease(input), undefined, "unfenced runtime owners were already rejected before parallel parents");
      assert.equal(f.store.acquireResourceLease({ ...input, ...prepared.fence, fencingToken: "stale" }), undefined);
    }
    assert.ok(f.store.acquireResourceLease({ ...input, ...(ownerType === "system" ? {} : prepared.fence) }));
  }
  assert.equal(f.store.acquireRuntimeSemaphoreSlot(f.slotInput(prepared, { resourceType: "provider", resourceKey: "legacy", limit: 4 })).status, "active");
});

for (const outcome of ["cancelled", "failed"]) {
  test(`${outcome} fully drained workflow releases its parent without changing business state or allowing isolated resume`, async t => {
    const f = await workflowParallelParentFixture(t), prepared = f.prepareOriginal();
    const semaphores = new SqliteRuntimeSemaphoreStore({ database: f.store.database }, f.store);
    assert.ok(f.store.acquireResourceLease(prepared.leaseInput));
    f.persistOriginal(prepared); f.readyOriginal(prepared); f.startOriginal(prepared);
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
    f.trackOriginal(prepared);
    const originalSlot = f.slotInput(prepared, prepared.plan.resourcePlan.entries[0], { acquiredAt: f.at(21) });
    if (outcome === "cancelled") {
      assert.equal(f.noWrites(() => semaphores.ensureRuntimeSemaphoreSlotForAttempt(originalSlot)).status, "existing");
      assert.ok(f.store.updateWorkUnitAttemptStatus({ ...prepared.fence, status: "started", abortRequestedAt: f.at(21), now: f.at(21) }));
      assert.equal(f.store.getRun(prepared.runId).status, "running");
      assert.equal(f.store.getHostAttemptCompletion(prepared.source).drainedAt, undefined);
      assert.equal(f.noWrites(() => f.store.acquireResourceLease({ ...prepared.leaseInput, acquiredAt: f.at(21) })), undefined);
      assert.equal(f.noWrites(() => f.store.acquireRuntimeSemaphoreSlot(originalSlot)), undefined);
      assert.deepEqual(f.noWrites(() => semaphores.ensureRuntimeSemaphoreSlotForAttempt(originalSlot)), { status: "changed" });
    }
    f.stopOriginal(prepared, outcome); f.stopWorkflow(outcome);
    assert.equal(f.noWrites(() => f.reconcile()).status, "retained");
    t.mock.timers.setTime(Date.parse(f.at(30))); await prepared.drain();
    assert.equal(f.noWrites(() => f.reconcile()).status, "retained", "drain without releasing actual resources is insufficient");
    f.releaseOriginal(prepared);
    const before = f.snapshotIsolation();
    assert.deepEqual(f.reconcile(), { status: "released" });
    assert.deepEqual(f.snapshotIsolation(), before, "reconciliation changes only the persistent parent fence");
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, outcome);
    assert.equal(f.parent().state, "released");
    assert.deepEqual(f.reconcile(), { status: "released" });
    assert.equal(f.noWrites(() => f.store.acquireResourceLease({ ...prepared.leaseInput, acquiredAt: f.at(31) })), undefined);
    assert.equal(f.noWrites(() => f.store.acquireRuntimeSemaphoreSlot({ ...originalSlot, acquiredAt: f.at(31) })), undefined);
    assert.deepEqual(f.noWrites(() => semaphores.ensureRuntimeSemaphoreSlotForAttempt({ ...originalSlot, acquiredAt: f.at(31) })), { status: "changed" });
    assert.ok(f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "bound_path", resourceKey: f.cwd,
      ownerType: "system", ownerId: "next-writer", acquiredAt: f.at(31), expiresAt: f.at(300) }));
    assert.equal(f.store.releaseResourceLeasesForOwner("system", "next-writer", f.at(31)), 1);
    f.reopenIsolation();
    assert.equal(f.parent().state, "released");
    const task = f.store.createTask({ channelId: f.channel.id, title: "Next ordinary writer", prompt: "Write in the canonical workspace.",
      assigneeTeammateId: prepared.task.assigneeTeammateId }, f.at(31));
    const run = f.store.createRun({ id: "next-ordinary-run", cwd: f.cwd, taskId: task.id, channelId: f.channel.id,
      teammateId: task.assigneeTeammateId, providerName: "fixture", providerModel: "fixture", taskSnapshot: task,
      providerSnapshot: {}, requestSnapshot: { cwd: f.cwd, task }, createdAt: f.at(31) });
    const unit = f.store.createWorkUnit({ id: "next-ordinary-unit", workspaceId: f.channel.workspaceId, kind: "task_run",
      ownerType: "task", ownerId: task.id, taskId: task.id, channelId: f.channel.id, teammateId: task.assigneeTeammateId,
      runnerId: "pi", idempotencyKey: `run:${run.id}`, createdByActor: "system", request: { cwd: f.cwd, task }, now: f.at(31) });
    f.store.linkRunToWorkUnit(run.id, unit.id, f.at(31));
    const attempt = f.store.createWorkUnitAttempt({ id: "next-ordinary-attempt", workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: "next-ordinary-host", runnerId: "pi", now: f.at(31) }), fence = toRuntimeAttemptFence(attempt);
    assert.ok(f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "bound_path", resourceKey: f.cwd,
      ownerType: "run", ownerId: run.id, ...fence, acquiredAt: f.at(31), expiresAt: f.at(300) }));
    for (const entry of prepared.plan.resourcePlan.entries.filter(entry => entry.resourceType !== "channel_parallel" || entry.resourceKey === f.channel.id)) {
      assert.equal(f.store.acquireRuntimeSemaphoreSlot(f.slotInput({ attempt, fence }, entry, { acquiredAt: f.at(31) })).status, "active");
    }
  });
}

test("one drained sibling never releases a cancelled parent's other original Host lifetime", async t => {
  const f = await workflowParallelParentFixture(t), originals = [f.prepareOriginal(0), f.prepareOriginal(1)];
  for (const prepared of originals) { assert.ok(f.store.acquireResourceLease(prepared.leaseInput));
    f.persistOriginal(prepared); f.readyOriginal(prepared); f.startOriginal(prepared); }
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
  for (const prepared of originals) { f.trackOriginal(prepared); f.stopOriginal(prepared, "cancelled"); }
  f.stopWorkflow("cancelled");
  t.mock.timers.setTime(Date.parse(f.at(30))); await originals[0].drain(); f.releaseOriginal(originals[0]);
  assert.equal(f.noWrites(() => f.reconcile()).status, "retained");
  await originals[1].drain(); f.releaseOriginal(originals[1]);
  assert.deepEqual(f.reconcile(), { status: "released" });
});

for (const outcome of ["cancelled", "failed"]) test(`${outcome} with unverified Host effects remains held after resource TTL`, async t => {
  const f = await workflowParallelParentFixture(t), prepared = f.prepareOriginal();
  assert.ok(f.store.acquireResourceLease(prepared.leaseInput)); f.persistOriginal(prepared); f.readyOriginal(prepared); f.startOriginal(prepared);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
  f.trackOriginal(prepared, () => false); f.stopOriginal(prepared, outcome); f.stopWorkflow(outcome);
  t.mock.timers.setTime(Date.parse(f.at(30))); await prepared.drain(); f.releaseOriginal(prepared);
  f.store.expireResourceLeases(f.at(10000));
  assert.equal(f.noWrites(() => f.reconcile(f.at(10000))).status, "retained");
  assert.equal(f.parent().state, "held");
});

for (const fault of ["missing-workflow-entry", "wrong-limit", "extra-exclusive-parent", "missing-worktree", "foreign-root"]) {
  test(`scope plan rejects incomplete parallel inventory: ${fault}`, async t => {
    const f = await workflowParallelParentFixture(t, { create: false });
    assert.equal(f.isolation.createIntegrationRound({ roundId: f.roundId, inputs: f.inputs, now: f.at(0) }).status, "created");
    const plan = structuredClone(f.plan);
    if (fault === "missing-workflow-entry") plan.resourcePlan.entries = plan.resourcePlan.entries.filter(entry => entry.resourceKey !== `workflow:${plan.workflowId}`);
    if (fault === "wrong-limit") plan.resourcePlan.entries.find(entry => entry.resourceType === "channel_parallel").limit = 4;
    if (fault === "extra-exclusive-parent") plan.resourcePlan.resourceKeys.push(`workflow:${plan.workflowId}`);
    if (fault === "missing-worktree") plan.resourcePlan.resourceKeys = plan.resourcePlan.resourceKeys.filter(key => !key.startsWith("worktree:"));
    if (fault === "foreign-root") plan.executionRoot = f.plans[1].executionRoot;
    plan.planDigest = workflowIsolationScopePlanDigest(plan);
    assert.equal(f.noWrites(() => f.isolation.createScopePlan({ plan, now: f.at(1) })).status, "invalid");
  });
}
