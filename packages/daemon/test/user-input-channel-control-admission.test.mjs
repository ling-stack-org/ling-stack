import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

for (const requiredStep of [0, 1]) {
  test(`workflow cancellation preflights every participant before any approval or state mutation: required step ${requiredStep}`, async t => {
    const f = await fixture(t, requiredStep);
    const before = snapshot(f);
    const result = await cancel(f);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "run_execution_recovery_blocked");
    assert.deepEqual(snapshot(f), before, "a blocked participant cannot leave earlier participants or approvals partially cancelled");
  });
}

test("workflow cancellation preserves ordinary multi-participant cancellation", async t => {
  const f = await fixture(t, undefined);
  const result = await cancel(f);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "cancelled");
  assert.equal(f.store.getApprovalRequest(f.approval.id).status, "cancelled");
  assert.equal(f.runs.every(run => f.store.getRun(run.id).status === "cancelled"), true);
});

test("workflow cancellation leaves a safe yielded source Run immutable", async t => {
  const f = await fixture(t, 1);
  f.store.commitUserInputYield({ threadId: f.thread.id, requestId: f.request.requestId, expectedRequestVersion: 1,
    sourceFence: toRuntimeAttemptFence(f.attempts[1]), quiescence: { kind: "runner_quiesced",
      runnerId: f.attempts[1].runnerId, stoppedAt: f.now, lastRunEventSeq: 0 } }, f.now);
  const runBefore = f.store.getRun(f.runs[1].id);
  const result = await cancel(f);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(f.store.getRun(f.runs[1].id), runBefore);
  assert.equal(f.store.countEvents(f.runs[1].id), 0);
  assert.equal(f.store.getUserInputWait(f.thread.id, f.request.requestId).status, "cancelled");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "cancelled");
});

async function fixture(t, requiredStep) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-channel-control-"));
  let store;
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, port: 0, channels: { terminalReports: false } }, {
    runner: { async runTask() { assert.fail("workflow cancellation must not dispatch a Runner"); } },
    storeFactory: storeCwd => { store = createSqliteRunStore(storeCwd); return store; },
  });
  await daemon.start();
  t.after(async () => { if (daemon.server.listening) await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${daemon.server.address().port}`;
  assert.equal((await fetch(`${url}/runtime?cwd=${encodeURIComponent(cwd)}`)).status, 200);
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "Cancellation preflight", boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id,
    title: "Work together", objective: "Stop safely." }, now).thread;
  const turn = store.appendConversationUserTurn({ threadId: thread.id, channelId: channel.id,
    title: "Work together", userInstruction: "Work together.", idempotencyKey: "channel-control-turn",
    payload: { body: "Work together.", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Work together",
    objective: "Stop safely.", status: "running", createdBy: "local-user" }, now);
  const runs = [], units = [], attempts = [], steps = [];
  for (const [index, teammateId] of ["teammate_builtin_engineer", "teammate_builtin_qa"].entries()) {
    const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: `Step ${index}`, prompt: "Work safely.",
      toParticipantId: teammateId, toParticipantLabel: teammateId, status: "running" }, now);
    const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", channelId: channel.id,
      teammateId, ownerType: "run", ownerId: `channel-control-run-${index}`, status: "running",
      idempotencyKey: `channel-control-unit-${index}`, createdByActor: "system", request: {}, now });
    const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: "channel-control-runtime", runnerId: "runner_pi_embedded", status: "started", now });
    const run = store.createRun({ id: `channel-control-run-${index}`, cwd, taskId: `channel-control-task-${index}`,
      channelId: channel.id, threadId: thread.id, turnId: turn.turnId, teammateId, workflowStepId: step.id,
      workUnitId: unit.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {},
      requestSnapshot: {}, createdAt: now });
    store.linkRunToWorkUnit(run.id, unit.id, now);
    assert.equal(store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now }).ok, true);
    store.updateChannelWorkflowStep(step.id, { runId: run.id }, now);
    runs.push(run); units.push(unit); attempts.push(attempt); steps.push(step);
  }
  const approval = store.createApprovalRequest({ workflowStepId: steps[0].id, channelId: channel.id,
    actionType: "bash", risk: "high", title: "Review a command", description: "Workflow-owned pending approval.",
    payload: { type: "bash", cwd, command: "git status --short", riskFlags: ["requires_user_review"] } }, now);
  const request = requiredStep === undefined ? undefined : store.createUserInputRequest({ sourceRunId: runs[requiredStep].id,
    sourceItemId: turn.item.id, sourceFence: toRuntimeAttemptFence(attempts[requiredStep]),
    toolCallId: "channel-required", idempotencyKey: "channel-required", toolInput: { schemaVersion: 1, waitMode: "required",
      questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] } }, now).request;
  for (const [index, attempt] of attempts.entries()) {
    const authority = { ...toRuntimeAttemptFence(attempt), workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "provider",
      resourceKey: `channel-control-provider-${index}`, ownerType: "work_unit_attempt", ownerId: attempt.id,
      acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    assert.ok(store.acquireResourceLease(authority));
    assert.ok(store.acquireRuntimeSemaphoreSlot({ ...authority, limit: 1 }));
  }
  return { cwd, store, daemon, url, now, channel, thread, workflow, steps, units, attempts, runs, approval, request };
}

function snapshot(f) {
  return { workflow: f.store.getChannelWorkflow(f.workflow.id),
    steps: f.store.listChannelWorkflowSteps({ workflowId: f.workflow.id, complete: true }), approval: f.store.getApprovalRequest(f.approval.id),
    runs: f.runs.map(run => f.store.getRun(run.id)), units: f.units.map(unit => f.store.getWorkUnit(unit.id)),
    attempts: f.attempts.map(attempt => f.store.getWorkUnitAttempt(attempt.id)),
    events: f.runs.map(run => f.store.listEvents(run.id)), runtimeEvents: f.units.map(unit => f.store.listRuntimeEvents(unit.id)),
    leases: f.attempts.map(attempt => f.store.listResourceLeases({ attemptId: attempt.id })),
    slots: f.attempts.map(attempt => f.store.listRuntimeSemaphoreSlots({ attemptId: attempt.id })) };
}

async function cancel(f) {
  const response = await fetch(`${f.url}/workflows/${f.workflow.id}/cancel?cwd=${encodeURIComponent(f.cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  return { status: response.status, body: await response.json() };
}
