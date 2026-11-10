import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import { userInputTranscriptFixture as fixture, now } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { listChannelConversationItems } from "../dist/features/channels/channel-conversation-api.js";

const payload = body => ({ body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] });
function session(f, title) {
  return f.store.getLingThread(f.store.createChannelSession({ channelId: f.channel.id, title }, now).session.id);
}
function metrics(f, thread) {
  return listChannelConversationItems({ store: f.store, cwd: f.cwd, channel: f.channel, thread, limit: 1 }).runtimeMetrics;
}
function measuredRun(f, thread, id, tokens, extra = {}) {
  const source = f.store.appendConversationUserTurn({ threadId: thread.id, channelId: f.channel.id,
    title: id, userInstruction: id, idempotencyKey: id, payload: payload(id) }, now);
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: id, idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now });
  const run = f.store.createRun({ id, cwd: f.cwd, taskId: `${id}-task`, threadId: thread.id, turnId: source.turnId,
    channelId: f.channel.id, workUnitId: unit.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: { contextWindow: tokens * 100 }, requestSnapshot: {}, createdAt: now, ...extra });
  f.store.markRunRunning(run.id, now);
  f.store.appendEvent(run.id, "turn_start", {});
  f.store.appendEvent(run.id, "message_end", { role: "assistant",
    usage: { input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1 } });
  f.store.appendEvent(run.id, "turn_end", {});
  f.store.markRunSucceeded(run.id, now);
  return source;
}
function topic(f, anchor, title) {
  return f.store.resolveOrCreateConversationThread({ channelId: f.channel.id, surfaceKind: "topic",
    anchorItemId: anchor.item.id, title, objective: title }, now).thread;
}

test("named sessions isolate measured totals and latest context from each other and legacy channel work", async t => {
  const f = await fixture(t, { surface: "channel" });
  const a = session(f, "Session A");
  const b = session(f, "Session B");
  const root = f.store.listChannelSessions(f.channel.id).defaultSession;
  measuredRun(f, a, "session-a", 12);
  measuredRun(f, b, "session-b", 24);
  measuredRun(f, f.thread, "legacy-work", 36);
  measuredRun(f, f.store.getLingThread(root.id), "canonical-root", 48);
  for (const [thread, total, input, capacity] of [[a, 13, 12, 1200], [b, 25, 24, 2400]]) {
    const actual = metrics(f, thread);
    assert.equal(actual.totalTokens, total);
    assert.equal(actual.aiRounds, 1);
    assert.equal(actual.context.measuredInputTokens, input);
    assert.equal(actual.context.capacityTokens, capacity);
  }
  assert.equal(metrics(f, f.thread).totalTokens, 86);
  assert.equal(metrics(f, f.store.getLingThread(root.id)).totalTokens, 86);
});

test("nested topics inherit their durable session while true forks remain independent", async t => {
  const f = await fixture(t, { surface: "channel" });
  const a = session(f, "Owner");
  const source = measuredRun(f, a, "owner-run", 10);
  const child = topic(f, source, "Topic");
  const childSource = measuredRun(f, child, "topic-run", 20);
  const nested = topic(f, childSource, "Nested topic");
  measuredRun(f, nested, "nested-run", 30);
  const fork = f.store.resolveOrCreateConversationThread({ channelId: f.channel.id, surfaceKind: "branch",
    parentThreadId: a.id, parentTurnId: source.turnId, title: "Fork", objective: "Independent",
    forkContextSnapshot: { id: "metrics-fork-snapshot", segmentId: source.contextSegmentId,
      projectionVersion: "ctxv2_branch_runtime", throughItemSequence: source.item.sequence, summaryIds: [],
      sourceRefs: [{ type: "conversation_item", id: source.item.id }], policyVersion: "continuity-v2-snapshot-v1" } }, now).thread;
  f.store.createChannelBranch({ channelId: f.channel.id, name: "Fork", rootThreadId: fork.id }, now);
  const forkSource = measuredRun(f, fork, "fork-run", 40);
  const forkTopic = topic(f, forkSource, "Fork topic");
  measuredRun(f, forkTopic, "fork-topic-run", 50);
  assert.equal(metrics(f, a).totalTokens, 63);
  assert.equal(metrics(f, nested).totalTokens, 63);
  assert.equal(metrics(f, fork).totalTokens, 92);
  assert.equal(metrics(f, forkTopic).totalTokens, 92);
  assert.equal(metrics(f, f.thread).totalTokens, null);
});

for (const sourceKey of ["sourceTurnId", "sourceMessageId"]) {
  test(`workflow ${sourceKey} scopes execution topics without adding workflow-step usage`, async t => {
    const f = await fixture(t, { surface: "channel" });
    const owner = session(f, "Workflow owner");
    const source = measuredRun(f, owner, "workflow-source", 10);
    const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Workflow", objective: "Work",
      createdBy: "test", metadata: { [sourceKey]: sourceKey === "sourceTurnId" ? source.turnId : source.item.id } }, now);
    const step = f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Step", prompt: "Work",
      toParticipantId: "ling_agent", toParticipantLabel: "Ling" }, now);
    const execution = f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id,
      workflowId: workflow.id, workflowStepId: step.id, title: "Execution", objective: "Work" }, now);
    const executionSource = measuredRun(f, execution, "workflow-step-run", 200, { workflowStepId: step.id });
    const executionTopic = topic(f, executionSource, "Execution topic");
    measuredRun(f, executionTopic, "execution-topic-run", 20);
    assert.equal(metrics(f, owner).totalTokens, 32);
    assert.equal(metrics(f, executionTopic).totalTokens, 32);
    assert.equal(metrics(f, f.thread).totalTokens, null);
    const other = session(f, "Other source");
    const conflicting = measuredRun(f, other, "conflicting-source", 30);
    f.store.updateChannelWorkflow(workflow.id, { metadata: { sourceTurnId: source.turnId,
      sourceMessageId: conflicting.item.id } }, now);
    assert.equal(metrics(f, owner).totalTokens, 11, "ambiguous workflow attribution is excluded");
    assert.equal(metrics(f, executionTopic).totalTokens, null);
    assert.equal(metrics(f, f.thread).totalTokens, null);
  });
}

test("missing, cyclic and cross-scope topic parents never fall back to legacy channel metrics", async t => {
  const f = await fixture(t, { surface: "channel" });
  const owner = session(f, "Owner");
  const source = measuredRun(f, owner, "owner-run", 10);
  const child = topic(f, source, "Child");
  const childSource = measuredRun(f, child, "child-run", 20);
  const nested = topic(f, childSource, "Nested");
  measuredRun(f, nested, "nested-run", 30);
  const otherChannel = f.store.createChannel({ name: "Other" }, now);
  const foreign = f.store.createChannelSession({ channelId: otherChannel.id, title: "Foreign" }, now).session;
  const setParent = parent => f.db.prepare("UPDATE ling_threads SET parent_thread_id=? WHERE id=?").run(parent, child.id);
  for (const parent of [null, nested.id, foreign.id]) {
    setParent(parent);
    assert.equal(metrics(f, owner).totalTokens, 11);
    assert.equal(metrics(f, f.store.getLingThread(child.id)).totalTokens, null);
    assert.equal(metrics(f, f.thread).totalTokens, null);
  }
  setParent(owner.id);
  f.db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('metrics-foreign','Foreign',?,?)").run(now, now);
  f.db.prepare("UPDATE ling_threads SET workspace_id='metrics-foreign' WHERE id=?").run(owner.id);
  assert.equal(metrics(f, f.store.getLingThread(child.id)).totalTokens, null);
  assert.equal(metrics(f, f.thread).totalTokens, null);
});

test("task-only workflow lineage follows the durable Step and fails closed on a missing or foreign source", async t => {
  const f = await fixture(t, { surface: "channel" });
  const owner = session(f, "Task workflow owner");
  const source = measuredRun(f, owner, "task-workflow-source", 10);
  const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Task workflow", objective: "Work",
    createdBy: "test", metadata: { sourceTurnId: source.turnId } }, now);
  const task = f.store.createTask({ channelId: f.channel.id, title: "Task", prompt: "Work" }, now);
  const step = f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Step", prompt: "Work",
    toParticipantId: "ling_agent", toParticipantLabel: "Ling" }, now);
  f.store.updateChannelWorkflowStep(step.id, { taskId: task.id }, now);
  const execution = f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id,
    taskId: task.id, title: "Task-only execution", objective: "Work" }, now);
  const executionSource = measuredRun(f, execution, "task-only-run", 200, { workflowStepId: step.id });
  const child = topic(f, executionSource, "Task execution topic");
  measuredRun(f, child, "task-execution-topic-run", 20);
  assert.equal(metrics(f, owner).totalTokens, 32);
  assert.equal(metrics(f, child).totalTokens, 32);
  assert.equal(metrics(f, f.thread).totalTokens, null);
  f.store.updateChannelWorkflow(workflow.id, { metadata: { sourceTurnId: "missing-source" } }, now);
  assert.equal(metrics(f, owner).totalTokens, 11);
  assert.equal(metrics(f, child).totalTokens, null);
  assert.equal(metrics(f, f.thread).totalTokens, null);
  const otherChannel = f.store.createChannel({ name: "Foreign workflow source" }, now);
  const foreign = f.store.createChannelSession({ channelId: otherChannel.id, title: "Foreign" }, now).session;
  const foreignTurn = f.store.appendConversationUserTurn({ threadId: foreign.id, channelId: otherChannel.id,
    title: "Foreign", userInstruction: "Foreign", idempotencyKey: "foreign-workflow-turn", payload: payload("Foreign") }, now);
  f.store.updateChannelWorkflow(workflow.id, { metadata: { sourceTurnId: foreignTurn.turnId } }, now);
  assert.equal(metrics(f, owner).totalTokens, 11);
  assert.equal(metrics(f, child).totalTokens, null);
  assert.equal(metrics(f, f.thread).totalTokens, null);
});

test("selected session outside the newest 500 threads keeps its own measured evidence and partial coverage", async t => {
  const f = await fixture(t, { surface: "channel" });
  const selected = session(f, "Older selected session");
  measuredRun(f, selected, "selected-old-run", 12);
  for (let i = 0; i < 501; i++) f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id,
    title: `Newer ${i}`, objective: "Bounded enumeration" }, "2026-09-08T00:00:00.000Z");
  assert.equal(f.store.listLingThreads({ kind: "channel_discussion", channelId: f.channel.id, limit: 500 })
    .some(thread => thread.id === selected.id), false);
  const actual = metrics(f, selected);
  assert.equal(actual.totalTokens, 13);
  assert.equal(actual.context.measuredInputTokens, 12);
  assert.equal(actual.coverage, "partial", "scope filtering must retain the original enumeration truncation signal");
});
