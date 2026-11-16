import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowPreGateExecutionPermit, parseWorkflowStepExecutionSafety, workflowStepSafetyPlanDigest } from "../dist/index.js";
import { b013Gate } from "./support/b013-pre-gate-fixture.mjs";
import { admissionParticipant, admissionRace, workflowAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";

const assertNoWrites = (f, action) => { const before = f.snapshot(); const result = action(); assert.deepEqual(f.snapshot(), before); return result; };
const expected = step => ({ status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt });

function readonlySibling(f, workflow, title = "Independent") {
  const metadata = { sideEffectClass: "analysis_readonly", requiredTools: ["read"],
    parallelPolicy: { autoParallel: true, maxParallelSiblings: 3, resourceKeys: ["repository:p1c-canonical"] } };
  let step = f.store.createChannelWorkflowStep({ workflowId: workflow.id, title, prompt: "Read owned evidence",
    toParticipantId: admissionParticipant, toParticipantLabel: "Engineer", metadata }, f.at(0));
  const plan = { schemaVersion: 1, profile: "pi_host_readonly_v1", workflowId: workflow.id, workflowStepId: step.id,
    workspaceRoot: f.cwd, executionRoot: f.cwd, safety: parseWorkflowStepExecutionSafety(metadata), tools: ["read"],
    runnerId: "pi", networkAccess: false, writeRoots: [] };
  step = f.store.updateChannelWorkflowStep(step.id, { metadata: { ...metadata,
    safetyPlan: { ...plan, digest: workflowStepSafetyPlanDigest(plan) } } }, f.at(0));
  return { workflow, step, plan: f.plan({ entries: [
    { resourceType: "provider", resourceKey: "p1c-provider", limit: 4 },
    { resourceType: "runner", resourceKey: "pi", limit: 4 },
    { resourceType: "channel_parallel", resourceKey: f.channel.id, limit: 3 },
    { resourceType: "channel_parallel", resourceKey: `workflow:${workflow.id}`, limit: 3 },
    { resourceType: "channel_parallel", resourceKey: `workspace:${f.cwd}`, limit: 3 },
  ] }) };
}

async function approvalFixture(t) {
  const f = await workflowAdmissionFixture(t);
  f.channel = f.store.updateChannel(f.channel.id, { runtimePolicy: { ...f.channel.runtimePolicy, allowReadOnlyParallel: true } }, f.at(0));
  f.gated = f.scope("waiting", { metadata: { gates: [b013Gate()] } });
  f.safe = readonlySibling(f, f.gated.workflow);
  const step = f.current(f.gated);
  f.permit = createWorkflowPreGateExecutionPermit({ mode: "create_and_run_task", taskTitle: step.title, taskPrompt: step.prompt,
    assigneeTeammateId: step.toParticipantId, skipProviderPreflight: false });
  const requested = f.store.requestChannelWorkflowStepPreApproval({ workflowStepId: step.id,
    expected: expected(step), executionPermit: f.permit, now: f.at(1) });
  assert.equal(requested.status, "requested", JSON.stringify(requested));
  f.approval = requested.approval;
  return f;
}

function extraApproval(f, { gateStage = "post", scoped = true } = {}) {
  return f.store.createApprovalRequest({ ...(scoped ? { workflowStepId: f.gated.step.id } : {}), channelId: f.channel.id,
    actionType: "workflow_step", risk: "high", title: "Workflow decision", description: "Must not be bypassed",
    payload: { type: "workflow_step", ...(gateStage ? { gateStage } : {}), workflowId: f.gated.workflow.id,
      workflowStepId: f.gated.step.id, title: "Workflow decision", approvalMode: "strict", requiredForTools: [], requiredForActions: [] } }, f.at(1));
}

test("direct Core begin preserves aggregate pre-wait and its pending approval while atomically reserving a safe independent branch", async t => {
  const f = await approvalFixture(t), gateBefore = f.current(f.gated), approvalBefore = f.store.getApprovalRequest(f.approval.id);
  const result = f.begin(f.safe);
  assert.deepEqual(f.current(f.gated), gateBefore);
  assert.deepEqual(f.store.getApprovalRequest(f.approval.id), approvalBefore);
  assert.equal(approvalBefore.status, "pending");
  assert.equal(f.store.getChannelWorkflow(f.gated.workflow.id).status, "waiting_for_approval");
  assert.equal(f.admission(f.safe, result).status, "preparing");
  assert.equal(f.count("workflow_step_admission_entries"), 6);
  assert.equal(f.count("tasks"), 1);
  assert.equal(f.count("run_sessions"), 0);
  assert.equal(f.store.listStateTransitionEvents({ entityType: "workflow", entityId: f.gated.workflow.id })
    .filter(event => event.event === "approval_approved").length, 0);
});

for (const change of ["missing-profile", "digest", "foreign-scope", "safety-drift", "write-tools", "serial-profile", "no-opt-in",
  "missing-admission", "missing-workflow", "missing-workspace", "missing-exclusive", "wrong-runner", "widened-limit"]) {
  test(`direct begin cannot use independent pre-wait to admit an unverified or incomplete plan: ${change}`, async t => {
    const f = await approvalFixture(t), metadata = structuredClone(f.current(f.safe).metadata), plan = structuredClone(f.safe.plan);
    if (change === "missing-profile") delete metadata.safetyPlan;
    if (change === "digest") metadata.safetyPlan.digest = "stale";
    if (change === "foreign-scope") { metadata.safetyPlan.workflowId = "foreign"; metadata.safetyPlan.digest = workflowStepSafetyPlanDigest(metadata.safetyPlan); }
    if (change === "safety-drift") metadata.parallelPolicy.maxParallelSiblings = 2;
    if (change === "write-tools") metadata.requiredTools = ["bash"];
    if (change === "serial-profile") { metadata.safetyPlan.profile = "serial_v1"; metadata.safetyPlan.digest = workflowStepSafetyPlanDigest(metadata.safetyPlan); }
    if (change === "no-opt-in") {
      metadata.parallelPolicy.autoParallel = false; metadata.safetyPlan.safety = parseWorkflowStepExecutionSafety(metadata);
      metadata.safetyPlan.digest = workflowStepSafetyPlanDigest(metadata.safetyPlan);
    }
    if (change === "missing-workflow") plan.entries = plan.entries.filter(entry => entry.resourceKey !== `workflow:${f.gated.workflow.id}`);
    if (change === "missing-workspace") plan.entries = plan.entries.filter(entry => entry.resourceKey !== `workspace:${f.cwd}`);
    if (change === "missing-exclusive") plan.resourceKeys = [];
    if (change === "wrong-runner") plan.entries.find(entry => entry.resourceType === "runner").resourceKey = "unknown";
    if (change === "widened-limit") plan.entries.find(entry => entry.resourceKey === `workflow:${f.gated.workflow.id}`).limit = 4;
    const damagedInput = change === "digest"
      ? f.input(f.safe, f.lease(f.safe), { admission: plan }) : undefined;
    // Simulate damaged persisted data below the public metadata validator.
    if (change === "digest") f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?")
      .run(JSON.stringify(metadata), f.safe.step.id);
    else f.store.updateChannelWorkflowStep(f.safe.step.id, { metadata }, f.at(1));
    const input = damagedInput ?? f.input(f.safe, f.lease(f.safe), { admission: change === "missing-admission" ? undefined : plan });
    if (change === "digest") {
      const before = f.snapshot();
      assert.throws(() => f.store.beginChannelWorkflowStepStart(input), { code: "workflow_safety_invalid" });
      assert.deepEqual(f.snapshot(), before, "a corrupt safety plan must fail before any admission writes");
    } else assert.equal(assertNoWrites(f, () => f.store.beginChannelWorkflowStepStart(input)).status, "invalid");
    assert.equal(f.count("tasks"), 0);
    assert.equal(f.store.getApprovalRequest(f.approval.id).status, "pending");
  });
}

for (const change of ["unknown-wait", "post-wait", "stale-basis", "expired-pre", "fake-pre-id", "pre-with-owner"]) {
  test(`direct begin fails closed when aggregate waiting is not proved by an independent current pre-gate: ${change}`, async t => {
    const f = await approvalFixture(t), step = f.current(f.gated), metadata = structuredClone(step.metadata);
    if (change === "unknown-wait") delete metadata.activeGateStage;
    if (change === "post-wait") metadata.activeGateStage = "post";
    if (change === "stale-basis") metadata.preStepApprovalMarker.basis.authorityBasis = `wso1_${"0".repeat(64)}`;
    if (change === "fake-pre-id") metadata.preStepApprovalId = "missing";
    if (change === "pre-with-owner") metadata.startOwner = { schemaVersion: 1, phase: "preparing", taskId: "unknown", leaseId: "unknown", authorityBasis: "unknown" };
    if (change === "expired-pre") f.store.database.prepare("UPDATE approval_requests SET expires_at=? WHERE id=?").run(f.at(2), f.approval.id);
    else f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?").run(JSON.stringify(metadata), step.id);
    const input = f.input(f.safe);
    assert.equal(assertNoWrites(f, () => f.store.beginChannelWorkflowStepStart(input)).code, "workflow_approval_wait_not_independent");
  });
}

for (const change of ["post", "legacy-global", "payload-only-global", "non-gate-step-decision", "running-with-pending-post"]) {
  test(`direct begin does not hide a separate durable ${change} decision behind legitimate pre-waits`, async t => {
    const f = await approvalFixture(t);
    if (change === "non-gate-step-decision") f.store.createApprovalRequest({ workflowStepId: f.gated.step.id,
      channelId: f.channel.id, actionType: "external_send", risk: "high",
      title: "Channel decision", description: "Global pending", payload: { type: "external_send", destination: "fixture", preview: "pending" } }, f.at(1));
    else {
      const approval = extraApproval(f, { gateStage: change === "legacy-global" ? undefined : "post" });
      if (change === "legacy-global") {
        const payload = { ...approval.payload }; delete payload.gateStage;
        f.store.database.prepare("UPDATE approval_requests SET payload_json=? WHERE id=?").run(JSON.stringify(payload), approval.id);
      }
      if (change === "payload-only-global") {
        const other = f.scope("foreign-approval-owner");
        f.store.database.prepare("UPDATE approval_requests SET channel_id=NULL,workflow_step_id=? WHERE id=?").run(other.step.id, approval.id);
      }
    }
    if (change === "running-with-pending-post") f.store.database.prepare("UPDATE channel_workflows SET status='running' WHERE id=?").run(f.gated.workflow.id);
    const input = f.input(f.safe);
    assert.equal(assertNoWrites(f, () => f.store.beginChannelWorkflowStepStart(input)).code, "workflow_approval_wait_not_independent");
  });
}

test("direct begin rejects unexplained workflow waiting even with a complete verified readonly plan", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("unexplained");
  f.channel = f.store.updateChannel(f.channel.id, { runtimePolicy: { ...f.channel.runtimePolicy, allowReadOnlyParallel: true } }, f.at(0));
  const safe = readonlySibling(f, scope.workflow);
  f.store.database.prepare("UPDATE channel_workflows SET status='waiting_for_approval' WHERE id=?").run(scope.workflow.id);
  const input = f.input(safe);
  assert.equal(assertNoWrites(f, () => f.store.beginChannelWorkflowStepStart(input)).code, "workflow_approval_wait_not_independent");
});

test("any_succeeded cannot bypass direct or transitive dependencies on a pending pre-gate", async t => {
  const f = await approvalFixture(t);
  const done = readonlySibling(f, f.gated.workflow, "Done");
  f.store.database.prepare("UPDATE channel_workflow_steps SET status='succeeded' WHERE id=?").run(done.step.id);
  for (const transitive of [false, true]) {
    if (transitive) f.store.updateChannelWorkflowStep(done.step.id, { metadata: { ...done.step.metadata,
      dependsOnStepIds: [f.gated.step.id] } }, f.at(1));
    const current = f.current(f.safe);
    f.store.updateChannelWorkflowStep(current.id, { metadata: { ...current.metadata, dependencyMode: "any_succeeded",
      dependsOnStepIds: transitive ? [done.step.id] : [done.step.id, f.gated.step.id] } }, f.at(1));
    const input = f.input(f.safe);
    assert.equal(assertNoWrites(f, () => f.store.beginChannelWorkflowStepStart(input)).code, "workflow_approval_wait_not_independent");
    f.store.releaseResourceLease(input.leaseId, "workflow_step", current.id, f.at(3));
  }
});

test("createTaskOnly cannot bypass aggregate approval gating without readonly admission", async t => {
  const f = await approvalFixture(t), input = f.input(f.safe, f.lease(f.safe), { createTaskOnly: true, admission: undefined });
  assert.equal(assertNoWrites(f, () => f.store.beginChannelWorkflowStepStart(input)).code, "workflow_approval_wait_not_independent");
});

test("competing independent Core begin writers retain one pending pre-gate and one complete reservation", async t => {
  const f = await approvalFixture(t), second = readonlySibling(f, f.gated.workflow, "Second independent");
  const results = await admissionRace(t, f, [f.safe, second].map(scope => ({ method: "beginChannelWorkflowStepStart", input: f.input(scope) })));
  assert.deepEqual(results.map(result => result.status).sort(), ["begun", "conflict"]);
  assert.equal(f.count("tasks"), 1);
  assert.equal(f.count("workflow_step_admission_entries"), 6);
  assert.equal(f.store.getApprovalRequest(f.approval.id).status, "pending");
  assert.equal(f.store.getChannelWorkflow(f.gated.workflow.id).status, "waiting_for_approval");
});
