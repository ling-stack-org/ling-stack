import assert from "node:assert/strict";
import test from "node:test";
import { b013Gate } from "../../core/test/support/b013-pre-gate-fixture.mjs";
import { schedulerFixture, schedulerModule, beginSchedulerStep, linkSchedulerRun } from "./support/workflow-scheduler-fixture.mjs";

const { orchestrateChannelWorkflow } = await schedulerModule("orchestrator");

function orchestration(f, overrides = {}) {
  const dispatched = [];
  const input = { store: f.store, cwd: f.cwd, workflowId: f.workflow.id, runnerRegistry: f.runnerRegistry, validateRunRequest() {},
    resolveParallelCapability: f.capability,
    async startRun({ workflowStep, taskId, runRequest }) {
      dispatched.push(workflowStep.id);
      return linkSchedulerRun(f, workflowStep, { task: { id: taskId }, owner: runRequest.workflowStartOwner }, runRequest).id;
    }, ...overrides };
  return { dispatched, input, tick: () => orchestrateChannelWorkflow(input) };
}

function pendingIndependentPreGate(f, gate) {
  const step = f.store.getChannelWorkflowStep(gate.id);
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
  assert.equal(step.status, "waiting_for_approval");
  assert.equal(step.metadata.activeGateStage, "pre");
  assert.equal(step.taskId, undefined);
  assert.equal(step.runId, undefined);
  assert.equal(step.metadata.startOwner, undefined);
  const approval = f.store.getApprovalRequest(step.metadata.preStepApprovalId);
  assert.equal(approval.status, "pending");
  assert.equal(approval.workflowStepId, gate.id);
  assert.equal(approval.payload.gateStage, "pre");
  assert.equal(f.store.listStateTransitionEvents({ entityType: "workflow", entityId: f.workflow.id })
    .filter(event => event.event === "approval_approved").length, 0);
  return approval;
}

test("orchestrator starts selected runnable ids, not the first N eligible steps", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("A"), conflict = f.step("Conflict"), c = f.step("C");
  const o = orchestration(f, { resolveParallelCapability: context => ({ ...f.capability(context),
    resourceKeys: context.step.id === c.id ? [] : ["host:exclusive-index"] }) });
  const result = await o.tick();
  assert.equal(result.status, "started", JSON.stringify(result));
  assert.deepEqual(o.dispatched, [a.id, c.id]);
  assert.deepEqual(result.startedSteps.map(item => item.workflowStep.id), [a.id, c.id]);
  assert.equal(f.store.getChannelWorkflowStep(conflict.id).status, "queued");
});

test("orchestrator leaves legacy read-only-looking steps serial without Host wiring", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("Legacy A", { sideEffectClass: undefined, parallelPolicy: undefined, maxParallelSiblings: 3 });
  f.step("Legacy B", { sideEffectClass: undefined, parallelPolicy: undefined, maxParallelSiblings: 3 });
  const o = orchestration(f, { resolveParallelCapability: undefined });
  const result = await o.tick();
  assert.equal(result.status, "started", JSON.stringify(result));
  assert.deepEqual(o.dispatched, [a.id]);
  assert.equal((await o.tick()).status, "idle");
  assert.deepEqual(o.dispatched, [a.id]);
});

test("a local pre-approval wait does not consume a safe independent branch's slot", async t => {
  const f = await schedulerFixture(t, { cap: 2 });
  const gate = f.step("Gated", { gates: [b013Gate()] });
  const safe = f.step("Independent");
  const dependent = f.step("Dependent", { dependsOnStepIds: [gate.id] });
  let approvalBeforeStart;
  const o = orchestration(f, { validateRunRequest() {
    approvalBeforeStart = pendingIndependentPreGate(f, gate);
  } });
  const result = await o.tick();
  assert.equal(result.status, "started", JSON.stringify(result));
  assert.deepEqual(o.dispatched, [safe.id]);
  assert.ok(approvalBeforeStart);
  assert.deepEqual(pendingIndependentPreGate(f, gate), approvalBeforeStart);
  assert.equal(result.workflow.status, "waiting_for_approval");
  assert.equal(f.store.getChannelWorkflowStep(safe.id).metadata.startOwner.phase, "linked");
  assert.equal(f.store.getChannelWorkflowStep(dependent.id).status, "queued");
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 1);
});

test("reconciling an existing independent pre-gate does not freeze a later safe branch", async t => {
  const f = await schedulerFixture(t);
  const gate = f.step("Gated", { gates: [b013Gate()] });
  const o = orchestration(f);
  assert.equal((await o.tick()).status, "waiting_for_approval");
  const approvalBeforeStart = pendingIndependentPreGate(f, gate);
  const safe = f.step("Independent");
  const result = await o.tick();
  assert.equal(result.status, "started", JSON.stringify(result));
  assert.deepEqual(o.dispatched, [safe.id]);
  assert.deepEqual(pendingIndependentPreGate(f, gate), approvalBeforeStart);
  assert.equal(result.workflow.status, "waiting_for_approval");
  assert.equal(f.store.getChannelWorkflowStep(safe.id).metadata.startOwner.phase, "linked");
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 1);
});

test("without Host evidence a pre-gate preserves legacy serial waiting behavior", async t => {
  const f = await schedulerFixture(t);
  f.step("Gated", { gates: [b013Gate()] }); f.step("Independent");
  const o = orchestration(f, { resolveParallelCapability: undefined });
  assert.equal((await o.tick()).status, "waiting_for_approval");
  assert.deepEqual(o.dispatched, []);
  assert.equal((await o.tick()).status, "waiting_for_approval");
  assert.deepEqual(o.dispatched, []);
});

test("Host revocation after the first dispatch prevents starting the next selected branch", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("A"); f.step("B");
  let enabled = true;
  const o = orchestration(f, { resolveParallelCapability: context => enabled ? f.capability(context) : undefined });
  const start = o.input.startRun;
  o.input.startRun = async context => { const id = await start(context); enabled = false; return id; };
  assert.equal((await o.tick()).status, "started");
  assert.deepEqual(o.dispatched, [a.id]);
});

test("preparing siblings are reread after preparation before actual dispatch", async t => {
  const f = await schedulerFixture(t);
  const candidate = f.step("Candidate");
  const writer = f.step("Writer", { sideEffectClass: "workspace_write", requiredTools: ["write"], autoStart: false });
  let injected = false;
  const o = orchestration(f, { validateRunRequest() {
    if (!injected) { injected = true; beginSchedulerStep(f, writer); }
  } });
  const result = await o.tick();
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.deepEqual(o.dispatched, []);
  assert.equal(f.store.getChannelWorkflowStep(writer.id).metadata.startOwner.phase, "preparing");
  assert.equal(f.store.getChannelWorkflowStep(candidate.id).status, "blocked");
});

test("Host receives the exact prepared request for pre-dispatch revalidation", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("A");
  let prepared;
  const o = orchestration(f, { resolveParallelCapability: context => {
    prepared ??= context.runRequest;
    return f.capability(context);
  } });
  assert.equal((await o.tick()).status, "started");
  assert.equal(prepared.workflowStepId, a.id);
  assert.equal(prepared.workflowStartOwner.phase, "preparing");
  assert.equal(prepared.task.id, f.store.getChannelWorkflowStep(a.id).taskId);
});

for (const [label, gates] of [
  ["legacy", { approvalGate: { mode: "standard", risk: "medium" } }],
  ["declarative", { gates: [b013Gate()] }],
]) {
  test(`an approved ${label} pre-gate dispatches the exact admitted serial owner once`, async t => {
    const f = await schedulerFixture(t);
    const step = f.step("Approved writer", { sideEffectClass: "workspace_write",
      parallelPolicy: { autoParallel: false, maxParallelSiblings: 1 }, requiredTools: ["write"], ...gates });
    const o = orchestration(f);
    const waiting = await o.tick();
    assert.equal(waiting.status, "waiting_for_approval", JSON.stringify(waiting));
    assert.deepEqual(o.dispatched, []);
    f.store.approveApprovalRequest(waiting.approval.id, { resolvedBy: "local-user", reason: "Approve this exact definition" },
      new Date().toISOString());
    const result = await o.tick();
    assert.equal(result.status, "started", JSON.stringify(result));
    assert.deepEqual(o.dispatched, [step.id]);
    const current = f.store.getChannelWorkflowStep(step.id);
    assert.equal(current.metadata.preStepApprovalMarker.consumedByTaskId, result.taskId);
    assert.equal(current.metadata.startOwner.taskId, result.taskId);
    assert.equal((await o.tick()).status, "idle");
    assert.deepEqual(o.dispatched, [step.id]);
  });
}

test("pre-dispatch revalidation rejects a pre-gate consumed by a different Task", async t => {
  const f = await schedulerFixture(t);
  const step = f.step("Approved candidate", { gates: [b013Gate()] });
  const o = orchestration(f);
  const waiting = await o.tick();
  assert.equal(waiting.status, "waiting_for_approval");
  f.store.approveApprovalRequest(waiting.approval.id, { resolvedBy: "local-user", reason: "Approve this owner only" },
    new Date().toISOString());
  const begin = f.store.beginChannelWorkflowStepStart.bind(f.store);
  f.store.beginChannelWorkflowStepStart = input => {
    const result = begin(input);
    if (result.status === "begun") {
      const current = f.store.getChannelWorkflowStep(step.id);
      f.store.updateChannelWorkflowStep(step.id, { metadata: { ...current.metadata,
        preStepApprovalMarker: { ...current.metadata.preStepApprovalMarker, consumedByTaskId: "another-task" } } },
      new Date().toISOString());
    }
    return result;
  };
  const result = await o.tick();
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.deepEqual(o.dispatched, []);
});
