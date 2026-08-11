import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "../../core/dist/index.js";
import {
  findActiveChannelReplyRun,
  queueChannelReplyFollowup,
  resolveChannelReplyTargetTeammateId,
} from "../dist/features/channels/channel-reply-dispatch.js";

test("channel reply target defaults to Ling and multiple mentions return to Ling", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-channel-reply-target-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Targets", boundPath: cwd }, "2026-08-06T00:00:00.000Z");
    const message = createMessage(store, channel.id, []);
    assert.equal(resolveChannelReplyTargetTeammateId({ store, sourceMessage: message }), "ling_agent");
    assert.equal(resolveChannelReplyTargetTeammateId({
      store,
      sourceMessage: { ...message, mentions: [mention("teammate_engineer"), mention("teammate_docs")] },
      requestedTeammateId: "teammate_engineer",
    }), "ling_agent");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("active channel replies are scoped to their conversation line", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-channel-reply-queue-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Reply lanes", boundPath: cwd }, "2026-08-06T00:00:00.000Z");
    const unrelatedRun = store.createRun({
      id: "run_unrelated_channel_work",
      cwd,
      taskId: "task_unrelated_channel_work",
      channelId: channel.id,
      teammateId: "teammate_docs",
      providerName: "test",
      providerModel: "test",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: "2026-08-06T00:00:00.100Z",
    });
    store.markRunStarted(unrelatedRun.id, "2026-08-06T00:00:00.200Z");
    const { run: engineerRun, sourceMessage: engineerSource } = createActiveReplyRun(store, channel.id, "teammate_engineer", "engineer");

    assert.equal(findActiveChannelReplyRun({ store, channelId: channel.id, sourceMessage: engineerSource })?.id, engineerRun.id);
    assert.equal(findActiveChannelReplyRun({ store, channelId: channel.id, sourceMessage: engineerSource, activeRunId: engineerRun.id })?.id, engineerRun.id);
    const rootThread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: channel.id,
      title: "Reply lanes",
      objective: "Verify active reply scoping",
    }, "2026-08-06T00:00:05.000Z").thread;
    const rootMessage = createMessage(store, channel.id, [], {
      body: "Open an independent branch",
    });
    const rootItem = store.getConversationItem(rootMessage.id);
    assert.ok(rootItem?.turnId);
    const rootAssignment = store.getEffectiveTurnContextAssignment(rootItem.turnId);
    assert.ok(rootAssignment);
    const branchThread = store.resolveOrCreateConversationThread({
      id: "thread_branch",
      surfaceKind: "branch",
      channelId: channel.id,
      parentThreadId: rootThread.id,
      parentTurnId: rootItem.turnId,
      title: "Independent branch",
      objective: "Verify active reply scoping",
      forkContextSnapshot: {
        id: "snapshot_thread_branch",
        segmentId: rootAssignment.segmentId,
        projectionVersion: "ctxv2_thread_branch",
        throughItemSequence: rootItem.sequence,
        summaryIds: [],
        sourceRefs: [{ type: "conversation_item", id: rootItem.id }],
        policyVersion: "continuity-v2-snapshot-v1",
      },
    }, "2026-08-06T00:00:07.000Z").thread;
    const branchMessage = createMessage(store, channel.id, [], { threadId: branchThread.id });
    assert.equal(findActiveChannelReplyRun({ store, channelId: channel.id, sourceMessage: branchMessage }), undefined);
    assert.equal(findActiveChannelReplyRun({ store, channelId: channel.id, sourceMessage: branchMessage, activeRunId: engineerRun.id }), undefined);

    const sourceMessage = createMessage(store, channel.id, [mention("teammate_designer")], {
      body: "完成后补充错误处理",
    });
    const dispatch = queueChannelReplyFollowup({
      store,
      activeRun: engineerRun,
      sourceMessage,
      targetTeammateId: "teammate_designer",
      turnEnvelope: {
        sourceMessageId: sourceMessage.id,
        channelId: channel.id,
        authorType: "local-user",
        body: sourceMessage.body,
        mentions: sourceMessage.mentions,
        attachments: [],
        linkPreviews: [],
        fileRefs: [],
      },
    });

    assert.equal(dispatch.targetTeammateId, "teammate_designer");
    assert.equal(dispatch.disposition, "followup_queued");
    assert.equal(dispatch.sourceRunId, engineerRun.id);
    assert.equal(dispatch.intervention?.messagePayload?.body, sourceMessage.body);
    assert.equal(dispatch.intervention?.messagePayload?.targetTeammateId, "teammate_designer");
    assert.deepEqual(dispatch.intervention?.messagePayload?.attachmentIds, []);
    assert.deepEqual(store.listRunInterventions({ sourceRunId: engineerRun.id }).map((item) => item.id), [dispatch.intervention?.id]);
    assert.deepEqual(store.listEvents(engineerRun.id).map((event) => event.type), ["run_intervention_created", "run_followup_queued"]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function createActiveReplyRun(store, channelId, teammateId, suffix) {
  const sourceMessage = createMessage(store, channelId, [], {
    body: `source ${suffix}`,
  });
  const replyMessage = appendChannelItemFixture(store, {
    channelId,
    replyToItemId: sourceMessage.id,
    kind: "ai_reply",
    authorType: "ai-teammate",
    authorId: teammateId,
    body: "",
    status: "pending",
  }, `2026-08-06T00:00:0${suffix.length}.000Z`);
  const workUnit = store.createWorkUnit({
    id: `wu_${suffix}`,
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: sourceMessage.id,
    channelId,
    teammateId,
    idempotencyKey: `reply-${suffix}`,
    createdByActor: "local-user",
    request: { sourceMessageId: sourceMessage.id },
    linkedMessageId: replyMessage.id,
    now: `2026-08-06T00:00:1${suffix.length}.000Z`,
  });
  const run = store.createRun({
    id: `run_${suffix}`,
    cwd: store.paths.cwd,
    taskId: `task_${suffix}`,
    channelId,
    teammateId,
    providerName: "test",
    providerModel: "test",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: { sourceMessageId: sourceMessage.id },
    workUnitId: workUnit.id,
    createdAt: `2026-08-06T00:00:2${suffix.length}.000Z`,
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, `2026-08-06T00:00:3${suffix.length}.000Z`);
  store.markRunStarted(run.id, `2026-08-06T00:00:4${suffix.length}.000Z`);
  return { run: store.getRun(run.id), sourceMessage };
}

function createMessage(store, channelId, mentions, overrides = {}) {
  return appendChannelItemFixture(store, {
    channelId,
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    body: "hello",
    mentions,
    ...overrides,
  }, "2026-08-06T00:01:00.000Z");
}

function mention(id) {
  return { id, label: id, kind: "ai-teammate" };
}
