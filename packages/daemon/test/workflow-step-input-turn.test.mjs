import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { ensureLingTurnForRun } from "../dist/features/runs/threads.js";

const now = "2026-10-19T00:00:00.000Z";
const later = "2026-10-19T00:00:01.000Z";
const participantId = "teammate_builtin_engineer";

async function fixture(t, { withSource = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-workflow-child-input-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "Workflow child input", boundPath: cwd }, now);
  const source = withSource ? appendChannelItemFixture(store, {
    channelId: channel.id,
    authorType: "local-user",
    body: "Delegate the current prompt.",
  }, now) : undefined;
  const taskInput = {
    title: "Current delegated title",
    prompt: "Current delegated prompt with exact context.",
  };
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Delegated workflow",
    objective: "Complete delegated work",
    status: "ready",
    createdBy: "local-user",
    ...(source ? { metadata: { sourceMessageId: source.id, sourceTurnId: source.turnId } } : {}),
  }, now);
  const createdStep = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Delegated step",
    prompt: taskInput.prompt,
    toParticipantId: participantId,
    toParticipantLabel: "Engineer",
    ...(source ? { metadata: { sourceMessageId: source.id } } : {}),
  }, now);
  const lease = store.acquireResourceLease({ workspaceId: channel.workspaceId,
    resourceType: "workflow_step", resourceKey: createdStep.id, ownerType: "workflow_step", ownerId: createdStep.id,
    acquiredAt: now, expiresAt: "2026-10-19T01:00:00.000Z" });
  assert.ok(lease);
  const generation = store.beginChannelWorkflowStepStart({
    workflowStepId: createdStep.id,
    expected: store.getChannelWorkflowStep(createdStep.id),
    leaseId: lease.id,
    task: { ...taskInput, channelId: channel.id, assigneeTeammateId: participantId },
    now,
  });
  assert.equal(generation.status, "begun", JSON.stringify(generation));
  const task = generation.task;
  const step = store.getChannelWorkflowStep(createdStep.id);
  const thread = store.createLingThread({
    kind: "workflow_step",
    channelId: channel.id,
    taskId: task.id,
    teammateId: participantId,
    workflowId: workflow.id,
    workflowStepId: step.id,
    title: "Stale cached title",
    objective: "Stale cached objective that must not become current Run input.",
  }, now);
  const request = {
    cwd,
    task: { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt },
    teammateId: participantId,
    workflowStepId: step.id,
    workflowStartOwner: generation.owner,
    ...(source ? { sourceMessageId: source.id } : {}),
    idempotencyKey: "workflow-child-input:exact",
  };
  return { cwd, store, channel, source, task, workflow, step, thread, request, generation, lease };
}

test("workflow child input stores exact Run prompt, child context and one exact replay", async (t) => {
  const f = await fixture(t);
  const first = ensureLingTurnForRun(f.store, f.thread, f.request, now);
  const sourceItem = f.store.getConversationItem(first.sourceItemId);
  assert.equal(sourceItem.payload.body, f.request.task.prompt);
  assert.equal(first.title, f.request.task.title);
  assert.equal(first.userInstruction, f.request.task.prompt);
  assert.equal(sourceItem.threadId, f.thread.id);
  assert.equal(sourceItem.turnId, first.id);
  const assignment = f.store.getEffectiveTurnContextAssignment(first.id);
  assert.ok(assignment);
  assert.equal(f.store.getContextSegment(assignment.segmentId).threadId, f.thread.id);
  assert.ok(sourceItem.domainRefs.some((ref) => ref.type === "conversation_item" && ref.id === f.source.id));
  assert.ok(sourceItem.domainRefs.some((ref) => ref.type === "workflow_step" && ref.id === f.step.id));

  const replay = ensureLingTurnForRun(f.store, f.thread, f.request, later);
  assert.equal(replay.id, first.id);
  assert.equal(replay.sourceItemId, first.sourceItemId);
  assert.equal(f.store.listConversationItemsForTurn({ turnId: first.id })
    .filter((item) => item.kind === "user_message").length, 1);
});

test("workflow child input rejects changed prompt under the same idempotency identity", async (t) => {
  const f = await fixture(t);
  ensureLingTurnForRun(f.store, f.thread, f.request, now);
  assert.throws(() => ensureLingTurnForRun(f.store, f.thread, {
    ...f.request,
    task: { ...f.request.task, prompt: "A different retry instruction must not replay stale input." },
  }, later), /idempotency|another input|does not match/u);
});

test("workflow retry generation preserves the stable Thread and owns its new Task atomically", async (t) => {
  const f = await fixture(t);
  const first = ensureLingTurnForRun(f.store, f.thread, f.request, now);
  const settled = f.store.settleChannelWorkflowStepStartFailure({
    workflowStepId: f.step.id,
    owner: f.generation.owner,
    leaseId: f.lease.id,
    blocker: "Retry the same logical step with a new Task generation.",
    now: later,
  });
  assert.equal(settled.status, "linked", JSON.stringify(settled));
  const retryLease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId,
    resourceType: "workflow_step", resourceKey: f.step.id, ownerType: "workflow_step", ownerId: f.step.id,
    acquiredAt: later, expiresAt: "2026-10-19T01:00:01.000Z" });
  assert.ok(retryLease);
  const retry = f.store.beginChannelWorkflowStepStart({
    workflowStepId: f.step.id,
    expected: f.store.getChannelWorkflowStep(f.step.id),
    leaseId: retryLease.id,
    task: { channelId: f.channel.id, title: "Retry generation title", prompt: "Retry generation prompt.",
      assigneeTeammateId: participantId },
    now: later,
  });
  assert.equal(retry.status, "begun", JSON.stringify(retry));
  assert.notEqual(retry.task.id, f.task.id);
  const retryRequest = { ...f.request,
    task: { id: retry.task.id, channelId: f.channel.id, title: retry.task.title, prompt: retry.task.prompt },
    workflowStartOwner: retry.owner,
    idempotencyKey: "workflow-child-input:retry-generation",
  };
  const second = ensureLingTurnForRun(f.store, f.store.getLingThread(f.thread.id), retryRequest, later);
  assert.notEqual(second.id, first.id);
  assert.equal(second.threadId, f.thread.id);
  assert.equal(second.taskId, retry.task.id);
  assert.equal(second.workflowStepId, f.step.id);
  assert.equal(f.store.getLingTurn(first.id).taskId, f.task.id);
  assert.equal(f.store.getLingThread(f.thread.id).taskId, f.task.id,
    "retry must not rewrite the stable Thread's original Task owner outside canonical append");
  assert.equal(f.store.getConversationItem(second.sourceItemId).payload.body, retry.task.prompt);
  const assignment = f.store.getEffectiveTurnContextAssignment(second.id);
  assert.ok(assignment);
  assert.equal(f.store.getContextSegment(assignment.segmentId).threadId, f.thread.id);
  assert.equal(ensureLingTurnForRun(f.store, f.thread, retryRequest, later).id, second.id);
});

test("source-less workflow input still creates system canonical input and child context", async (t) => {
  const f = await fixture(t, { withSource: false });
  const turn = ensureLingTurnForRun(f.store, f.thread, f.request, now);
  assert.equal(turn.createdByActor, "system");
  const item = f.store.getConversationItem(turn.sourceItemId);
  assert.ok(item, "a manual/template workflow must not fall back to a source-less generic Turn");
  assert.equal(item.kind, "user_message");
  assert.equal(item.actorType, "system");
  assert.equal(item.actorId, "workflow-dispatch");
  assert.equal(item.threadId, f.thread.id);
  assert.equal(item.turnId, turn.id);
  assert.equal(item.payload.body, f.task.prompt);
  assert.ok(item.domainRefs.some((ref) => ref.type === "workflow" && ref.id === f.workflow.id));
  assert.ok(item.domainRefs.some((ref) => ref.type === "workflow_step" && ref.id === f.step.id));
  assert.ok(item.domainRefs.some((ref) => ref.type === "task" && ref.id === f.task.id));
  assert.equal(item.domainRefs.some((ref) => ref.type === "conversation_item"), false);
  const assignment = f.store.getEffectiveTurnContextAssignment(turn.id);
  assert.ok(assignment);
  assert.equal(f.store.getContextSegment(assignment.segmentId).threadId, f.thread.id);
  assert.equal(ensureLingTurnForRun(f.store, f.thread, f.request, later).id, turn.id);
});

test("workflow child input rejects an explicit parent Run with no canonical Turn without writes", async (t) => {
  const f = await fixture(t);
  const before = f.store.getLingThread(f.thread.id);
  assert.throws(() => ensureLingTurnForRun(f.store, f.thread, {
    ...f.request,
    parentRunId: "run_without_canonical_turn",
  }, now), /parent.*(Run|turn)|lineage/iu);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, before.nextItemSequence);
  assert.equal(f.store.listLingTurns({ threadId: f.thread.id }).length, 0);
});

test("workflow child input rejects forged workspace and archived Thread ownership", async (t) => {
  const forged = await fixture(t);
  assert.throws(() => ensureLingTurnForRun(forged.store, {
    ...forged.thread,
    workspaceId: "workspace_other",
  }, forged.request, now), /lineage|workspace/u);

  const parentArchived = await fixture(t);
  parentArchived.store.updateLingThread(parentArchived.source.threadId, {
    status: "archived",
    archivedAt: later,
  }, later);
  assert.throws(() => ensureLingTurnForRun(
    parentArchived.store,
    parentArchived.thread,
    parentArchived.request,
    later,
  ), /lineage|archived/u);

  const childArchived = await fixture(t);
  const archivedChild = childArchived.store.updateLingThread(childArchived.thread.id, {
    status: "archived",
    archivedAt: later,
  }, later);
  assert.ok(archivedChild);
  assert.throws(() => ensureLingTurnForRun(
    childArchived.store,
    archivedChild,
    childArchived.request,
    later,
  ), /lineage|archived/u);
});

for (const terminal of ["cancelled", "superseded"]) {
  test(`workflow child input rejects ${terminal} root authority`, async (t) => {
    const f = await fixture(t);
    if (terminal === "cancelled") {
      assert.equal(f.store.transitionLingTurnStatus({
        turnId: f.source.turnId,
        expectedStatus: "open",
        event: "cancel",
        actor: "user",
        now: later,
      }).ok, true);
    } else {
      const item = f.store.getConversationItem(f.source.id);
      const current = {
        body: item.payload.body,
        mentions: item.payload.mentions,
        attachmentIds: item.payload.attachmentIds,
        linkPreviewIds: item.payload.linkPreviewIds,
        fileRefs: item.payload.fileRefs,
      };
      f.store.commitConversationMessageEdit({
        surface: "channel_root",
        ownerId: f.channel.id,
        laneId: item.threadId,
        messageId: item.id,
        expectedRevision: 1,
        current,
        replacement: { ...current, body: "Replace the delegated instruction." },
        sourceTurnId: item.turnId,
        supersededTurnId: item.turnId,
        supersededRunIds: [],
        supersededResponseMessageIds: [],
        idempotencyKey: "workflow-child-input:supersede-root",
      }, later);
    }
    assert.equal(f.store.getLingTurn(f.source.turnId).status, terminal);
    assert.throws(() => ensureLingTurnForRun(f.store, f.thread, f.request, later), /lineage|cancelled|superseded/u);
  });
}
