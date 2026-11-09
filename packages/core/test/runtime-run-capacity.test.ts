import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseWorkflowStepExecutionSafety, toRuntimeAttemptFence, workflowStepSafetyPlanDigest } from "../dist/index.js";
import type { AcquireRuntimeSemaphoreSlotInput, ChannelWorkflowStepMetadata, RuntimeConcurrencyLimits, RuntimeSemaphoreSlot,
  SqliteRunStore, WorkflowStepAdmissionEntry, WorkflowStepSafetyPlanV1, Task } from "../dist/index.js";
import { SqliteRuntimeConcurrencyPolicyStore } from "../dist/storage/sqlite/runtime-concurrency-policy-store.js";
import { SqliteRuntimeSemaphoreStore } from "../dist/storage/sqlite/runtime-semaphore-store.js";
import { admissionParticipant, admissionRace, workflowAdmissionFixture,
  workflowResumeAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";
import type { WorkflowAdmissionFixture, AdmissionScope, AdmissionOwner, AdmissionPreparedRun,
  AdmissionGeneration } from "./support/workflow-step-admission-fixture.mjs";
import { testDatabase } from "./support/sqlite-test-database.ts";

type SlotOwner = Pick<AdmissionOwner, "attempt" | "fence"> & { scope?: AdmissionScope };
type ResourceOptions = { provider?: string; runnerId?: string; providerLimit?: number; runnerLimit?: number;
  channelLimit?: number; resourceKeys?: string[] };
type ScopeOptions = ResourceOptions & { readonly?: boolean; metadata?: ChannelWorkflowStepMetadata; prompt?: string };
type CapacityRequest = Record<string, unknown> & { workflowStepId?: string;
  workflowSafetySnapshot?: { schemaVersion: 1; plan: { -readonly [K in keyof WorkflowStepSafetyPlanV1]: WorkflowStepSafetyPlanV1[K] } } };

const generousLimits = { maxConcurrentRuns: 64, maxReadOnlyRuns: 64, maxWorkspaceWriteRuns: 4,
  maxRunsPerProvider: 64, maxRunsPerRunner: 64 };
const policies = (store: SqliteRunStore) => new SqliteRuntimeConcurrencyPolicyStore({ database: testDatabase(store) });
const semaphores = (store: SqliteRunStore) => new SqliteRuntimeSemaphoreStore({ database: testDatabase(store) }, store);
const policyRows = (f: WorkflowAdmissionFixture) => testDatabase(f.peer).prepare("SELECT * FROM runtime_concurrency_policies ORDER BY workspace_id").all();
const snapshot = (f: WorkflowAdmissionFixture) => ({ ...f.snapshot(), runtime_concurrency_policies: policyRows(f) });
const noWrites = <T>(f: WorkflowAdmissionFixture, action: () => T): T => {
  const before = snapshot(f);
  try { return action(); }
  finally {
    assert.deepEqual(snapshot(f), before);
    for (const store of [f.store, f.peer]) {
      if (typeof testDatabase(store).isTransaction === "boolean") assert.equal(testDatabase(store).isTransaction, false);
    }
  }
};
const activeSlots = (f: WorkflowAdmissionFixture) => testDatabase(f.peer).prepare("SELECT * FROM runtime_semaphore_slots WHERE status='active' ORDER BY id").all();
const exactSlots = (f: WorkflowAdmissionFixture, current: SlotOwner) => testDatabase(f.peer).prepare(`SELECT * FROM runtime_semaphore_slots
  WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND status='active' ORDER BY id`)
  .all(current.fence.workUnitId, current.fence.attemptId, current.fence.runtimeInstanceId, current.fence.fencingToken);
const slotIds = (result: { slots: readonly RuntimeSemaphoreSlot[] }) => result.slots.map(slot => slot.id).sort();

function installPolicy(f: WorkflowAdmissionFixture, overrides: Partial<RuntimeConcurrencyLimits> = {}, store = f.store) {
  const expectedRevision = policies(store).getRuntimeConcurrencyPolicy(f.channel.workspaceId)?.revision ?? 0;
  const input = { workspaceId: f.channel.workspaceId, runtimeInstanceId: `b22-policy-${expectedRevision + 1}`,
    expectedRevision, limits: { ...generousLimits, ...overrides }, installedAt: f.at(20 + expectedRevision) };
  const result = policies(store).installRuntimeConcurrencyPolicy(input);
  assert.equal(result.status, "installed", JSON.stringify(result));
  const { expectedRevision: prior, ...expected } = input;
  assert.deepEqual(result.policy, { ...expected, enabled: true, revision: prior + 1 });
  assert.deepEqual(policies(f.peer).getRuntimeConcurrencyPolicy(f.channel.workspaceId), result.policy);
  assert.equal(policyRows(f).length, 1, "all connections must read one workspace policy row");
  return result.policy;
}

async function capacityFixture(t: TestContext) {
  const f = await workflowAdmissionFixture(t);
  f.channel = f.store.updateChannel(f.channel.id,
    { runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 64, allowReadOnlyParallel: true } }, f.at(0))!;
  return f;
}

function resourcePlan(f: WorkflowAdmissionFixture, name: string, { provider = `b22-provider-${name}`, runnerId = "pi", providerLimit = 4,
  runnerLimit = 4, channelLimit = f.channel.runtimePolicy.maxConcurrentRuns, resourceKeys = [] }: ResourceOptions = {}) {
  return f.plan({ entries: [
    { resourceType: "provider", resourceKey: provider, limit: providerLimit },
    { resourceType: "runner", resourceKey: runnerId, limit: runnerLimit },
    { resourceType: "channel_parallel", resourceKey: f.channel.id, limit: channelLimit },
  ], resourceKeys });
}

function scopeFor(f: WorkflowAdmissionFixture, name: string, { readonly = false, metadata = {}, prompt, ...options }: ScopeOptions = {}) {
  const scope = f.scope(name, { plan: resourcePlan(f, name, options), metadata });
  if (prompt !== undefined) scope.step = f.store.updateChannelWorkflowStep(scope.step.id, { prompt }, f.at(0))!;
  if (readonly) {
    const declaration: ChannelWorkflowStepMetadata = { ...f.current(scope).metadata, sideEffectClass: "analysis_readonly", requiredTools: ["read"],
      requestedRunnerId: "pi", parallelPolicy: { autoParallel: true, maxParallelSiblings: 4, resourceKeys: [] } };
    const safety = parseWorkflowStepExecutionSafety(declaration);
    assert.ok(safety);
    const plan: Omit<WorkflowStepSafetyPlanV1, "digest"> = { schemaVersion: 1, profile: "pi_host_readonly_v1", workflowId: scope.workflow.id, workflowStepId: scope.step.id,
      workspaceRoot: f.cwd, executionRoot: f.cwd, safety,
      tools: ["read", "grep", "find", "ls"], runnerId: "pi", networkAccess: false, writeRoots: [] };
    scope.step = f.store.updateChannelWorkflowStep(scope.step.id,
      { metadata: { ...declaration, safetyPlan: { ...plan, digest: workflowStepSafetyPlanDigest(plan) } } }, f.at(0))!;
    assert.equal(scope.step.metadata!.safetyPlan!.profile, "pi_host_readonly_v1");
    assert.equal(scope.step.metadata!.safetyPlan!.digest, workflowStepSafetyPlanDigest(scope.step.metadata!.safetyPlan!));
  }
  return scope;
}

function saveRequest(f: WorkflowAdmissionFixture, current: AdmissionPreparedRun, request: unknown) {
  testDatabase(f.store).prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(request), current.run.id);
}

function prepare(f: WorkflowAdmissionFixture, scope: AdmissionScope, generation: { task: Task }, name: string) {
  const runnerId = scope.plan.entries.find(entry => entry.resourceType === "runner")!.resourceKey;
  const current = { ...f.prepare(scope, generation, name, { runnerId }), scope };
  const safetyPlan = f.current(scope).metadata?.safetyPlan;
  // Controlled Host evidence in an isolated SQLite fixture; no real Provider or Runner is dispatched.
  saveRequest(f, current, { ...current.run.requestSnapshot as Record<string, unknown>, workflowStepId: scope.step.id,
    ...(safetyPlan ? { workflowSafetySnapshot: { schemaVersion: 1, plan: safetyPlan } } : {}) });
  const run = f.store.getRun(current.run.id);
  assert.ok(run);
  return { ...current, run: { ...run, requestSnapshot: run.requestSnapshot as CapacityRequest } };
}

function ordinary(f: WorkflowAdmissionFixture, name: string, options: ScopeOptions = {}) {
  const scope = scopeFor(f, name, options);
  const task = f.store.createTask({ channelId: f.channel.id, title: scope.step.title, prompt: scope.step.prompt,
    assigneeTeammateId: admissionParticipant }, f.at(2));
  return prepare(f, scope, { task }, name);
}

function batch(f: WorkflowAdmissionFixture, current: SlotOwner, overrides: Partial<AcquireRuntimeSemaphoreSlotInput> = {}) {
  const plan = current.scope?.plan ?? resourcePlan(f, current.attempt.id);
  return plan.entries.map(entry => f.slotInput(current, entry, overrides));
}

function acquire(f: WorkflowAdmissionFixture, current: SlotOwner, store = f.store, overrides: Partial<AcquireRuntimeSemaphoreSlotInput> = {}) {
  const inputs = batch(f, current, overrides), result = store.acquireRuntimeSemaphoreSlots(inputs);
  assert.equal(result.status, "acquired", JSON.stringify(result));
  assert.equal(result.slots.length, inputs.length);
  assert.equal(exactSlots(f, current).length, inputs.length);
  return result;
}

function assertNotAdmitted(f: WorkflowAdmissionFixture, current: SlotOwner) {
  assert.equal(testDatabase(f.peer).prepare("SELECT COUNT(*) AS n FROM runtime_semaphore_slots WHERE attempt_id=?")
    .get(current.attempt.id)?.n, 0, "failed admission must not leave released or expired half-group history either");
  assert.equal(testDatabase(f.peer).prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE attempt_id=? AND type='semaphore_acquired'")
    .get(current.attempt.id)?.n, 0);
}

function frozenEvidence(f: WorkflowAdmissionFixture, scope: AdmissionScope, generation: AdmissionGeneration) {
  const admission = testDatabase(f.peer).prepare("SELECT plan_json,authority_basis FROM workflow_step_admissions WHERE task_id=?")
    .get(generation.task.id);
  return { ...admission, safetyPlan: f.peer.getChannelWorkflowStep(scope.step.id)!.metadata?.safetyPlan,
    entries: testDatabase(f.peer).prepare(`SELECT resource_type,resource_key,capacity_limit FROM workflow_step_admission_entries
      WHERE task_id=? ORDER BY resource_type,resource_key`).all(generation.task.id) };
}

for (const resourceType of ["provider", "runner"] as const) {
  test(`without a policy, legacy ${resourceType} limits remain authoritative without a new workspace cap`, async t => {
    const f = await capacityFixture(t), entry = { resourceType, resourceKey: `b22-legacy-${resourceType}`, limit: 4 };
    assert.equal(policies(f.store).getRuntimeConcurrencyPolicy(f.channel.workspaceId), undefined);
    for (let index = 0; index < 4; index++) {
      assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.slotInput(f.outsider(`legacy-${index}`), entry)));
    }
    const fifth = f.outsider("legacy-fifth");
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlot(f.slotInput(fifth, entry))), undefined);
    for (let index = 0; index < 2; index++) {
      assert.ok(f.peer.acquireRuntimeSemaphoreSlot(f.slotInput(f.outsider(`legacy-independent-${index}`),
        { ...entry, resourceKey: `b22-independent-${index}` })));
    }
    assert.equal(activeSlots(f).length, 6, "no installed policy means no implicit total or conservative-write ceiling");
    assertNotAdmitted(f, fifth);
    assert.deepEqual(policyRows(f), []);
  });
}

for (const method of ["single", "batch", "ensure"]) {
  test(`${method} cannot evade workspace total capacity with different Provider and Runner identities`, async t => {
    const f = await capacityFixture(t);
    installPolicy(f, { maxConcurrentRuns: 2 });
    const left = ordinary(f, "total-left", { runnerId: "pi" }), right = ordinary(f, "total-right", { runnerId: "codex" });
    acquire(f, left); acquire(f, right, f.peer);
    const candidate = ordinary(f, "total-candidate", { runnerId: "claude" }), inputs = batch(f, candidate);
    if (method === "single") assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlot(inputs[0])), undefined);
    if (method === "batch") assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(inputs)).status, "full");
    if (method === "ensure") assert.deepEqual(noWrites(f, () => semaphores(f.peer).ensureRuntimeSemaphoreSlotForAttempt(inputs[0])), { status: "full" });
    assert.equal(activeSlots(f).length, 6);
    assertNotAdmitted(f, candidate);
    assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(left.fence, f.at(8), "controlled fixture stop"), 3);
    acquire(f, candidate, f.peer);
    assert.equal(activeSlots(f).length, 6);
  });
}

test("multiple Provider/Runner slots and ordinary duplicate acquisition count one exact Attempt, not slot rows", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  const holder = f.outsider("distinct-holder"), first = acquire(f, holder);
  const provider = batch(f, holder)[0], runner = batch(f, holder)[1];
  assert.ok(f.store.acquireRuntimeSemaphoreSlot(provider), "ordinary single acquisition retains its legacy fresh-slot semantics");
  assert.ok(f.peer.acquireRuntimeSemaphoreSlot({ ...provider, resourceKey: "b22-extra-provider" }));
  assert.ok(f.peer.acquireRuntimeSemaphoreSlot({ ...runner, resourceKey: "b22-extra-runner" }));
  assert.equal(exactSlots(f, holder).length, 6);
  const second = f.outsider("distinct-second"), third = f.outsider("distinct-third");
  acquire(f, second);
  assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(batch(f, third))).status, "full");
  assertNotAdmitted(f, third);
  const ensured = noWrites(f, () => semaphores(f.peer).ensureRuntimeSemaphoreSlotForAttempt(runner));
  assert.equal(ensured.status, "existing");
  assert.equal(ensured.slot.id, first.slots.find(slot => slot.resourceType === "runner")!.id);
});

test("channel and media slots alone do not consume a Provider/Runner execution place", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 1 });
  const auxiliary = f.outsider("auxiliary-only");
  for (const entry of [{ resourceType: "media_provider", resourceKey: "b22-media-only", limit: 4 },
    { resourceType: "channel_parallel", resourceKey: f.channel.id, limit: 64 }] satisfies WorkflowStepAdmissionEntry[]) {
    assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.slotInput(auxiliary, entry)));
  }
  const current = f.outsider("execution-after-auxiliary");
  acquire(f, current, f.peer);
  const candidate = f.outsider("execution-after-full");
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
  assertNotAdmitted(f, candidate);
  assert.equal(exactSlots(f, auxiliary).length, 2);
  assert.equal(activeSlots(f).length, 5);
});

test("retained old fence evidence and a successor of one WorkUnit count as two exact executions", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  const prior = f.outsider("retained-fence"), admitted = acquire(f, prior);
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: prior.unit.id, attemptNumber: 2,
    runtimeInstanceId: "b22-retained-successor", runnerId: "pi", now: f.at(7) });
  const successor = { unit: prior.unit, attempt, fence: toRuntimeAttemptFence(attempt) };
  // Retained legacy evidence models an older lifetime whose physical stop is still unconfirmed.
  for (const slot of admitted.slots) testDatabase(f.store).prepare(`UPDATE runtime_semaphore_slots
    SET status='active',released_at=NULL,release_reason=NULL WHERE id=?`).run(slot.id);
  acquire(f, successor, f.peer);
  assert.equal(exactSlots(f, prior).length, 3);
  assert.equal(exactSlots(f, successor).length, 3);
  const candidate = f.outsider("retained-fence-rival");
  assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
  assert.equal(noWrites(f, () => f.peer.releaseRuntimeSemaphoreSlotsForAttempt(prior.fence, f.at(8), "stale callback")), 0);
  assert.equal(exactSlots(f, successor).length, 3);
  assertNotAdmitted(f, candidate);
});

test("readonly and conservative-write caps are independent intersections, not a shared borrowable class budget", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 4, maxReadOnlyRuns: 1, maxWorkspaceWriteRuns: 1 });
  const read = ordinary(f, "class-read", { readonly: true }), write = f.outsider("class-write");
  acquire(f, read); acquire(f, write);
  for (const candidate of [ordinary(f, "class-read-full", { readonly: true }), f.outsider("class-write-full")]) {
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
    assertNotAdmitted(f, candidate);
  }
  assert.equal(activeSlots(f).length, 6, "both class ceilings apply while total capacity still has two places");
});

for (const firstClass of ["readonly", "workspace_write"]) {
  test(`total capacity still binds a mixed pool after two ${firstClass} executions`, async t => {
    const f = await capacityFixture(t);
    installPolicy(f, { maxConcurrentRuns: 3, maxReadOnlyRuns: 2, maxWorkspaceWriteRuns: 2 });
    const firstReadonly = firstClass === "readonly";
    acquire(f, ordinary(f, "intersection-one", { readonly: firstReadonly }));
    acquire(f, ordinary(f, "intersection-two", { readonly: firstReadonly }));
    acquire(f, ordinary(f, "intersection-three", { readonly: !firstReadonly }));
    const candidate = ordinary(f, "intersection-four", { readonly: !firstReadonly });
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
    assertNotAdmitted(f, candidate);
    assert.equal(activeSlots(f).length, 9);
  });
}

for (const evidence of ["prompt-only", "declaration-only", "serial-profile", "missing-snapshot", "foreign-step",
  "different-valid-plan", "invalid-snapshot-digest", "non-pi-runner", "unlinked-run", "unknown-request"]) {
  test(`active ${evidence} evidence consumes the write class after policy installation`, async t => {
    const f = await capacityFixture(t), hasProfile = evidence !== "prompt-only" && evidence !== "declaration-only";
    const suspect = ordinary(f, `untrusted-${evidence}`, { readonly: hasProfile,
      runnerId: evidence === "non-pi-runner" ? "codex" : "pi",
      prompt: "Read only. Never write files, use a shell, or contact the network.",
      ...(evidence === "declaration-only" ? { metadata: { sideEffectClass: "analysis_readonly",
        requiredTools: ["read"], parallelPolicy: { autoParallel: true, maxParallelSiblings: 4, resourceKeys: [] } } } : {}) });
    const request = structuredClone(suspect.run.requestSnapshot);
    if (evidence === "serial-profile") {
      const step = f.current(suspect.scope), plan = { ...step.metadata!.safetyPlan!, profile: "serial_v1" as const };
      plan.digest = workflowStepSafetyPlanDigest(plan);
      f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, safetyPlan: plan } }, f.at(3));
      request.workflowSafetySnapshot!.plan = plan;
    }
    if (evidence === "missing-snapshot") delete request.workflowSafetySnapshot;
    if (evidence === "foreign-step") request.workflowStepId = "b22-foreign-workflow-step";
    if (evidence === "different-valid-plan") {
      const plan = { ...request.workflowSafetySnapshot!.plan, skillFingerprint: "b22-other-controlled-host-profile" };
      request.workflowSafetySnapshot!.plan = { ...plan, digest: workflowStepSafetyPlanDigest(plan) };
      assert.notEqual(request.workflowSafetySnapshot!.plan.digest, f.current(suspect.scope).metadata!.safetyPlan!.digest);
    }
    if (evidence === "invalid-snapshot-digest") request.workflowSafetySnapshot!.plan.digest = "wsp1_invalid";
    saveRequest(f, suspect, evidence === "unknown-request" ? [] : request);
    if (evidence === "unlinked-run") testDatabase(f.store).prepare("UPDATE run_sessions SET work_unit_id=NULL WHERE id=?").run(suspect.run.id);
    acquire(f, suspect);
    installPolicy(f, { maxConcurrentRuns: 8, maxReadOnlyRuns: 8, maxWorkspaceWriteRuns: 1 });
    const candidate = f.outsider(`untrusted-candidate-${evidence}`), inputs = batch(f, candidate);
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(inputs)).status, "full");
    assertNotAdmitted(f, candidate);
    acquire(f, ordinary(f, `trusted-alongside-${evidence}`, { readonly: true }), f.peer);
    assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(suspect.fence, f.at(8), "controlled fixture stop"), 3);
    acquire(f, candidate, f.peer);
  });
}

for (const evidence of ["prompt-only", "missing-snapshot", "non-pi-runner"]) {
  test(`new ${evidence} admission cannot claim a readonly place while write capacity is full`, async t => {
    const f = await capacityFixture(t);
    installPolicy(f, { maxConcurrentRuns: 8, maxReadOnlyRuns: 8, maxWorkspaceWriteRuns: 1 });
    const holder = f.outsider(`write-holder-${evidence}`);
    acquire(f, holder);
    const candidate = ordinary(f, `candidate-${evidence}`, { readonly: evidence !== "prompt-only",
      runnerId: evidence === "non-pi-runner" ? "codex" : "pi", prompt: "This is readonly; do not write." });
    if (evidence === "missing-snapshot") {
      const request = { ...candidate.run.requestSnapshot }; delete request.workflowSafetySnapshot;
      saveRequest(f, candidate, request);
    }
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
    assertNotAdmitted(f, candidate);
    assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(holder.fence, f.at(8), "controlled fixture stop"), 3);
    acquire(f, candidate);
  });
}

test("preparing reservations and ordinary executions share total capacity and failed begin leaves no Task or half plan", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  const scope = scopeFor(f, "preparing-holder"), generation = f.begin(scope);
  assert.equal(activeSlots(f).length, 0);
  assert.equal(f.count("workflow_step_admission_entries"), 3, "one preparing plan counts once, not once per entry");
  const holder = ordinary(f, "ordinary-alongside", { runnerId: "codex" });
  acquire(f, holder, f.peer);
  const blocked = scopeFor(f, "preparing-blocked", { runnerId: "claude" }), input = f.input(blocked);
  const result = noWrites(f, () => f.peer.beginChannelWorkflowStepStart(input));
  assert.equal(result.status, "conflict");
  assert.equal(result.code, "workflow_admission_resource_conflict");
  assert.equal(f.count("workflow_step_admissions"), 1);
  assert.equal(f.count("workflow_step_admission_entries"), 3);
  const ordinaryCandidate = f.outsider("preparing-ordinary-blocked");
  assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(batch(f, ordinaryCandidate))).status, "full");
  assertNotAdmitted(f, ordinaryCandidate);
  assert.equal(f.release(scope, generation).status, "released");
  assert.equal(f.peer.beginChannelWorkflowStepStart(input).status, "begun");
  assert.equal(activeSlots(f).length, 3);
});

for (const readonly of [true, false]) {
  test(`preparing ${readonly ? "readonly" : "write"} reservations consume their class but not the other class`, async t => {
    const f = await capacityFixture(t);
    installPolicy(f, { maxConcurrentRuns: 4, maxReadOnlyRuns: 1, maxWorkspaceWriteRuns: 1 });
    const scope = scopeFor(f, "preparing-class", { readonly }), generation = f.begin(scope);
    const same = ordinary(f, "preparing-same-class", { readonly });
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, same))).status, "full");
    acquire(f, ordinary(f, "preparing-other-class", { readonly: !readonly }));
    assert.equal(f.admission(scope, generation)!.status, "preparing");
    assertNotAdmitted(f, same);
  });
}

test("a preparing non-pi resource plan cannot borrow the step's valid pi readonly profile", async t => {
  const f = await capacityFixture(t);
  const scope = scopeFor(f, "preparing-non-pi", { readonly: true, runnerId: "codex" }), generation = f.begin(scope);
  installPolicy(f, { maxConcurrentRuns: 4, maxReadOnlyRuns: 4, maxWorkspaceWriteRuns: 1 });
  const candidate = f.outsider("preparing-non-pi-candidate");
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
  assertNotAdmitted(f, candidate);
  assert.equal(f.admission(scope, generation)!.status, "preparing");
});

test("a new non-pi preparing candidate with valid readonly metadata cannot bypass a full write class", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 4, maxReadOnlyRuns: 4, maxWorkspaceWriteRuns: 1 });
  const holder = f.outsider("preparing-non-pi-write-holder");
  acquire(f, holder);
  const scope = scopeFor(f, "preparing-non-pi-new", { readonly: true, runnerId: "codex" }), input = f.input(scope);
  const tasksBefore = f.count("tasks"), result = noWrites(f, () => f.peer.beginChannelWorkflowStepStart(input));
  assert.equal(result.status, "conflict");
  assert.equal(result.code, "workflow_admission_resource_conflict");
  assert.equal(result.resourceKey, `runtime:workspace:${f.channel.workspaceId}:workspace_write`);
  assert.equal(f.count("tasks"), tasksBefore);
  assert.equal(f.current(scope).taskId, undefined);
  assert.equal(f.current(scope).metadata!.startOwner, undefined);
  assert.equal(f.count("workflow_step_admissions"), 0);
  assert.equal(f.count("workflow_step_admission_entries"), 0);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(holder.fence, f.at(8), "controlled fixture stop"), 3);
  assert.equal(f.peer.beginChannelWorkflowStepStart(input).status, "begun");
});

for (const full of ["workspace", "provider", "runner"]) {
  test(`a late ${full} capacity failure rolls back earlier batch slots and acquired events`, async t => {
    const f = await capacityFixture(t);
    installPolicy(f, full === "workspace" ? { maxConcurrentRuns: 1 }
      : full === "provider" ? { maxRunsPerProvider: 1 } : { maxRunsPerRunner: 1 });
    const holder = f.outsider(`late-holder-${full}`), candidate = f.outsider(`late-candidate-${full}`);
    const inputs = batch(f, candidate), blocked = full === "runner" ? inputs[1] : inputs[0];
    assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.slotInput(holder, blocked)));
    const ordered = [f.slotInput(candidate, { resourceType: "media_provider", resourceKey: "b22-unrelated-media", limit: 4 }),
      inputs[2], inputs.find(input => input.resourceType !== blocked.resourceType && input.resourceType !== "channel_parallel")!, blocked];
    const result = noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(ordered));
    assert.equal(result.status, "full");
    if (full !== "workspace") {
      assert.equal(result.resourceType, full);
      assert.equal(result.resourceKey, blocked.resourceKey);
    }
    assertNotAdmitted(f, candidate);
    assert.equal(activeSlots(f).length, 1);
    assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(holder.fence, f.at(8), "controlled fixture stop"), 1);
    const admitted = f.peer.acquireRuntimeSemaphoreSlots(ordered);
    assert.equal(admitted.status, "acquired");
    assert.equal(admitted.slots.length, 4);
    assert.equal(exactSlots(f, candidate).length, 4);
  });
}

test("policy changes are immediately shared by an already-open peer and both reopened Stores", async t => {
  const f = await capacityFixture(t), first = installPolicy(f, { maxConcurrentRuns: 1 });
  const left = f.outsider("policy-left"), right = f.outsider("policy-right"), third = f.outsider("policy-third");
  acquire(f, left);
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, right))).status, "full");
  const raised = installPolicy(f, { maxConcurrentRuns: 2 }, f.peer);
  assert.equal(raised.revision, first.revision + 1);
  assert.deepEqual(policies(f.store).getRuntimeConcurrencyPolicy(f.channel.workspaceId), raised);
  acquire(f, right);
  const before = f.snapshot(), lowered = installPolicy(f, { maxConcurrentRuns: 1 }, f.peer);
  assert.deepEqual(f.snapshot(), before, "lowering a policy must not release or rewrite existing execution ownership");
  f.reopen(); f.reopen("peer");
  for (const store of [f.store, f.peer]) {
    assert.deepEqual(policies(store).getRuntimeConcurrencyPolicy(f.channel.workspaceId), lowered);
    assert.equal(noWrites(f, () => store.acquireRuntimeSemaphoreSlots(batch(f, third))).status, "full");
  }
  assert.equal(activeSlots(f).length, 6);
  assertNotAdmitted(f, third);
});

test("a legacy active owner counts toward total capacity when the first policy is installed", async t => {
  const f = await capacityFixture(t), legacy = f.outsider("legacy-active"), candidate = ordinary(f, "legacy-total-read", { readonly: true });
  acquire(f, legacy);
  const before = f.snapshot();
  installPolicy(f, { maxConcurrentRuns: 1 });
  assert.deepEqual(f.snapshot(), before);
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
  assertNotAdmitted(f, candidate);
  assert.equal(f.peer.releaseRuntimeSemaphoreSlotsForAttempt(legacy.fence, f.at(8), "controlled fixture stop"), 3);
  acquire(f, candidate);
});

for (const status of ["created", "started", "waiting_for_approval", "cancelling"] as const) {
  test(`TTL cannot free a live ${status} owner's workspace place for a different resource identity`, async t => {
    const f = await capacityFixture(t);
    installPolicy(f, { maxConcurrentRuns: 1 });
    const holder = f.outsider(`ttl-${status}`), candidate = ordinary(f, `ttl-candidate-${status}`, { runnerId: "codex" });
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...holder.fence, status, now: f.at(3) }));
    acquire(f, holder, f.store, { expiresAt: f.at(5) });
    const before = activeSlots(f);
    assert.equal(noWrites(f, () => f.peer.expireRuntimeSemaphoreSlots(f.at(10_000))), 0);
    const inputs = batch(f, candidate, { acquiredAt: f.at(10_000), expiresAt: f.at(20_000) });
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(inputs)).status, "full");
    assert.deepEqual(noWrites(f, () => semaphores(f.store).ensureRuntimeSemaphoreSlotForAttempt(inputs[0])), { status: "full" });
    assert.deepEqual(activeSlots(f), before);
    assert.equal(f.peer.getWorkUnitAttempt(holder.attempt.id)!.status, status);
    assertNotAdmitted(f, candidate);
  });
}

test("duplicate and wrong exact fences never release a holder or its successor's workspace place", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 1 });
  const prior = f.outsider("release-prior"), rival = f.outsider("release-rival");
  acquire(f, prior);
  assert.deepEqual(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, prior))), { status: "changed" });
  for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    const fence = { ...prior.fence, [field]: `stale-${field}` };
    assert.equal(noWrites(f, () => f.peer.releaseRuntimeSemaphoreSlotsForAttempt(fence, f.at(6), "stale callback")), 0);
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, rival))).status, "full");
  }
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: prior.unit.id, attemptNumber: 2,
    runtimeInstanceId: "b22-release-successor", runnerId: "pi", now: f.at(7) });
  const successor = { unit: prior.unit, attempt, fence: toRuntimeAttemptFence(attempt) };
  assert.equal(exactSlots(f, prior).length, 0);
  acquire(f, successor, f.peer);
  assert.equal(noWrites(f, () => f.store.releaseRuntimeSemaphoreSlotsForAttempt(prior.fence, f.at(8), "old callback")), 0);
  assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(batch(f, rival))).status, "full");
  assert.equal(f.peer.releaseRuntimeSemaphoreSlotsForAttempt(successor.fence, f.at(9), "controlled fixture stop"), 3);
  assert.equal(noWrites(f, () => f.store.releaseRuntimeSemaphoreSlotsForAttempt(successor.fence, f.at(10), "duplicate stop")), 0);
  acquire(f, rival);
  assert.equal(noWrites(f, () => f.peer.releaseRuntimeSemaphoreSlotsForAttempt(successor.fence, f.at(11), "late duplicate stop")), 0);
  assert.equal(exactSlots(f, rival).length, 3);
});

test("lowering capacity retains exact existing slots but reacquisition after release uses the current limit", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  const holder = f.outsider("reacquire-holder"), other = f.outsider("reacquire-other"), admitted = acquire(f, holder);
  acquire(f, other, f.peer);
  const before = f.snapshot();
  installPolicy(f, { maxConcurrentRuns: 1 });
  assert.deepEqual(f.snapshot(), before);
  const input = batch(f, holder)[0], ensured = noWrites(f, () => semaphores(f.peer).ensureRuntimeSemaphoreSlotForAttempt(input));
  assert.equal(ensured.status, "existing");
  assert.equal(ensured.slot.id, admitted.slots[0].id);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(holder.fence, f.at(8), "controlled fixture stop"), 3);
  assert.deepEqual(noWrites(f, () => semaphores(f.peer).ensureRuntimeSemaphoreSlotForAttempt(input)), { status: "full" });
  assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, holder))).status, "full");
  assert.equal(f.peer.releaseRuntimeSemaphoreSlotsForAttempt(other.fence, f.at(9), "controlled fixture stop"), 3);
  const reacquired = semaphores(f.store).ensureRuntimeSemaphoreSlotForAttempt({ ...input, acquiredAt: f.at(10), expiresAt: f.at(200) });
  assert.equal(reacquired.status, "acquired");
  assert.notEqual(reacquired.slot.id, ensured.slot.id);
});

for (const readonly of [true, false]) {
  test(`already-preparing ${readonly ? "readonly" : "write"} reservations transfer after all policy caps shrink without rewriting plans or releasing slots`, async t => {
    const f = await capacityFixture(t);
    installPolicy(f, { maxConcurrentRuns: 2, maxReadOnlyRuns: 2, maxWorkspaceWriteRuns: 2, maxRunsPerProvider: 2, maxRunsPerRunner: 2 });
    const scopes = ["reserved-left", "reserved-right"].map(name => scopeFor(f, name, { readonly, provider: "b22-reserved-provider" }));
    const generations = scopes.map(scope => f.begin(scope)), evidence = scopes.map((scope, index) => frozenEvidence(f, scope, generations[index]));
    const before = f.snapshot();
    installPolicy(f, { maxConcurrentRuns: 1, maxReadOnlyRuns: 1, maxWorkspaceWriteRuns: 1, maxRunsPerProvider: 1, maxRunsPerRunner: 1 }, f.peer);
    assert.deepEqual(f.snapshot(), before);
    f.reopen();
    const prepared = scopes.map((scope, index) => prepare(f, scope, generations[index], `reserved-${index}`));
    const transfers = scopes.map((scope, index) => {
      const result = f.transfer(scope, generations[index], prepared[index]);
      assert.equal(result.status, "transferred", JSON.stringify(result));
      assert.equal(result.slots.length, 3);
      assert.deepEqual(frozenEvidence(f, scope, generations[index]), evidence[index]);
      return result;
    });
    const candidate = f.outsider("reserved-new");
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
    f.reopen("peer");
    for (let index = 0; index < scopes.length; index++) {
      const replay = noWrites(f, () => f.transfer(scopes[index], generations[index], prepared[index], {}, f.peer));
      assert.equal(replay.status, "duplicate");
      assert.deepEqual(slotIds(replay), slotIds(transfers[index]));
    }
    assert.equal(activeSlots(f).length, 6);
    const firstRelease = f.release(scopes[0], generations[0], prepared[0]);
    assert.ok("releasedSlots" in firstRelease);
    assert.equal(firstRelease.releasedSlots, 3);
    assert.equal(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, candidate))).status, "full");
    const secondRelease = f.release(scopes[1], generations[1], prepared[1]);
    assert.ok("releasedSlots" in secondRelease);
    assert.equal(secondRelease.releasedSlots, 3);
    acquire(f, candidate, f.peer);
  });
}

for (const resourceType of ["provider", "runner"]) {
  test(`current ${resourceType} policy overrides frozen four-slot plans on raise and shrink without semantic drift`, async t => {
    const f = await capacityFixture(t), field = resourceType === "provider" ? "maxRunsPerProvider" : "maxRunsPerRunner";
    installPolicy(f, { [field]: 4 });
    const options = { readonly: true, provider: "b22-frozen-provider" }, scope = scopeFor(f, `frozen-${resourceType}`, options);
    const generation = f.begin(scope), evidence = frozenEvidence(f, scope, generation);
    assert.equal(scope.plan.entries.find(entry => entry.resourceType === resourceType)!.limit, 4);
    const beforeRaise = f.snapshot();
    installPolicy(f, { [field]: 6 }, f.peer);
    assert.deepEqual(f.snapshot(), beforeRaise);
    assert.deepEqual(frozenEvidence(f, scope, generation), evidence);
    const holders = [];
    for (let index = 0; index < 4; index++) {
      const current = ordinary(f, `raised-${resourceType}-${index}`, options), input = batch(f, current).find(entry => entry.resourceType === resourceType)!;
      assert.ok(f.peer.acquireRuntimeSemaphoreSlot(input), "current policy, not frozen preparing limit=4, admits the fourth active owner");
      holders.push(current);
    }
    const current = prepare(f, scope, generation, `frozen-${resourceType}`), transferred = f.transfer(scope, generation, current);
    assert.equal(transferred.status, "transferred");
    assert.equal(activeSlots(f).filter(slot => slot.resource_type === resourceType).length, 5);
    assert.deepEqual(frozenEvidence(f, scope, generation), evidence);
    const before = f.snapshot();
    installPolicy(f, { [field]: 2 }, f.peer);
    assert.deepEqual(f.snapshot(), before);
    f.reopen();
    const replay = noWrites(f, () => f.transfer(scope, generation, current));
    assert.equal(replay.status, "duplicate");
    assert.deepEqual(slotIds(replay), slotIds(transferred));
    const candidate = ordinary(f, `lowered-${resourceType}`, options), input = batch(f, candidate).find(entry => entry.resourceType === resourceType)!;
    assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlot(input)), undefined);
    assert.deepEqual(noWrites(f, () => semaphores(f.peer).ensureRuntimeSemaphoreSlotForAttempt(input)), { status: "full" });
    const blocked = scopeFor(f, `lowered-begin-${resourceType}`, options), beginInput = f.input(blocked);
    const conflict = noWrites(f, () => f.peer.beginChannelWorkflowStepStart(beginInput));
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.resourceType, resourceType);
    for (const holder of holders) assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(holder.fence, f.at(8), "controlled fixture stop"), 1);
    assert.ok(f.peer.acquireRuntimeSemaphoreSlot(input));
    assert.deepEqual(frozenEvidence(f, scope, generation), evidence);
    const third = ordinary(f, `lowered-third-${resourceType}`, options);
    assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlot(batch(f, third).find(entry => entry.resourceType === resourceType)!)), undefined);
  });
}

test("raising Provider/Runner policy does not widen a frozen channel limit", async t => {
  const f = await capacityFixture(t);
  installPolicy(f);
  const left = scopeFor(f, "channel-left", { channelLimit: 1 }), generation = f.begin(left);
  const right = scopeFor(f, "channel-right", { channelLimit: 1 }), input = f.input(right);
  const result = noWrites(f, () => f.peer.beginChannelWorkflowStepStart(input));
  assert.equal(result.status, "conflict");
  assert.equal(result.resourceType, "channel_parallel");
  assert.equal(result.resourceKey, f.channel.id);
  assert.equal(f.admission(left, generation)!.status, "preparing");
});

for (const method of ["acquireRuntimeSemaphoreSlot", "acquireRuntimeSemaphoreSlots"] as const) {
  test(`independent Workers racing the last workspace place through ${method} admit exactly one distinct resource group`, async t => {
    const f = await capacityFixture(t);
    installPolicy(f, { maxConcurrentRuns: 2 });
    acquire(f, ordinary(f, "race-holder", { runnerId: "pi" }));
    const candidates = [ordinary(f, "race-left", { runnerId: "codex" }), ordinary(f, "race-right", { runnerId: "claude" })];
    const results = await admissionRace(t, f, candidates.map((current, index) => {
      const inputs = batch(f, current);
      return { method, input: method === "acquireRuntimeSemaphoreSlot" ? inputs[0] : index ? [...inputs].reverse() : inputs };
    }));
    const won = results.map(result => method === "acquireRuntimeSemaphoreSlot" ? result !== undefined : result !== undefined && result.status === "acquired");
    assert.equal(won.filter(Boolean).length, 1);
    results.forEach((result, index) => {
      if (won[index]) assert.equal(exactSlots(f, candidates[index]).length, method === "acquireRuntimeSemaphoreSlot" ? 1 : 3);
      else {
        if (method === "acquireRuntimeSemaphoreSlots") {
          assert.ok(result);
          assert.equal(result.status, "full");
        }
        assertNotAdmitted(f, candidates[index]);
      }
    });
    assert.equal(activeSlots(f).length, method === "acquireRuntimeSemaphoreSlot" ? 4 : 6);
  });
}

test("independent begin Workers reserve only one final workspace place despite disjoint Provider/Runner plans", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  acquire(f, f.outsider("begin-race-holder"));
  const scopes = [scopeFor(f, "begin-race-left", { runnerId: "codex" }), scopeFor(f, "begin-race-right", { runnerId: "claude" })];
  const tasksBefore = f.count("tasks"), results = await admissionRace(t, f,
    scopes.map(scope => ({ method: "beginChannelWorkflowStepStart", input: f.input(scope) })));
  assert.deepEqual(results.map(result => result.status).sort(), ["begun", "conflict"]);
  assert.equal(f.count("tasks"), tasksBefore + 1);
  assert.equal(f.count("workflow_step_admissions"), 1);
  assert.equal(f.count("workflow_step_admission_entries"), 3);
  const losing = scopes[results.findIndex(result => result.status === "conflict")];
  assert.equal(f.current(losing).taskId, undefined);
  assert.equal(f.current(losing).metadata?.startOwner, undefined);
  assert.equal(activeSlots(f).length, 3);
});

test("ordinary batch and preparing begin Workers compete for the same final workspace place", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 2 });
  acquire(f, f.outsider("mixed-race-holder"));
  const scope = scopeFor(f, "mixed-race-workflow", { runnerId: "codex" }), candidate = ordinary(f, "mixed-race-run", { runnerId: "claude" });
  const beforeTasks = f.count("tasks"), results = await admissionRace(t, f, [
    { method: "beginChannelWorkflowStepStart", input: f.input(scope) },
    { method: "acquireRuntimeSemaphoreSlots", input: batch(f, candidate) },
  ]);
  const beginWon = results[0].status === "begun", ordinaryWon = results[1].status === "acquired";
  assert.notEqual(beginWon, ordinaryWon);
  assert.equal(results[0].status, beginWon ? "begun" : "conflict");
  assert.equal(results[1].status, ordinaryWon ? "acquired" : "full");
  assert.equal(f.count("tasks"), beforeTasks + Number(beginWon));
  assert.equal(f.count("workflow_step_admissions"), Number(beginWon));
  assert.equal(f.count("workflow_step_admission_entries"), 3 * Number(beginWon));
  assert.equal(exactSlots(f, candidate).length, 3 * Number(ordinaryWon));
  if (!ordinaryWon) assertNotAdmitted(f, candidate);
});

test("transfer racing a different Provider/Runner batch has no capacity gap and never double-counts the reserved Attempt", async t => {
  const f = await capacityFixture(t);
  installPolicy(f, { maxConcurrentRuns: 1 });
  const scope = scopeFor(f, "transfer-race"), generation = f.begin(scope), current = prepare(f, scope, generation, "transfer-race");
  const candidate = ordinary(f, "transfer-race-outsider", { runnerId: "codex" });
  const results = await admissionRace(t, f, [
    { method: "transferChannelWorkflowStepStartAdmission", input: f.transferInput(scope, generation, current) },
    { method: "acquireRuntimeSemaphoreSlots", input: batch(f, candidate) },
  ]);
  assert.equal(results[0].status, "transferred");
  assert.equal(results[1].status, "full");
  assertNotAdmitted(f, candidate);
  assert.equal(f.admission(scope, generation)!.status, "transferred");
  assert.equal(activeSlots(f).length, 3);
  f.reopen();
  const replay = noWrites(f, () => f.transfer(scope, generation, current));
  assert.equal(replay.status, "duplicate");
  assert.deepEqual(slotIds(replay), slotIds(results[0]));
  installPolicy(f, { maxConcurrentRuns: 2 });
  acquire(f, candidate, f.peer);
  const third = f.outsider("transfer-race-third");
  assert.equal(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(batch(f, third))).status, "full");
});

test("same-Run continuation reacquisition obeys the current total cap and retries without rewriting its frozen plan", async t => {
  const f = await workflowResumeAdmissionFixture(t), evidence = frozenEvidence(f, f.scopeResume, f.generation);
  installPolicy(f, { maxConcurrentRuns: 2 });
  const holder = ordinary(f, "resume-holder", { runnerId: "codex" });
  acquire(f, holder);
  const before = f.snapshot();
  installPolicy(f, { maxConcurrentRuns: 1 }, f.peer);
  assert.deepEqual(f.snapshot(), before);
  const prior = f.admission(f.scopeResume, f.generation), result = noWrites(f, () => f.resume());
  assert.equal(result.status, "conflict");
  assert.equal(result.code, "workflow_admission_resource_conflict");
  assert.deepEqual(f.admission(f.scopeResume, f.generation), prior);
  const target = { attempt: f.target.attempt, fence: toRuntimeAttemptFence(f.target.attempt) };
  assertNotAdmitted(f, target);
  assert.equal(f.peer.releaseRuntimeSemaphoreSlotsForAttempt(holder.fence, f.at(9), "controlled fixture stop"), 3);
  f.reopen();
  const resumed = f.resume();
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.slots.length, 6);
  assert.deepEqual(frozenEvidence(f, f.scopeResume, f.generation), evidence);
  const replay = noWrites(f, () => f.resume());
  assert.equal(replay.status, "duplicate");
  assert.deepEqual(slotIds(replay), slotIds(resumed));
  assert.equal(noWrites(f, () => f.peer.releaseRuntimeSemaphoreSlotsForAttempt(f.source.fence, f.at(11), "old source callback")), 0);
});

test("independent resume and ordinary Workers can reacquire only one final workspace place", async t => {
  const f = await workflowResumeAdmissionFixture(t);
  installPolicy(f, { maxConcurrentRuns: 1 });
  const candidate = ordinary(f, "resume-race-outsider", { runnerId: "codex" }), prior = f.admission(f.scopeResume, f.generation);
  const results = await admissionRace(t, f, [
    { method: "resumeChannelWorkflowStepStartAdmission", input: f.resumeInput() },
    { method: "acquireRuntimeSemaphoreSlots", input: batch(f, candidate) },
  ]);
  const resumed = results[0].status === "resumed", ordinaryWon = results[1].status === "acquired";
  assert.notEqual(resumed, ordinaryWon);
  assert.equal(results[0].status, resumed ? "resumed" : "conflict");
  assert.equal(results[1].status, ordinaryWon ? "acquired" : "full");
  const target = { attempt: f.target.attempt, fence: toRuntimeAttemptFence(f.target.attempt) };
  assert.equal(exactSlots(f, target).length, resumed ? 6 : 0);
  assert.equal(exactSlots(f, candidate).length, ordinaryWon ? 3 : 0);
  assert.equal(activeSlots(f).length, resumed ? 6 : 3);
  if (resumed) assertNotAdmitted(f, candidate);
  else {
    assertNotAdmitted(f, target);
    assert.deepEqual(f.admission(f.scopeResume, f.generation), prior);
  }
});
