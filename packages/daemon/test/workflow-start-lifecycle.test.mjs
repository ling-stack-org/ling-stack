import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "../../core/dist/index.js";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { createDaemonServer } from "../dist/index.js";
import { captureWorkflowStartOwner, assertWorkflowRunAdmission } from "../dist/features/runs/workflow-step-start-admission.js";
import { finalizeOrchestratedWorkflowStepRun } from "../dist/features/channels/orchestrator.js";

const participantId = "teammate_builtin_engineer";

/** Every case retains its own SQLite evidence; no daily workspace, model or Keychain. */
async function fixture(t, { startDaemon = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a12-workflow-lifecycle-"));
  t.diagnostic(`A12 lifecycle retained root: ${cwd}`);
  const f = { cwd, runnerCalls: 0, store: createSqliteRunStore(cwd) };
  t.after(async () => { if (f.daemon) await f.daemon.stop(); else f.store.close(); });
  f.startDaemon = async () => {
    f.store.close();
    f.daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
      cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
    }, { secretResolver: createCompositeSecretResolver({ env: {} }), chromeBrowserNativeMessagingEnabled: false,
      runner: { async runTask() { f.runnerCalls += 1; throw new Error("A12 lifecycle must not invoke a Runner"); } },
      storeFactory(storeCwd) { assert.equal(storeCwd, cwd); f.store = createSqliteRunStore(cwd); return f.store; },
    });
    await f.daemon.start();
    const address = f.daemon.server.address();
    assert.ok(address && typeof address === "object");
    f.origin = `http://127.0.0.1:${address.port}`;
  };
  if (startDaemon) await f.startDaemon();
  const now = new Date().toISOString();
  f.channel = f.store.createChannel({ name: "A12 lifecycle", boundPath: cwd, allowedTools: ["read"] }, now);
  f.source = appendChannelItemFixture(f.store, { channelId: f.channel.id, authorType: "local-user", body: "Read the owned file" }, now);
  f.workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Owned workflow", objective: "Read the owned file",
    createdBy: "local-user", status: "running", metadata: { sourceMessageId: f.source.id, sourceTurnId: f.source.turnId } }, now);
  f.step = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Inspect", prompt: "Read the owned file",
    toParticipantId: participantId, toParticipantLabel: "Engineer" }, now);
  return f;
}

function begin(f) {
  const now = new Date().toISOString();
  const lease = f.store.acquireResourceLease({ workspaceId: "workspace_default", resourceType: "workflow_step", resourceKey: f.step.id,
    ownerType: "workflow_step", ownerId: f.step.id, acquiredAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(lease);
  const result = f.store.beginChannelWorkflowStepStart({ workflowStepId: f.step.id, expected: f.store.getChannelWorkflowStep(f.step.id),
    leaseId: lease.id, task: { channelId: f.channel.id, assigneeTeammateId: participantId, title: "Inspect", prompt: "Read the owned file" }, now });
  assert.equal(result.status, "begun", JSON.stringify(result));
  return { ...result, lease };
}

function createPreparedRun(f, generation) {
  const now = new Date().toISOString();
  assert.equal(f.store.transitionTaskStatus({ taskId: generation.task.id, expectedStatus: "todo", event: "claim", actor: "system", now }).ok, true);
  const run = f.store.createRun({ id: `run_${generation.task.id}`, cwd: f.cwd, taskId: generation.task.id,
    channelId: f.channel.id, workflowStepId: f.step.id, teammateId: participantId,
    providerName: "local-fixture", providerModel: "local-fixture", taskSnapshot: generation.task,
    providerSnapshot: {}, requestSnapshot: { cwd: f.cwd }, createdAt: now });
  const unit = f.store.createWorkUnit({ id: `unit_${run.id}`, workspaceId: "workspace_default", kind: "task_run",
    ownerType: "run", ownerId: run.id, channelId: f.channel.id, taskId: generation.task.id, teammateId: participantId,
    runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: `unit:${run.id}`, createdByActor: "system", request: {}, linkedRunId: run.id, now });
  const attempt = f.store.createWorkUnitAttempt({ id: `attempt_${run.id}`, workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "local-fixture", runnerId: "pi", effectiveRunnerId: "pi", now });
  f.store.linkRunToWorkUnit(run.id, unit.id, now);
  return { run: f.store.getRun(run.id), unit, attempt };
}

async function orchestrate(f) {
  const response = await fetch(`${f.origin}/workflows/${f.workflow.id}/orchestrate?cwd=${encodeURIComponent(f.cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}

function state(f) {
  return { workflow: f.store.getChannelWorkflow(f.workflow.id), step: f.store.getChannelWorkflowStep(f.step.id),
    tasks: f.store.listTasks({ channelId: f.channel.id }), runs: f.store.listRuns({ workflowStepId: f.step.id }),
    leases: f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: f.step.id, limit: 100 }) };
}

test("A12 actual daemon restart blocks preparing immediately and releases only its exact lease", async (t) => {
  const f = await fixture(t);
  const generation = begin(f);
  const before = state(f);
  assert.equal(before.step.metadata.startOwner.phase, "preparing");
  assert.equal(before.runs.length, 0);
  await f.startDaemon();
  const after = state(f);
  assert.equal(after.step.status, "blocked");
  assert.equal(after.workflow.status, "blocked");
  assert.match(after.step.blocker, /restarted.*retry required/u);
  assert.equal(after.step.taskId, generation.task.id);
  assert.equal(after.step.runId, undefined);
  assert.equal(after.tasks.length, 1);
  assert.equal(after.runs.length, 0);
  assert.equal(after.leases.find((lease) => lease.id === generation.lease.id).status, "released");
  assert.equal(f.runnerCalls, 0);
});

test("A12 online explicit reconcile preserves legitimate preparing without starting another Run", async (t) => {
  const f = await fixture(t, { startDaemon: true });
  begin(f);
  const before = state(f);
  const response = await orchestrate(f);
  assert.equal(response.status, 200, JSON.stringify(response));
  const after = state(f);
  assert.deepEqual(after, before);
  assert.equal(after.step.status, "running");
  assert.equal(after.step.metadata.startOwner.phase, "preparing");
  assert.equal(f.runnerCalls, 0);
});

for (const corruption of ["missing", "malformed"]) {
  test(`A12 online reconcile blocks ${corruption} start owner without inventing or releasing an owner`, async (t) => {
    const f = await fixture(t, { startDaemon: true });
    const generation = begin(f);
    const current = f.store.getChannelWorkflowStep(f.step.id);
    const { startOwner, ...metadata } = current.metadata;
    f.store.updateChannelWorkflowStep(f.step.id, { metadata: corruption === "missing" ? metadata
      : { ...metadata, startOwner: { schemaVersion: 1, phase: "preparing", taskId: "bad" } } }, new Date().toISOString());
    const response = await orchestrate(f);
    assert.equal(response.status, 200, JSON.stringify(response));
    const after = state(f);
    assert.equal(after.step.status, "blocked");
    assert.match(after.step.blocker, /ownership is invalid/u);
    assert.equal(after.step.metadata.startOwner, undefined);
    assert.equal(after.leases.find((lease) => lease.id === generation.lease.id).status, "active", "a lost marker cannot authorize a guessed release");
    assert.equal(after.runs.length, 0);
    assert.equal(f.runnerCalls, 0);
  });
}

test("A12 real source edit supersedes preparing authority before ready or execution", async (t) => {
  const f = await fixture(t);
  const generation = begin(f);
  const prepared = createPreparedRun(f, generation);
  const source = f.store.getConversationItem(f.source.id);
  const content = { body: f.source.body, mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] };
  const edited = f.store.commitConversationMessageEdit({ surface: "channel_root", ownerId: f.channel.id, laneId: source.threadId,
    messageId: source.id, expectedRevision: 1, current: content, replacement: { ...content, body: "Do not read; explain only" },
    sourceTurnId: source.turnId, supersededTurnId: source.turnId, idempotencyKey: "a12-real-source-edit" }, new Date().toISOString());
  assert.equal(edited.revision.body, "Do not read; explain only");
  assert.equal(f.store.getLingTurn(source.turnId).status, "superseded");
  assert.throws(() => captureWorkflowStartOwner(f.store, { task: generation.task, workflowStepId: f.step.id,
    workflowStartOwner: generation.owner }), /no longer owns/u);
  const rejected = f.store.commitChannelWorkflowStepRunReady({ workflowStepId: f.step.id, owner: generation.owner,
    runId: prepared.run.id, now: new Date().toISOString() });
  assert.equal(rejected.status, "stale");
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, undefined);
  assert.equal(f.store.getTask(generation.task.id).currentRunId, undefined);
  assert.throws(() => assertWorkflowRunAdmission(f.store, prepared.run, generation.owner), /cancelled, superseded or replaced/u);
  assert.equal(f.runnerCalls, 0);
});

test("A12 late preparing failure cannot block a linked Run from the same generation", async (t) => {
  const f = await fixture(t);
  const generation = begin(f);
  const prepared = createPreparedRun(f, generation);
  assert.equal(f.store.commitChannelWorkflowStepRunReady({ workflowStepId: f.step.id, owner: generation.owner,
    runId: prepared.run.id, now: new Date().toISOString() }).status, "linked");
  const before = state(f);
  const result = f.store.settleChannelWorkflowStepStartFailure({ workflowStepId: f.step.id, owner: generation.owner,
    leaseId: generation.lease.id, blocker: "Late preparation failure", now: new Date().toISOString() });
  assert.equal(result.status, "stale");
  assert.deepEqual(state(f), before);
  assertWorkflowRunAdmission(f.store, prepared.run, before.step.metadata.startOwner);
});

function durableFinalizationState(f) {
  const database = new DatabaseSync(f.store.paths.databasePath, { readOnly: true });
  try {
    return Object.fromEntries(["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions",
      "resource_leases", "approval_requests", "artifacts", "conversation_items", "state_transition_events"]
      .map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  } finally { database.close(); }
}

async function successfulOrdinaryGeneration(t) {
  const f = await fixture(t);
  // This manual workflow carries the source Turn, but consumes no private
  // context packet. Its real success therefore reaches ordinary completion.
  f.store.updateChannelWorkflow(f.workflow.id, { metadata: { sourceTurnId: f.source.turnId } }, new Date().toISOString());
  const generation = begin(f);
  const prepared = createPreparedRun(f, generation);
  assert.equal(f.store.commitChannelWorkflowStepRunReady({ workflowStepId: f.step.id, owner: generation.owner,
    runId: prepared.run.id, now: new Date().toISOString() }).status, "linked");
  f.store.markRunSucceeded(prepared.run.id, new Date().toISOString());
  return { f, generation, prepared };
}

function replaceLinkedGeneration(f, generation) {
  const step = f.store.getChannelWorkflowStep(f.step.id);
  assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id,
    expectedStatus: "running", expectedStartOwner: step.metadata.startOwner, event: "blocked",
    actor: "system", reason: "A12 real generation replacement", now: new Date().toISOString() }).ok, true);
  f.store.releaseResourceLease(generation.lease.id, "workflow_step", step.id, new Date().toISOString());
  const replacement = begin(f);
  const prepared = createPreparedRun(f, replacement);
  assert.equal(f.store.commitChannelWorkflowStepRunReady({ workflowStepId: step.id, owner: replacement.owner,
    runId: prepared.run.id, now: new Date().toISOString() }).status, "linked");
  return { replacement, prepared };
}

test("A12 ordinary successful finalizer completes its own Step and exact lease", async (t) => {
  const { f, generation, prepared } = await successfulOrdinaryGeneration(t);
  const result = finalizeOrchestratedWorkflowStepRun(f.store, f.step.id, generation.task.id,
    f.store.getRun(prepared.run.id), new Date().toISOString());
  assert.equal(result.status, "succeeded");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "succeeded");
  assert.equal(state(f).leases.find((lease) => lease.id === generation.lease.id).status, "released");
});

test("A12 ordinary finalizer stops after a lost completion CAS without publishing or releasing C", async (t) => {
  const { f, generation, prepared } = await successfulOrdinaryGeneration(t);
  const originalTransition = f.store.transitionChannelWorkflowStepStatus.bind(f.store);
  let replacementState;
  let captured;
  f.store.transitionChannelWorkflowStepStatus = (input) => {
    if (input.event === "succeed" && !captured) {
      captured = input;
      const current = replaceLinkedGeneration(f, generation);
      assert.notEqual(current.replacement.task.id, generation.task.id);
      replacementState = durableFinalizationState(f);
    }
    return originalTransition(input);
  };
  const result = finalizeOrchestratedWorkflowStepRun(f.store, f.step.id, generation.task.id,
    f.store.getRun(prepared.run.id), new Date().toISOString());
  assert.equal(captured.expectedStartOwner.taskId, generation.task.id);
  assert.equal(captured.runId, prepared.run.id);
  assert.equal(result.status, "running");
  assert.notEqual(result.taskId, generation.task.id);
  assert.deepEqual(durableFinalizationState(f), replacementState,
    "a rejected B completion must not add artifact/reply/audit or release C");
  assert.equal(state(f).leases.find((lease) => lease.id === result.metadata.startOwner.leaseId).status, "active");
});

for (const corruption of ["pending", "denied", "foreign channel", "foreign workflow", "foreign canonical step",
  "foreign payload step", "wrong type", "post gate"]) {
  test(`B013 online reconcile rejects unversioned ${corruption} PRE approval as stale admission`, async (t) => {
    const f = await fixture(t, { startDaemon: true });
    const now = new Date().toISOString();
    // These legacy fixtures deliberately have no Host-frozen preGateBasis.
    // An id/status alone cannot authorize a new Task under B013, even approved.
    assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: f.step.id, expectedStatus: "queued",
      event: "claim", actor: "system", now }).ok, true);
    assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: f.step.id, expectedStatus: "claimed",
      event: "start", actor: "system", now }).ok, true);
    let foreignChannel;
    let foreignWorkflow;
    let foreignStep;
    if (corruption.startsWith("foreign")) {
      foreignChannel = f.store.createChannel({ name: "A12 foreign gate channel" }, now);
      foreignWorkflow = f.store.createChannelWorkflow({ channelId: foreignChannel.id, title: "Foreign gate workflow",
        objective: "Must not authorize the target Step", createdBy: "local-user", status: "ready" }, now);
      foreignStep = f.store.createChannelWorkflowStep({ workflowId: foreignWorkflow.id, title: "Foreign gate Step",
        prompt: "Do not run", toParticipantId: participantId, toParticipantLabel: "Engineer" }, now);
    }
    const approval = f.store.createApprovalRequest({
      workflowStepId: corruption === "foreign canonical step" ? foreignStep.id : f.step.id,
      channelId: corruption === "foreign channel" ? foreignChannel.id : f.channel.id,
      actionType: "workflow_step", risk: "medium", title: "A12 PRE gate", description: "Validate exact gate lineage",
      payload: { type: corruption === "wrong type" ? "bash" : "workflow_step",
        gateStage: corruption === "post gate" ? "post" : "pre",
        workflowId: corruption === "foreign workflow" ? foreignWorkflow.id : f.workflow.id,
        workflowStepId: corruption === "foreign payload step" ? foreignStep.id : f.step.id,
        title: "A12 PRE gate", approvalMode: "standard", requiredForTools: [], requiredForActions: [] },
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    }, now);
    if (corruption === "denied") {
      assert.equal(f.store.denyApprovalRequest(approval.id, { resolvedBy: "local-user" }, now).status, "denied");
    } else if (corruption !== "pending") {
      assert.equal(f.store.approveApprovalRequest(approval.id, { resolvedBy: "local-user" }, now).status, "approved");
    }
    const current = f.store.getChannelWorkflowStep(f.step.id);
    f.store.updateChannelWorkflowStep(f.step.id, { metadata: { ...current.metadata,
      activeGateStage: "pre", preStepApprovalId: approval.id } }, now);
    const before = state(f);
    assert.equal(before.step.status, "running");
    assert.equal(before.step.taskId, undefined);
    assert.equal(before.step.runId, undefined);
    assert.equal(before.step.metadata.startOwner, undefined);
    assert.equal(f.store.getApprovalRequest(approval.id).status,
      corruption === "pending" || corruption === "denied" ? corruption : "approved");
    assert.equal(before.tasks.length, 0);
    assert.equal(before.runs.length, 0);
    const response = await orchestrate(f);
    assert.equal(response.status, 409, JSON.stringify(response));
    assert.equal(response.body.error, "workflow_pre_approval_basis_stale");
    const after = state(f);
    assert.equal(after.step.status, "blocked");
    assert.equal(after.workflow.status, "blocked");
    assert.match(after.step.blocker, /pre-approval changed/u);
    assert.equal(after.step.metadata.preStepApprovalId, undefined);
    assert.equal(after.step.metadata.preStepApprovalMarker, undefined);
    assert.equal(f.store.getApprovalRequest(approval.id).status,
      corruption === "pending" || corruption === "denied" ? corruption : "approved",
      "retiring a stale active pointer must preserve the original Approval audit");
    assert.equal(after.step.taskId, undefined);
    assert.equal(after.step.runId, undefined);
    assert.equal(after.step.metadata.startOwner, undefined);
    assert.equal(after.tasks.length, 0);
    assert.equal(after.runs.length, 0);
    assert.equal(f.store.listRuns().length, 0);
    assert.equal(f.runnerCalls, 0);
  });
}
