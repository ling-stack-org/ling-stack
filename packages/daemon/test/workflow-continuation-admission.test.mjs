import assert from "node:assert/strict";
import test from "node:test";
import { toRuntimeAttemptFence, workflowStepSafetyPlanDigest } from "@ling-stack/core";
import { QueueableRunConflictError } from "../dist/features/runs/concurrency.js";
import { commitWorkflowStartReady, resumeWorkflowStartAdmission } from "../dist/features/runs/workflow-step-start-admission.js";
import { workflowAdmissionFixture } from "../../core/test/support/workflow-step-admission-fixture.mjs";

// Host wiring tests. Core's admission suite covers the actual SQLite transaction.
function fixture() {
  const now = "2026-11-02T08:00:00.000Z";
  const owner = { schemaVersion: 1, taskId: "task", leaseId: "lease", phase: "linked", authorityBasis: "authority" };
  const planInput = { schemaVersion: 1, profile: "pi_host_readonly_v1", workflowId: "workflow",
    workflowStepId: "step", workspaceRoot: "/owned/workspace", executionRoot: "/owned/workspace",
    safety: { sideEffectClass: "analysis_readonly", parallelPolicy: {
      autoParallel: true, maxParallelSiblings: 2, resourceKeys: ["shared:inspection"],
    } }, tools: ["read"], runnerId: "pi", networkAccess: false, writeRoots: [] };
  const plan = { ...planInput, digest: workflowStepSafetyPlanDigest(planInput) };
  const step = { id: "step", channelId: "channel", workflowId: "workflow", metadata: {
    ...plan.safety, safetyPlan: plan, maxParallelSiblings: 2,
  } };
  const channel = { id: "channel", runtimePolicy: { maxConcurrentRuns: 3, allowReadOnlyParallel: true, queueOnConflict: true } };
  const source = { id: "source", workUnitId: "unit", runtimeInstanceId: "runtime-old", fencingToken: "fence-old" };
  const target = { id: "target", workUnitId: "unit", runtimeInstanceId: "runtime-new", fencingToken: "fence-new", effectiveRunnerId: "pi" };
  const execution = { attempt: target, continuation: { id: "continuation", revision: 4, sourceAttemptId: source.id },
    claimOwner: "host-worker", claimToken: "claim-token", claimExpiresAt: "2026-11-02T09:00:00.000Z" };
  const calls = [];
  const store = {
    getChannelWorkflowStepStartAdmission: () => ({ status: "transferred" }),
    getChannelWorkflowStep: () => step,
    getWorkUnitAttempt: id => id === source.id ? source : undefined,
    getChannel: () => channel,
    getChannelWorkflow: () => ({ id: "workflow", metadata: { maxParallelSteps: 2 } }),
    resumeChannelWorkflowStepStartAdmission: input => { calls.push(input); return { status: "resumed", slots: [] }; },
  };
  const request = { workflowStepId: step.id, workflowSafetySnapshot: { schemaVersion: 1, plan }, providerPresetId: "provider" };
  return { now, owner, plan, step, channel, source, target, execution, calls, store, request,
    resume() { return resumeWorkflowStartAdmission(store, request, "run", owner, execution, now); } };
}

test("workflow continuation passes the full frozen plan and durable claim to Core", () => {
  const f = fixture();
  f.resume();
  assert.equal(f.calls.length, 1);
  const input = f.calls[0];
  assert.deepEqual(input.sourceFence, toRuntimeAttemptFence(f.source));
  assert.equal(input.attemptId, f.target.id);
  assert.equal(input.fencingToken, f.target.fencingToken);
  assert.equal(input.continuationId, f.execution.continuation.id);
  assert.equal(input.expectedContinuationRevision, 4);
  assert.equal(input.claimOwner, f.execution.claimOwner);
  assert.equal(input.claimToken, f.execution.claimToken);
  assert.equal(input.owner, f.owner);
  assert.equal(input.runId, "run");
  assert.equal(input.expiresAt, "2026-11-02T14:00:00.000Z");
  assert.deepEqual(input.admission.entries.map(entry => [entry.resourceType, entry.resourceKey, entry.limit]), [
    ["channel_parallel", "channel", 2],
    ["channel_parallel", "workflow:workflow", 2],
    ["channel_parallel", "workspace:/owned/workspace", 2],
    ["provider", "provider", 4],
    ["runner", "pi", 4],
  ]);
  assert.deepEqual(input.admission.resourceKeys, ["shared:inspection"]);
});

test("workflow continuation accepts only resumed or exact duplicate admission", () => {
  const f = fixture();
  f.store.resumeChannelWorkflowStepStartAdmission = () => ({ status: "duplicate", slots: [] });
  assert.doesNotThrow(() => f.resume());
  for (const status of ["invalid", "stale"]) {
    f.store.resumeChannelWorkflowStepStartAdmission = () => ({ status, code: "workflow_admission_attempt_stale" });
    assert.throws(() => f.resume(), error => error.code === "workflow_admission_attempt_stale");
  }
});

test("workflow continuation queues real capacity conflicts without replacing the original plan", () => {
  const f = fixture();
  f.store.resumeChannelWorkflowStepStartAdmission = () => ({ status: "conflict",
    code: "workflow_admission_resource_conflict", resourceType: "workflow_resource", resourceKey: "shared:inspection" });
  assert.throws(() => f.resume(), error => error instanceof QueueableRunConflictError
    && error.code === "runtime_semaphore_conflict" && error.message.includes("shared:inspection"));
  f.channel.runtimePolicy.queueOnConflict = false;
  assert.throws(() => f.resume(), error => !(error instanceof QueueableRunConflictError)
    && error.code === "runtime_semaphore_conflict");
});

test("workflow continuation rejects missing source or unresolved provider before requesting capacity", () => {
  const f = fixture();
  f.store.getWorkUnitAttempt = () => undefined;
  assert.throws(() => f.resume(), error => error.code === "workflow_admission_continuation_stale");
  assert.equal(f.calls.length, 0);
  f.store.getWorkUnitAttempt = () => f.source;
  delete f.request.providerPresetId;
  assert.throws(() => f.resume(), error => error.code === "workflow_safety_mismatch");
  assert.equal(f.calls.length, 0);
});

test("workflow continuation rejects missing or changed approved safety plans", () => {
  const f = fixture();
  delete f.request.workflowSafetySnapshot;
  assert.throws(() => f.resume(), error => error.code === "workflow_admission_plan_mismatch");
  assert.equal(f.calls.length, 0);
  f.request.workflowSafetySnapshot = { schemaVersion: 1, plan: { ...f.plan, executionRoot: "/different" } };
  assert.throws(() => f.resume(), error => error.code === "workflow_safety_mismatch");
});

test("legacy continuation without a workflow admission does not invent one", () => {
  const f = fixture();
  f.store.getChannelWorkflowStepStartAdmission = () => undefined;
  f.resume();
  assert.equal(f.calls.length, 0);
});

for (const started of [false, true]) {
  test(`stale ready preserves a started Run and only rejects unstarted preparation (${started})`, async t => {
    const f = await workflowAdmissionFixture(t);
    const scope = f.scope("ready-owner");
    const generation = f.begin(scope, f.input(scope, f.lease(scope), { admission: undefined }));
    const prepared = f.prepare(scope, generation);
    assert.equal(f.ready(scope, generation, prepared).status, "linked");
    const slot = f.store.acquireRuntimeSemaphoreSlot(f.slotInput(prepared,
      { resourceType: "provider", resourceKey: "ready-owner-provider", limit: 1 }));
    assert.ok(slot);
    if (started) f.store.markRunStarted(prepared.run.id, f.at(7));
    f.store.updateChannelWorkflowStep(scope.step.id, { prompt: "Superseded preparation" }, f.at(8));

    assert.throws(() => commitWorkflowStartReady(f.store, { workflowStepId: scope.step.id },
      prepared.run.id, generation.owner), error => error.code === "workflow_start_owner_stale");

    assert.equal(f.store.getRun(prepared.run.id).status, started ? "running" : "failed");
    assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: prepared.attempt.id, status: "active" }).length, started ? 1 : 0);
    assert.equal(f.store.getWorkUnitAttempt(prepared.attempt.id).status, started ? "created" : "failed");
  });
}
