import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { appendChannelItemFixture } from "./channel-conversation-fixture.mjs";

const at = (tick) => new Date(Date.UTC(2026, 9, 14) + tick * 1_000).toISOString();
const participantId = "teammate_builtin_engineer";

/** Test-only preparation. The parent runner owns isolated execution and builds. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a12-core-post-approval-"));
  const preserve = process.env.LING_A12_KEEP_FIXTURES === "1";
  if (preserve) t.diagnostic(`A12 post-approval retained fixture root: ${cwd}`);
  const f = { cwd };
  t.after(async () => {
    try { f.observer?.close(); }
    finally {
      try { f.store?.close(); }
      finally { if (!preserve) await rm(cwd, { recursive: true, force: true }); }
    }
  });
  f.store = createSqliteRunStore(cwd);
  // A separate connection must observe the committed result or the full rollback.
  f.observer = new DatabaseSync(f.store.paths.databasePath);
  f.observer.exec("PRAGMA busy_timeout=1");
  f.channel = f.store.createChannel({ name: "A12 post-approval ownership", boundPath: cwd }, at(0));
  const source = appendChannelItemFixture(f.store, { channelId: f.channel.id,
    authorType: "local-user", body: "Read evidence.txt and ask me to approve the completed result." }, at(0));
  f.source = f.store.getConversationItem(source.id);
  assert.ok(f.source?.turnId);
  f.workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "A12 result review",
    objective: "Only the current successful generation may request result approval", status: "ready", createdBy: "local-user",
    metadata: { sourceMessageId: f.source.id, sourceTurnId: f.source.turnId } }, at(0));
  f.step = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Read owned evidence",
    prompt: "Read evidence.txt", toParticipantId: participantId, toParticipantLabel: "Engineer", metadata: {
      sourceMessageId: f.source.id,
      policy: { onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true },
      gates: [{ stage: "post", approvalProfile: { mode: "standard", risk: "medium" }, title: "Review completed evidence",
        reason: "A local user must review the successful result.", requiredForStatuses: ["succeeded"] }],
    } }, at(0));
  return f;
}

/** Produce each generation through the same durable begin API, never raw SQL. */
function begin(f, suffix = "B", tick = 1) {
  const acquired = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workflow_step",
    resourceKey: f.step.id, ownerType: "workflow_step", ownerId: f.step.id, acquiredAt: at(tick), expiresAt: at(tick + 3_600) });
  assert.ok(acquired);
  const step = f.store.getChannelWorkflowStep(f.step.id);
  const result = f.store.beginChannelWorkflowStepStart({ workflowStepId: step.id,
    expected: { status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt }, leaseId: acquired.id,
    task: { channelId: f.channel.id, title: `A12 result generation ${suffix}`, prompt: step.prompt, assigneeTeammateId: participantId },
    now: at(tick + 1) });
  assert.equal(result.status, "begun", JSON.stringify(result));
  return { ...result, lease: acquired, suffix, tick };
}

/** Claim a real Task, create its WorkUnit/Attempt, then atomically link both owners. */
function ready(f, generation) {
  const tick = generation.tick + 2;
  assert.equal(f.store.transitionTaskStatus({ taskId: generation.task.id, expectedStatus: "todo",
    event: "claim", actor: "system", now: at(tick) }).ok, true);
  const task = f.store.getTask(generation.task.id);
  const run = f.store.createRun({ id: `a12-post-approval-run-${generation.suffix}`, cwd: f.cwd, taskId: task.id,
    channelId: f.channel.id, teammateId: participantId, workflowStepId: f.step.id,
    threadId: f.source.threadId, turnId: f.source.turnId, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: { cwd: f.cwd }, createdAt: at(tick) });
  const unit = f.store.createWorkUnit({ id: `a12-post-approval-unit-${generation.suffix}`, workspaceId: f.channel.workspaceId,
    kind: "task_run", ownerType: "task", ownerId: task.id, taskId: task.id, channelId: f.channel.id,
    teammateId: participantId, runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: `a12-post-approval-unit-${generation.suffix}`,
    createdByActor: "system", request: {}, now: at(tick) });
  f.store.linkRunToWorkUnit(run.id, unit.id, at(tick));
  f.store.createWorkUnitAttempt({ id: `a12-post-approval-attempt-${generation.suffix}`, workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: `a12-post-approval-runtime-${generation.suffix}`, runnerId: "pi", effectiveRunnerId: "pi", now: at(tick) });
  assert.equal(f.store.commitChannelWorkflowStepRunReady({ workflowStepId: f.step.id, owner: generation.owner,
    runId: run.id, now: at(tick + 1) }).status, "linked");
  const linked = f.store.getChannelWorkflowStep(f.step.id);
  assert.equal(linked.metadata.startOwner.phase, "linked");
  assert.equal(f.store.getTask(task.id).currentRunId, run.id);
  return { ...generation, owner: linked.metadata.startOwner, run: f.store.getRun(run.id) };
}

function succeed(f, generation) {
  const tick = generation.tick + 4;
  assert.equal(f.store.transitionRunStatus({ runId: generation.run.id, expectedStatus: "queued",
    event: "runner_started", actor: "runner", now: at(tick) }).ok, true);
  assert.equal(f.store.transitionRunStatus({ runId: generation.run.id, expectedStatus: "running",
    event: "runner_succeeded", actor: "runner", now: at(tick + 1) }).ok, true);
  assert.equal(f.store.getRun(generation.run.id).status, "succeeded");
  return { ...generation, run: f.store.getRun(generation.run.id) };
}

function postApprovalInput(f, generation, tick = generation.tick + 6) {
  return { workflowStepId: f.step.id, owner: generation.owner, runId: generation.run.id, now: at(tick),
    approval: { risk: "medium", title: "Review completed evidence", description: "Approve this generation's completed result.",
      expiresAt: at(tick + 1_800), payload: { type: "workflow_step", gateStage: "post", workflowId: f.workflow.id,
        workflowStepId: f.step.id, runId: generation.run.id, title: f.step.title, approvalMode: "standard",
        requiredForTools: [], requiredForActions: [] } } };
}

function exactLease(f, id) {
  return f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: f.step.id, limit: 100 }).find((entry) => entry.id === id);
}

/** Include checkpoint and thread metadata, not just the visible approval/step rows. */
function snapshot(database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name,
    database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  ]));
}

function approvalTransitions(f, entityType, entityId) {
  return f.store.listStateTransitionEvents({ entityType, entityId, limit: 100 }).filter((event) => event.event === "approval_requested");
}

function assertRequested(f, generation, result) {
  assert.equal(result.status, "requested", JSON.stringify(result));
  const approval = f.store.getApprovalRequest(result.approval.id);
  const step = f.store.getChannelWorkflowStep(f.step.id);
  assert.equal(approval.status, "pending");
  assert.equal(approval.workflowStepId, step.id);
  assert.equal(approval.channelId, f.channel.id);
  assert.equal(approval.actionType, "workflow_step");
  assert.equal(approval.payload.type, "workflow_step");
  assert.equal(approval.payload.gateStage, "post");
  assert.equal(approval.payload.workflowId, f.workflow.id);
  assert.equal(approval.payload.workflowStepId, step.id);
  assert.equal(approval.payload.runId, generation.run.id);
  assert.equal(step.status, "waiting_for_approval");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
  assert.equal(step.taskId, generation.task.id);
  assert.equal(step.runId, generation.run.id);
  assert.deepEqual(step.metadata.startOwner, generation.owner);
  assert.equal(step.metadata.activeGateStage, "post");
  assert.equal(step.metadata.postStepApprovalId, approval.id);
  assert.equal(step.resultSummary, "Run succeeded; waiting for post-step approval.");
  assert.equal(step.blocker, `Waiting for post-step approval: ${approval.title}`);
  assert.equal(f.store.listApprovalRequests({ workflowStepId: step.id, complete: true }).length, 1);
  const checkpoint = f.store.getApprovalCheckpointForApproval(approval.id);
  assert.ok(checkpoint);
  assert.equal(checkpoint.workflowStepId, step.id);
  assert.equal(checkpoint.status, "pending");
  assert.equal(checkpoint.sideEffect.runId, generation.run.id);
  assert.equal(approvalTransitions(f, "workflow_step", step.id).length, 1);
  assert.equal(approvalTransitions(f, "workflow", f.workflow.id).length, 1);
  const observedStep = f.observer.prepare("SELECT status, task_id, run_id, metadata_json FROM channel_workflow_steps WHERE id=?").get(step.id);
  assert.equal(observedStep.status, "waiting_for_approval");
  assert.equal(observedStep.task_id, generation.task.id);
  assert.equal(observedStep.run_id, generation.run.id);
  assert.equal(JSON.parse(observedStep.metadata_json).postStepApprovalId, approval.id);
  assert.equal(f.observer.prepare("SELECT COUNT(*) AS count FROM approval_requests WHERE workflow_step_id=?").get(step.id).count, 1);
  assert.equal(f.observer.prepare("SELECT COUNT(*) AS count FROM approval_checkpoints WHERE approval_id=?").get(approval.id).count, 1);
  return approval;
}

for (const released of [false, true]) {
  test(`A12 post approval atomically records the successful linked generation with ${released ? "released" : "active"} exact lease`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    if (released) assert.equal(f.store.releaseResourceLease(b.lease.id, "workflow_step", f.step.id, at(6)), 1);
    const leaseBefore = exactLease(f, b.lease.id);
    assertRequested(f, b, f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, b)));
    assert.deepEqual(exactLease(f, b.lease.id), leaseBefore);
  });
}

test("A12 post approval is a durable duplicate after reopen without a second approval, checkpoint or audit", async (t) => {
  const f = await fixture(t);
  const b = succeed(f, ready(f, begin(f)));
  const approval = assertRequested(f, b, f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, b)));
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  // Opening a Store refreshes builtin teammate metadata. Freeze every user
  // table after that real reopen, immediately before the duplicate operation.
  assert.deepEqual(f.store.getApprovalRequest(approval.id), approval);
  const before = snapshot(f.observer);
  const duplicate = f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, b, 9));
  assert.equal(duplicate.status, "duplicate", JSON.stringify(duplicate));
  assert.deepEqual(duplicate.approval, approval);
  assert.deepEqual(snapshot(f.observer), before);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.postStepApprovalId, approval.id);
});

for (const phase of ["preparing", "linked"]) {
  test(`A12 late B post approval cannot mutate replacement C in ${phase} phase or release C's exact lease`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    const capturedB = postApprovalInput(f, b, 20);
    assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: f.step.id, expectedStatus: "running",
      expectedStartOwner: b.owner, event: "blocked", actor: "system", reason: "Prepare a user-authorized retry", now: at(8) }).ok, true);
    assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "running",
      event: "step_blocked", actor: "system", now: at(8) }).ok, true);
    assert.equal(f.store.releaseResourceLease(b.lease.id, "workflow_step", f.step.id, at(8)), 1);
    let c = begin(f, "C", 10);
    if (phase === "linked") c = succeed(f, ready(f, c));
    assert.notEqual(c.task.id, b.task.id);
    assert.notEqual(c.lease.id, b.lease.id);
    const before = snapshot(f.observer);
    assert.deepEqual(f.store.commitChannelWorkflowStepPostApproval(capturedB),
      { status: "stale", code: "workflow_post_approval_owner_stale" });
    assert.deepEqual(snapshot(f.observer), before);
    const current = f.store.getChannelWorkflowStep(f.step.id);
    assert.equal(current.taskId, c.task.id);
    assert.equal(current.metadata.startOwner.phase, phase);
    assert.equal(current.metadata.postStepApprovalId, undefined);
    assert.equal(current.metadata.activeGateStage, undefined);
    assert.equal(exactLease(f, c.lease.id).status, "active");
    assert.equal(f.store.listApprovalRequests({ workflowStepId: current.id, complete: true }).length, 0);
    if (phase === "linked") {
      assert.equal(current.runId, c.run.id);
      assertRequested(f, c, f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, c, 21)));
    }
  });
}

test("A12 a real source-message edit supersedes B before post approval without orphan records or lease release", async (t) => {
  const f = await fixture(t);
  const b = succeed(f, ready(f, begin(f)));
  const input = postApprovalInput(f, b, 10);
  const payload = f.source.payload;
  const messageRevision = f.store.listConversationMessageRevisions({ surface: "channel_root", messageId: f.source.id }).at(-1)?.revision ?? 1;
  const edited = f.store.commitConversationMessageEdit({ surface: "channel_root", ownerId: f.channel.id,
    laneId: f.source.threadId, messageId: f.source.id, expectedRevision: messageRevision,
    current: { body: payload.body, mentions: payload.mentions, attachmentIds: payload.attachmentIds,
      linkPreviewIds: payload.linkPreviewIds, fileRefs: payload.fileRefs },
    replacement: { body: "Stop reviewing the old result; inspect a different file instead.", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    sourceTurnId: f.source.turnId, supersededTurnId: f.source.turnId, supersededRunIds: [b.run.id],
    supersededResponseMessageIds: [], idempotencyKey: "a12-post-approval-source-edit" }, at(9));
  assert.equal(edited.revision.revision, messageRevision + 1);
  assert.equal(f.store.getLingTurn(f.source.turnId).status, "superseded");
  const before = snapshot(f.observer);
  assert.deepEqual(f.store.commitChannelWorkflowStepPostApproval(input),
    { status: "stale", code: "workflow_post_approval_owner_stale" });
  assert.deepEqual(snapshot(f.observer), before);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.postStepApprovalId, undefined);
  assert.equal(exactLease(f, b.lease.id).status, "active");
});

test("A12 post approval requires a succeeded Run, not a current linked generation alone", async (t) => {
  const f = await fixture(t);
  const b = ready(f, begin(f));
  const before = snapshot(f.observer);
  assert.equal(f.store.getRun(b.run.id).status, "queued");
  assert.deepEqual(f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, b)),
    { status: "stale", code: "workflow_post_approval_owner_stale" });
  assert.deepEqual(snapshot(f.observer), before);
  assert.equal(exactLease(f, b.lease.id).status, "active");
});

for (const [label, replacement] of [
  ["foreign workflow", { workflowId: "workflow_foreign" }],
  ["foreign step", { workflowStepId: "step_foreign" }],
  ["pre gate", { gateStage: "pre" }],
  ["wrong payload type", { type: "run_command" }],
]) {
  test(`A12 post approval refuses ${label} payload before any durable mutation`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    const input = postApprovalInput(f, b);
    const before = snapshot(f.observer);
    assert.deepEqual(f.store.commitChannelWorkflowStepPostApproval({ ...input,
      approval: { ...input.approval, payload: { ...input.approval.payload, ...replacement } } }),
    { status: "invalid", code: "workflow_post_approval_lineage_invalid" });
    assert.deepEqual(snapshot(f.observer), before);
    assert.equal(exactLease(f, b.lease.id).status, "active");
  });
}

function faultTrigger(f, fault) {
  const stepId = f.step.id.replaceAll("'", "''");
  const workflowId = f.workflow.id.replaceAll("'", "''");
  if (fault === "approval-insert") return `BEFORE INSERT ON approval_requests WHEN NEW.workflow_step_id='${stepId}'`;
  if (fault === "step-metadata") return `BEFORE UPDATE OF metadata_json ON channel_workflow_steps
    WHEN NEW.id='${stepId}' AND json_extract(NEW.metadata_json, '$.postStepApprovalId') IS NOT NULL`;
  const entityType = fault === "step-transition-audit" ? "workflow_step" : "workflow";
  const entityId = entityType === "workflow_step" ? stepId : workflowId;
  return `BEFORE INSERT ON state_transition_events
    WHEN NEW.entity_type='${entityType}' AND NEW.entity_id='${entityId}' AND NEW.event='approval_requested'`;
}

for (const fault of ["approval-insert", "step-metadata", "step-transition-audit", "workflow-transition-audit"]) {
  test(`A12 post approval rolls back every durable row on ${fault} failure and succeeds after recovery`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    const input = postApprovalInput(f, b);
    const before = snapshot(f.observer);
    f.observer.exec(`CREATE TRIGGER a12_post_approval_fault ${faultTrigger(f, fault)}
      BEGIN SELECT RAISE(ABORT, 'A12_POST_APPROVAL_TRANSACTION_FAULT'); END`);
    assert.throws(() => f.store.commitChannelWorkflowStepPostApproval(input), /A12_POST_APPROVAL_TRANSACTION_FAULT/);
    // Store read APIs and a distinct SQLite connection must both see the old state.
    assert.deepEqual(snapshot(f.observer), before);
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "running");
    assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "running");
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.postStepApprovalId, undefined);
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.activeGateStage, undefined);
    assert.deepEqual(f.store.listApprovalRequests({ workflowStepId: f.step.id, complete: true }), []);
    assert.equal(exactLease(f, b.lease.id).status, "active");
    f.observer.exec("DROP TRIGGER a12_post_approval_fault");
    assertRequested(f, b, f.store.commitChannelWorkflowStepPostApproval({ ...input, now: at(9) }));
    assert.equal(exactLease(f, b.lease.id).status, "active");
  });
}

/** Resolve the durable decision separately; consuming it must recheck its owner. */
function approvePostGate(f, generation, tick = generation.tick + 6) {
  const pending = assertRequested(f, generation,
    f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, generation, tick)));
  const approved = f.store.approveApprovalRequest(pending.id, { resolvedBy: "local-user" }, at(tick + 1));
  assert.equal(approved?.status, "approved");
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "waiting_for_approval");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
  return approved;
}

function postApprovalResolvedInput(f, generation, approval, tick = generation.tick + 8) {
  return { workflowStepId: f.step.id, owner: generation.owner, runId: generation.run.id, approvalId: approval.id, now: at(tick) };
}

function assertPostApprovalConsumed(f, generation, approval, result) {
  assert.equal(result.status, "linked", JSON.stringify(result));
  const step = f.store.getChannelWorkflowStep(f.step.id);
  assert.equal(step.status, "running");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "running");
  assert.equal(step.taskId, generation.task.id);
  assert.equal(step.runId, generation.run.id);
  assert.deepEqual(step.metadata.startOwner, generation.owner);
  assert.equal(step.metadata.activeGateStage, undefined);
  assert.equal(step.metadata.postStepApprovalId, approval.id);
  assert.equal(f.store.getTask(generation.task.id).currentRunId, generation.run.id);
  assert.equal(f.store.getRun(generation.run.id).status, "succeeded");
  assert.deepEqual(f.store.getApprovalRequest(approval.id), approval);
  assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, "approved");
  assert.equal(f.store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.id, limit: 100 })
    .filter((event) => event.event === "approval_approved").length, 1);
  assert.equal(f.store.listStateTransitionEvents({ entityType: "workflow", entityId: f.workflow.id, limit: 100 })
    .filter((event) => event.event === "approval_approved").length, 1);
  const observed = f.observer.prepare("SELECT status, task_id, run_id, metadata_json FROM channel_workflow_steps WHERE id=?").get(step.id);
  assert.equal(observed.status, "running");
  assert.equal(observed.task_id, generation.task.id);
  assert.equal(observed.run_id, generation.run.id);
  assert.equal(JSON.parse(observed.metadata_json).activeGateStage, undefined);
  assert.equal(JSON.parse(observed.metadata_json).postStepApprovalId, approval.id);
  assert.equal(f.observer.prepare("SELECT status FROM channel_workflows WHERE id=?").get(f.workflow.id).status, "running");
}

function assertResolutionRejected(f, input) {
  const before = snapshot(f.observer);
  const result = f.store.commitChannelWorkflowStepPostApprovalResolved(input);
  assert.ok(result.status === "stale" || result.status === "invalid", JSON.stringify(result));
  assert.deepEqual(snapshot(f.observer), before);
}

for (const released of [false, true]) {
  test(`A12 approved post gate atomically resumes its exact linked owner with ${released ? "released" : "active"} lease`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    const approved = approvePostGate(f, b);
    if (released) assert.equal(f.store.releaseResourceLease(b.lease.id, "workflow_step", f.step.id, at(9)), 1);
    const leaseBefore = exactLease(f, b.lease.id);
    assertPostApprovalConsumed(f, b, approved,
      f.store.commitChannelWorkflowStepPostApprovalResolved(postApprovalResolvedInput(f, b, approved, 10)));
    assert.deepEqual(exactLease(f, b.lease.id), leaseBefore);
  });
}

test("A12 consumed post approval remains a durable zero-write duplicate after reopen", async (t) => {
  const f = await fixture(t);
  const b = succeed(f, ready(f, begin(f)));
  const approved = approvePostGate(f, b);
  assertPostApprovalConsumed(f, b, approved,
    f.store.commitChannelWorkflowStepPostApprovalResolved(postApprovalResolvedInput(f, b, approved, 10)));
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  // Reopen refreshes builtin metadata; freeze only after that unrelated operation.
  const before = snapshot(f.observer);
  const duplicate = f.store.commitChannelWorkflowStepPostApprovalResolved(postApprovalResolvedInput(f, b, approved, 12));
  assert.equal(duplicate.status, "duplicate", JSON.stringify(duplicate));
  assert.deepEqual(snapshot(f.observer), before);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.postStepApprovalId, approved.id);
  assert.equal(exactLease(f, b.lease.id).status, "active");
});

for (const status of ["pending", "denied", "expired", "cancelled"]) {
  test(`A12 consuming a ${status} post approval cannot resume the waiting generation`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    const pending = assertRequested(f, b, f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, b)));
    const resolve = status === "denied" ? "denyApprovalRequest" : status === "expired" ? "expireApprovalRequest"
      : status === "cancelled" ? "cancelApprovalRequest" : undefined;
    if (resolve) assert.equal(f.store[resolve](pending.id, { resolvedBy: "local-user" }, at(8)).status, status);
    assert.equal(f.store.getApprovalRequest(pending.id).status, status);
    assertResolutionRejected(f, postApprovalResolvedInput(f, b, pending, 10));
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "waiting_for_approval");
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.activeGateStage, "post");
    assert.equal(exactLease(f, b.lease.id).status, "active");
  });
}

for (const field of ["taskId", "leaseId", "authorityBasis"]) {
  test(`A12 approved post gate rejects a captured owner with foreign ${field} without durable writes`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    const approved = approvePostGate(f, b);
    const input = postApprovalResolvedInput(f, b, approved, 10);
    const replacement = field === "authorityBasis" ? `wso1_${"0".repeat(64)}` : `foreign-${field}`;
    assert.notEqual(input.owner[field], replacement);
    assertResolutionRejected(f, { ...input, owner: { ...input.owner, [field]: replacement } });
    assert.equal(exactLease(f, b.lease.id).status, "active");
  });
}

test("A12 approved post gate rejects a foreign captured Run and a missing approval ID", async (t) => {
  const f = await fixture(t);
  const b = succeed(f, ready(f, begin(f)));
  const approved = approvePostGate(f, b);
  const input = postApprovalResolvedInput(f, b, approved, 10);
  assertResolutionRejected(f, { ...input, runId: "a12-post-approval-run-foreign" });
  assertResolutionRejected(f, { ...input, approvalId: "a12-post-approval-missing" });
  assert.equal(exactLease(f, b.lease.id).status, "active");
});

test("A12 old B approval cannot clear C's pending post gate, even when passed with C's current owner and Run", async (t) => {
  const f = await fixture(t);
  const b = succeed(f, ready(f, begin(f)));
  const approvedB = approvePostGate(f, b);
  const capturedB = postApprovalResolvedInput(f, b, approvedB, 30);
  // Use actual public retry producers, keeping the old approved decision durable.
  assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: f.step.id, expectedStatus: "waiting_for_approval",
    expectedStartOwner: b.owner, event: "blocked", actor: "system", reason: "Result evidence missing; retry authorized", now: at(10) }).ok, true);
  assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "waiting_for_approval",
    event: "step_blocked", actor: "system", now: at(10) }).ok, true);
  assert.equal(f.store.releaseResourceLease(b.lease.id, "workflow_step", f.step.id, at(10)), 1);
  const c = succeed(f, ready(f, begin(f, "C", 12)));
  const requestedC = f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, c, 20));
  assert.equal(requestedC.status, "requested", JSON.stringify(requestedC));
  const pendingC = f.store.getApprovalRequest(requestedC.approval.id);
  assert.equal(pendingC.status, "pending");
  assert.equal(pendingC.payload.runId, c.run.id);
  assert.equal(pendingC.workflowStepId, f.step.id);
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
  assert.equal(f.store.listApprovalRequests({ workflowStepId: f.step.id, complete: true }).length, 2);
  assert.equal(approvalTransitions(f, "workflow_step", f.step.id).length, 2);
  assert.equal(approvalTransitions(f, "workflow", f.workflow.id).length, 2);
  assert.notEqual(pendingC.id, approvedB.id);
  assertResolutionRejected(f, capturedB);
  assertResolutionRejected(f, { ...postApprovalResolvedInput(f, c, pendingC, 30), approvalId: approvedB.id });
  assertResolutionRejected(f, { ...postApprovalResolvedInput(f, c, pendingC, 30), owner: b.owner });
  const waitingC = f.store.getChannelWorkflowStep(f.step.id);
  assert.equal(waitingC.status, "waiting_for_approval");
  assert.equal(waitingC.metadata.activeGateStage, "post");
  assert.equal(waitingC.metadata.postStepApprovalId, pendingC.id);
  assert.deepEqual(waitingC.metadata.startOwner, c.owner);
  assert.equal(f.store.getApprovalRequest(pendingC.id).status, "pending");
  assert.equal(f.store.getApprovalRequest(approvedB.id).status, "approved");
  assert.equal(exactLease(f, c.lease.id).status, "active");
  const approvedC = f.store.approveApprovalRequest(pendingC.id, { resolvedBy: "local-user" }, at(31));
  assert.equal(approvedC.status, "approved");
  assertPostApprovalConsumed(f, c, approvedC,
    f.store.commitChannelWorkflowStepPostApprovalResolved(postApprovalResolvedInput(f, c, approvedC, 32)));
});

/** Corrupt approval lineage through public producers, never by forging the owner. */
function replaceCanonicalApproval(f, generation, input, tick = 9) {
  const created = f.store.createApprovalRequest({ workflowStepId: f.step.id, channelId: f.channel.id,
    actionType: "workflow_step", ...postApprovalInput(f, generation).approval, ...input }, at(tick));
  const approved = f.store.approveApprovalRequest(created.id, { resolvedBy: "local-user" }, at(tick + 1));
  assert.equal(approved.status, "approved");
  const step = f.store.getChannelWorkflowStep(f.step.id);
  f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, activeGateStage: "post", postStepApprovalId: approved.id } }, at(tick + 1));
  assert.deepEqual(f.store.getChannelWorkflowStep(step.id).metadata.startOwner, generation.owner);
  return approved;
}

for (const [label, replacement] of [
  ["foreign workflow", { workflowId: "a12-workflow-foreign" }],
  ["foreign step", { workflowStepId: "a12-step-foreign" }],
  ["foreign Run", { runId: "a12-post-approval-run-foreign" }],
  ["missing Run", { runId: undefined }],
  ["pre gate", { gateStage: "pre" }],
  ["missing gate stage", { gateStage: undefined }],
  ["wrong payload type", { type: "run_command" }],
]) {
  test(`A12 approved canonical post approval with ${label} payload cannot resume any workflow state`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    assertRequested(f, b, f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, b)));
    const approved = replaceCanonicalApproval(f, b,
      { payload: { ...postApprovalInput(f, b).approval.payload, ...replacement } });
    assertResolutionRejected(f, postApprovalResolvedInput(f, b, approved, 12));
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "waiting_for_approval");
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).metadata.activeGateStage, "post");
    assert.equal(exactLease(f, b.lease.id).status, "active");
  });
}

test("A12 approved canonical post approval with a foreign channel cannot resume its marked step", async (t) => {
  const f = await fixture(t);
  const b = succeed(f, ready(f, begin(f)));
  assertRequested(f, b, f.store.commitChannelWorkflowStepPostApproval(postApprovalInput(f, b)));
  const foreignChannel = f.store.createChannel({ name: "Unrelated approval channel", boundPath: f.cwd }, at(9));
  const approved = replaceCanonicalApproval(f, b, { channelId: foreignChannel.id }, 10);
  assertResolutionRejected(f, postApprovalResolvedInput(f, b, approved, 13));
  assert.equal(exactLease(f, b.lease.id).status, "active");
});

test("A12 approved post gate cannot resume when the linked Run has not succeeded", async (t) => {
  const f = await fixture(t);
  const b = ready(f, begin(f));
  assert.equal(f.store.getRun(b.run.id).status, "queued");
  const approved = replaceCanonicalApproval(f, b, {}, 6);
  assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: f.step.id, expectedStatus: "running",
    expectedStartOwner: b.owner, event: "approval_requested", actor: "system", now: at(8) }).ok, true);
  assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.workflow.id, expectedStatus: "running",
    event: "approval_requested", actor: "system", now: at(8) }).ok, true);
  assertResolutionRejected(f, postApprovalResolvedInput(f, b, approved, 10));
  assert.equal(f.store.getRun(b.run.id).status, "queued");
  assert.equal(exactLease(f, b.lease.id).status, "active");
});

function resolvedFaultTrigger(f, fault) {
  const stepId = f.step.id.replaceAll("'", "''");
  const workflowId = f.workflow.id.replaceAll("'", "''");
  if (fault === "gate-metadata-clear") return `BEFORE UPDATE OF metadata_json ON channel_workflow_steps
    WHEN NEW.id='${stepId}' AND json_extract(OLD.metadata_json, '$.activeGateStage')='post'
      AND json_extract(NEW.metadata_json, '$.activeGateStage') IS NULL`;
  const entityType = fault === "step-transition-audit" ? "workflow_step" : "workflow";
  const entityId = entityType === "workflow_step" ? stepId : workflowId;
  return `BEFORE INSERT ON state_transition_events
    WHEN NEW.entity_type='${entityType}' AND NEW.entity_id='${entityId}' AND NEW.event='approval_approved'`;
}

for (const fault of ["workflow-transition-audit", "step-transition-audit", "gate-metadata-clear"]) {
  test(`A12 consuming approved post gate rolls back both transitions and metadata on ${fault} failure`, async (t) => {
    const f = await fixture(t);
    const b = succeed(f, ready(f, begin(f)));
    const approved = approvePostGate(f, b);
    const input = postApprovalResolvedInput(f, b, approved, 10);
    const before = snapshot(f.observer);
    f.observer.exec(`CREATE TRIGGER a12_post_approval_resolved_fault ${resolvedFaultTrigger(f, fault)}
      BEGIN SELECT RAISE(ABORT, 'A12_POST_APPROVAL_RESOLVED_TRANSACTION_FAULT'); END`);
    assert.throws(() => f.store.commitChannelWorkflowStepPostApprovalResolved(input), /A12_POST_APPROVAL_RESOLVED_TRANSACTION_FAULT/);
    assert.deepEqual(snapshot(f.observer), before);
    const waiting = f.store.getChannelWorkflowStep(f.step.id);
    assert.equal(waiting.status, "waiting_for_approval");
    assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
    assert.equal(waiting.metadata.activeGateStage, "post");
    assert.equal(waiting.metadata.postStepApprovalId, approved.id);
    assert.deepEqual(waiting.metadata.startOwner, b.owner);
    assert.deepEqual(f.store.getApprovalRequest(approved.id), approved);
    assert.equal(f.store.getApprovalCheckpointForApproval(approved.id).status, "approved");
    assert.equal(exactLease(f, b.lease.id).status, "active");
    f.observer.exec("DROP TRIGGER a12_post_approval_resolved_fault");
    assertPostApprovalConsumed(f, b, approved,
      f.store.commitChannelWorkflowStepPostApprovalResolved({ ...input, now: at(12) }));
    assert.equal(exactLease(f, b.lease.id).status, "active");
  });
}
