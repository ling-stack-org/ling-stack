import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { b013Gate } from "../../core/test/support/b013-pre-gate-fixture.mjs";
import { schedulerFixture, schedulerModule, beginSchedulerStep, linkSchedulerRun } from "./support/workflow-scheduler-fixture.mjs";

const { prepareWorkflowStepStart, handleChannelWorkflowStepStartRoute } = await schedulerModule("workflows");
const { freezeWorkflowSafetyPlan, createWorkflowSafetyAdmission, workflowSafetySnapshot } = await schedulerModule("../runs/workflow-safety");
const now = () => new Date().toISOString();

function completedPostStep(f) {
  const step = f.step("Completed result awaiting review", { gates: [b013Gate({ stage: "post", statuses: ["succeeded"] })] });
  const generation = beginSchedulerStep(f, step);
  const run = linkSchedulerRun(f, step, generation);
  assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "queued",
    event: "runner_started", actor: "runner", now: now() }).ok, true);
  assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "running",
    event: "runner_succeeded", actor: "runner", now: now() }).ok, true);
  return { step, request() {
    const result = f.store.commitChannelWorkflowStepPostApproval({ workflowStepId: step.id,
      owner: f.store.getChannelWorkflowStep(step.id).metadata.startOwner, runId: run.id, now: now(),
      approval: { risk: "medium", title: "Review completed evidence", description: "Approve the completed generation.",
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(), payload: { type: "workflow_step", gateStage: "post",
          workflowId: f.workflow.id, workflowStepId: step.id, runId: run.id, title: step.title,
          approvalMode: "standard", requiredForTools: [], requiredForActions: [] } } });
    assert.equal(result.status, "requested", JSON.stringify(result));
    return result.approval;
  } };
}

function approvalWait(f, kind) {
  if (kind === "pending post gate") return completedPostStep(f).request();
  if (kind === "linked Run approval") {
    const step = f.step("Run awaiting a real tool decision");
    const generation = beginSchedulerStep(f, step);
    const run = linkSchedulerRun(f, step, generation);
    assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "queued",
      event: "runner_started", actor: "runner", now: now() }).ok, true);
    const approval = f.store.createApprovalRequest({ runId: run.id, taskId: generation.task.id,
      channelId: f.channel.id, actionType: "read", risk: "medium",
      title: "Review evidence read", description: "Await an explicit runtime tool decision.",
      payload: { type: "tool_call", toolName: "read", cwd: f.cwd, input: { path: "evidence.txt" } } }, now());
    assert.equal(f.store.transitionRunStatus({ runId: run.id, expectedStatus: "running",
      event: "approval_requested", actor: "system", now: now() }).ok, true);
    assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "running",
      event: "approval_requested", actor: "system", now: now() }).ok, true);
    return approval;
  }
  // No global Approval payload exists. An unattributed aggregate wait must fail closed.
  assert.equal(kind, "unattributed workflow wait");
  assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "ready",
    event: "start", actor: "system", now: now() }).ok, true);
  assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "running",
    event: "approval_requested", actor: "system", now: now() }).ok, true);
}

function directCoreBegin(f, candidate) {
  const step = freezeWorkflowSafetyPlan({ store: f.store, step: candidate, workspaceCwd: f.cwd,
    executionCwd: f.cwd, runnerRegistry: f.runnerRegistry });
  assert.equal(step.metadata.safetyPlan.profile, "pi_host_readonly_v1");
  const admission = createWorkflowSafetyAdmission(f.store, step, {
    workflowSafetySnapshot: workflowSafetySnapshot(step.metadata.safetyPlan),
    providerPresetId: step.metadata.providerPresetId, runnerId: "pi" });
  assert.equal(admission.entries.length, 5);
  const lease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workflow_step",
    resourceKey: step.id, ownerType: "workflow_step", ownerId: step.id, acquiredAt: now(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(lease);
  return f.store.beginChannelWorkflowStepStart({ workflowStepId: step.id, expected: step,
    leaseId: lease.id, admission, now: now(), task: { channelId: f.channel.id,
      title: step.title, prompt: step.prompt, assigneeTeammateId: step.toParticipantId } });
}

const entryPoints = [
  ["direct prepare", async (f, candidate, mode = "create_and_run_task") => {
    const result = await prepareWorkflowStepStart(f.store, candidate.id, { mode },
      f.cwd, () => {}, undefined, f.runnerRegistry);
    return { rejected: result.kind === "error" && result.statusCode === 409,
      result: { kind: result.kind, statusCode: result.statusCode, code: result.code, taskId: result.task?.id } };
  }],
  ["start route", async (f, candidate, mode = "create_and_run_task") => {
    const request = Readable.from([JSON.stringify({ mode })]);
    request.method = "POST";
    request.url = `/workflow-steps/${candidate.id}/start?cwd=${encodeURIComponent(f.cwd)}`;
    request.headers = { host: "localhost" };
    const response = { statusCode: 0, setHeader() {}, writeHead(statusCode) { this.statusCode = statusCode; },
      end(body) { this.body = body; } };
    let dispatches = 0;
    await handleChannelWorkflowStepStartRoute(request, response, { host: "127.0.0.1", port: 1, maxBodyBytes: 1_048_576 },
      { getStore: () => f.store }, candidate.id, () => {}, async ({ runRequest }) => {
        dispatches += 1;
        return linkSchedulerRun(f, f.store.getChannelWorkflowStep(candidate.id), {
          task: { id: runRequest.task.id }, owner: runRequest.workflowStartOwner }, runRequest).id;
      }, undefined, f.runnerRegistry);
    return { rejected: dispatches === 0 && response.statusCode === 409,
      result: { dispatches, statusCode: response.statusCode, body: response.body } };
  }],
  ["atomic Core begin", async (f, candidate) => {
    const result = directCoreBegin(f, candidate);
    return { rejected: result.status === "invalid" || result.status === "stale",
      result: { status: result.status, code: result.code, taskId: result.task?.id } };
  }],
];

for (const wait of ["pending post gate", "linked Run approval", "unattributed workflow wait"]) {
  for (const [entry, start] of entryPoints) {
    test(`${entry} cannot bypass ${wait} with an independent readonly candidate`, async t => {
      const f = await schedulerFixture(t);
      const approval = approvalWait(f, wait);
      const candidate = f.step("Independent readonly candidate");
      const tasksBefore = f.store.listTasks({ channelId: f.channel.id }).length;
      assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
      const outcome = await start(f, candidate);
      assert.equal(outcome.rejected, true, JSON.stringify(outcome.result));
      const current = f.store.getChannelWorkflowStep(candidate.id);
      assert.equal(current.status, "queued");
      assert.equal(current.taskId, undefined);
      assert.equal(current.runId, undefined);
      assert.equal(current.metadata.startOwner, undefined);
      assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, tasksBefore);
      assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
      if (approval) assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
    });
  }
}

for (const [entry, start] of entryPoints.slice(0, 2)) {
  test(`${entry} create_task cannot complete a sibling across a pending post gate`, async t => {
    const f = await schedulerFixture(t);
    const approval = approvalWait(f, "pending post gate");
    const candidate = f.step("Task-only candidate");
    const tasksBefore = f.store.listTasks({ channelId: f.channel.id }).length;
    const outcome = await start(f, candidate, "create_task");
    assert.equal(outcome.rejected, true, JSON.stringify(outcome.result));
    assert.equal(f.store.getChannelWorkflowStep(candidate.id).status, "queued");
    assert.equal(f.store.getChannelWorkflowStep(candidate.id).taskId, undefined);
    assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, tasksBefore);
    assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
  });
}

test("atomic Core begin accepts the same complete Host readonly admission without an approval wait", async t => {
  const f = await schedulerFixture(t);
  const result = directCoreBegin(f, f.step("Unblocked readonly candidate"));
  assert.equal(result.status, "begun", JSON.stringify(result));
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "running");
});

test("direct prepare atomically rejects a post gate created after its initial workflow read", async t => {
  const f = await schedulerFixture(t);
  const post = completedPostStep(f);
  const candidate = f.step("Candidate racing post approval");
  const tasksBefore = f.store.listTasks({ channelId: f.channel.id }).length;
  let approval;
  const result = await prepareWorkflowStepStart(f.store, candidate.id, { mode: "create_and_run_task" }, f.cwd,
    () => { approval = post.request(); }, undefined, f.runnerRegistry);
  assert.ok(approval);
  assert.equal(result.kind, "error", JSON.stringify({ kind: result.kind, code: result.code, taskId: result.task?.id }));
  assert.equal(result.statusCode, 409);
  assert.equal(f.store.getChannelWorkflowStep(candidate.id).status, "queued");
  assert.equal(f.store.getChannelWorkflowStep(candidate.id).taskId, undefined);
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, tasksBefore);
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
  assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
});
