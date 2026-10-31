import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveChannelReplyGuidanceTargets,
  filterQueuedChannelGuidanceInterventions,
  resolveChannelMessageTargetTeammateId,
  resolveChannelGuidanceTarget,
} from "../src/features/workspace/channel-guidance-targets.ts";

const teammateLabel = (teammateId) => teammateId ?? "AI teammate";

test("an active channel reply only occupies its conversation thread", () => {
  const replyRun = run("run_reply", "wu_reply", "teammate_designer", "ling_thread_root", "message_root");
  const branchRun = run("run_branch", "wu_branch", "teammate_engineer", "ling_thread_branch", "message_branch");
  const targets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    channelMessages: [message("message_root"), message("message_branch", "branch_root")],
    runs: [replyRun, branchRun],
    workUnits: [
      workUnit("wu_reply", "channel_ai_reply"),
      workUnit("wu_branch", "channel_ai_reply"),
    ],
    teammateLabel: (teammateId) => teammateId === "teammate_designer" ? "Designer" : "AI teammate",
  });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].label, "Designer");
  const target = resolveChannelGuidanceTarget({
    replyTargets: targets,
  });
  assert.equal(target?.run, replyRun);
  assert.equal(target?.activeReply.runId, replyRun.id);
  assert.equal(target?.activeReply.workUnitId, replyRun.workUnitId);
});

test("legacy overlapping channel reply runs resolve to the oldest channel lane", () => {
  const designer = run("run_designer", "wu_designer", "teammate_designer", "ling_thread_root", "message_designer");
  const engineer = run("run_engineer", "wu_engineer", "teammate_engineer", "ling_thread_root", "message_engineer");
  const targets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    channelMessages: [message("message_designer"), message("message_engineer")],
    runs: [designer, engineer],
    workUnits: [
      workUnit("wu_designer", "channel_ai_reply"),
      workUnit("wu_engineer", "channel_ai_reply"),
    ],
    teammateLabel: (teammateId) => teammateId ?? "AI teammate",
  });

  assert.equal(resolveChannelGuidanceTarget({
    replyTargets: targets,
  })?.run, designer);
});

test("task and terminal reply runs do not become ordinary reply targets", () => {
  const terminalReply = { ...run("run_done", "wu_done", "teammate_designer", "ling_thread_root", "message_done"), status: "succeeded" };
  const taskRun = run("run_task", "wu_task", "teammate_engineer", "ling_thread_root", "message_task");
  const targets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    channelMessages: [message("message_done"), message("message_task")],
    runs: [terminalReply, taskRun],
    workUnits: [
      workUnit("wu_done", "channel_ai_reply"),
      workUnit("wu_task", "task_run"),
    ],
    teammateLabel: (teammateId) => teammateId ?? "AI teammate",
  });

  assert.deepEqual(targets, []);
  assert.equal(resolveChannelGuidanceTarget({ replyTargets: targets }), undefined);
});

test("canonical root and topic replies use explicit LingThread topology", () => {
  const rootRun = run("run_root", "wu_root", "teammate_designer", "ling_thread_root", "message_root");
  const topicRun = run("run_topic", "wu_topic", "teammate_engineer", "ling_thread_topic", "message_topic_reply");
  const messages = [
    { ...message("message_root", "ling_thread_root"), threadSurfaceKind: "channel_root" },
    { ...message("message_topic_root", "ling_thread_root"), threadSurfaceKind: "channel_root" },
    {
      ...message("message_topic_reply", "ling_thread_topic"),
      threadSurfaceKind: "topic",
      threadAnchorItemId: "message_topic_root",
    },
  ];

  const rootTargets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    channelMessages: messages,
    runs: [rootRun, topicRun],
    workUnits: [workUnit("wu_root", "channel_ai_reply"), workUnit("wu_topic", "channel_ai_reply")],
    teammateLabel,
  });
  const topicTargets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    conversationLineThreadId: "ling_thread_topic",
    channelMessages: messages,
    runs: [rootRun, topicRun],
    workUnits: [workUnit("wu_root", "channel_ai_reply"), workUnit("wu_topic", "channel_ai_reply")],
    teammateLabel,
  });

  assert.deepEqual(rootTargets.map((target) => target.activeReply.runId), [rootRun.id]);
  assert.deepEqual(topicTargets.map((target) => target.activeReply.runId), [topicRun.id]);
});

test("durable session run IDs locate a work-thread reply when its source message is outside the loaded page", () => {
  const own = run("own-run", "own-work", "teammate_designer", "separate-work-thread", "unloaded-source");
  const other = run("other-run", "other-work", "teammate_engineer", "other-work-thread", "other-unloaded-source");
  const targets = deriveChannelReplyGuidanceTargets({ channelId: "channel_main", conversationLineThreadId: "session-A",
    conversationRunIds: new Set(["own-run"]), channelMessages: [], runs: [own, other],
    workUnits: [workUnit("own-work", "channel_ai_reply"), workUnit("other-work", "channel_ai_reply")], teammateLabel });
  assert.deepEqual(targets.map(target => target.activeReply.runId), ["own-run"]);
  assert.equal(targets[0].activeReply.workUnitId, "own-work");
});

test("message targeting is derived only from mentions", () => {
  const engineerMention = { id: "teammate_engineer", label: "Engineer", kind: "ai-teammate" };
  const docsMention = { id: "teammate_docs", label: "Docs", kind: "ai-teammate" };
  assert.equal(resolveChannelMessageTargetTeammateId({ mentions: [] }), "ling_agent");
  assert.equal(resolveChannelMessageTargetTeammateId({ mentions: [engineerMention] }), "teammate_engineer");
  assert.equal(resolveChannelMessageTargetTeammateId({ mentions: [engineerMention, docsMention] }), "ling_agent");
});

test("transient linked replies bridge runtime refresh and authoritative runs replace them by run id", () => {
  const transientReply = activeReply("run_reply", "wu_reply", "teammate_designer", "queued", "ling_thread_root", "message_root");
  const beforeRefresh = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    channelMessages: [message("message_root")],
    runs: [],
    workUnits: [],
    transientReplies: [transientReply],
    teammateLabel,
  });

  assert.equal(beforeRefresh.length, 1);
  assert.equal(beforeRefresh[0].run, undefined);
  assert.equal(beforeRefresh[0].activeReply, transientReply);

  const authoritativeRun = run("run_reply", "wu_reply", "teammate_designer", "ling_thread_root", "message_root");
  const afterRefresh = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    channelMessages: [message("message_root")],
    runs: [authoritativeRun],
    workUnits: [workUnit("wu_reply", "channel_ai_reply")],
    transientReplies: [transientReply],
    teammateLabel,
  });

  assert.equal(afterRefresh.length, 1);
  assert.equal(afterRefresh[0].run, authoritativeRun);
  assert.equal(afterRefresh[0].activeReply.status, "running");
});

test("guidance leaves the queue as soon as its source message enters the transcript", () => {
  const queued = {
    id: "intervention_queued",
    status: "queued",
    messagePayload: { sourceMessageId: "message_queued" },
  };
  const started = {
    id: "intervention_started",
    status: "started",
    messagePayload: { sourceMessageId: "message_started" },
  };

  assert.deepEqual(
    filterQueuedChannelGuidanceInterventions(
      [queued, started],
      new Set(["message_started"]),
    ).map((intervention) => intervention.id),
    [queued.id],
  );
});

function run(id, workUnitId, teammateId, threadId, sourceMessageId) {
  return {
    id,
    status: "running",
    cwd: "/tmp/ling",
    taskId: `task_${id}`,
    channelId: "channel_main",
    threadId,
    teammateId,
    providerName: "OpenAI",
    providerModel: "gpt-test",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: { sourceMessageId },
    eventLogPath: `/tmp/${id}.jsonl`,
    workUnitId,
    createdAt: `2026-08-05T00:00:0${id.length % 10}.000Z`,
    updatedAt: "2026-08-05T00:00:10.000Z",
  };
}

function message(id, threadId) {
  return {
    id,
    channelId: "channel_main",
    threadId,
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    body: id,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

function workUnit(id, kind) {
  return {
    id,
    workspaceId: "workspace_default",
    kind,
    ownerType: "channel_message",
    ownerId: `message_${id}`,
    channelId: "channel_main",
    idempotencyKey: id,
    status: "running",
    priority: 0,
    attemptCount: 1,
    createdByActor: "system",
    request: {},
    timeoutPolicy: { timeoutMs: 60000, heartbeatTimeoutMs: 30000 },
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:10.000Z",
  };
}

function activeReply(runId, workUnitId, teammateId, status, threadId, sourceMessageId) {
  return {
    runId,
    sourceRunId: runId,
    workUnitId,
    channelId: "channel_main",
    threadId,
    sourceMessageId,
    teammateId,
    status,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
  };
}
