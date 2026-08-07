import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveChannelReplyGuidanceTargets,
  filterQueuedChannelGuidanceInterventions,
  resolveChannelMessageTargetTeammateId,
  resolveChannelGuidanceTarget,
} from "../src/features/workspace/channel-guidance-targets.ts";

const teammateLabel = (teammateId) => teammateId ?? "AI teammate";

test("an active channel reply occupies the channel regardless of the next message target", () => {
  const replyRun = run("run_reply", "wu_reply", "teammate_designer");
  const targets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    runs: [replyRun],
    workUnits: [workUnit("wu_reply", "channel_ai_reply")],
    teammateLabel: (teammateId) => teammateId === "teammate_designer" ? "Designer" : "AI teammate",
  });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].label, "Designer");
  const target = resolveChannelGuidanceTarget({
    replyTargets: targets,
    teammateLabel,
  });
  assert.equal(target?.run, replyRun);
  assert.equal(target?.activeReply.runId, replyRun.id);
  assert.equal(target?.activeReply.workUnitId, replyRun.workUnitId);
});

test("legacy overlapping channel reply runs resolve to the oldest channel lane", () => {
  const designer = run("run_designer", "wu_designer", "teammate_designer");
  const engineer = run("run_engineer", "wu_engineer", "teammate_engineer");
  const targets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    runs: [designer, engineer],
    workUnits: [
      workUnit("wu_designer", "channel_ai_reply"),
      workUnit("wu_engineer", "channel_ai_reply"),
    ],
    teammateLabel: (teammateId) => teammateId ?? "AI teammate",
  });

  assert.equal(resolveChannelGuidanceTarget({
    replyTargets: targets,
    teammateLabel,
  })?.run, designer);
});

test("task and terminal reply runs do not become ordinary reply targets", () => {
  const terminalReply = { ...run("run_done", "wu_done", "teammate_designer"), status: "succeeded" };
  const taskRun = run("run_task", "wu_task", "teammate_engineer");
  const fallbackRun = run("run_fallback", "wu_fallback", "teammate_product");
  const targets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    runs: [terminalReply, taskRun],
    workUnits: [
      workUnit("wu_done", "channel_ai_reply"),
      workUnit("wu_task", "task_run"),
    ],
    teammateLabel: (teammateId) => teammateId ?? "AI teammate",
  });

  assert.deepEqual(targets, []);
  assert.equal(resolveChannelGuidanceTarget({
    replyTargets: targets,
    fallbackRun,
    teammateLabel,
  })?.run, fallbackRun);
});

test("message targeting is derived only from mentions", () => {
  const engineerMention = { id: "teammate_engineer", label: "Engineer", kind: "ai-teammate" };
  const docsMention = { id: "teammate_docs", label: "Docs", kind: "ai-teammate" };
  assert.equal(resolveChannelMessageTargetTeammateId({ mentions: [] }), "ling_agent");
  assert.equal(resolveChannelMessageTargetTeammateId({ mentions: [engineerMention] }), "teammate_engineer");
  assert.equal(resolveChannelMessageTargetTeammateId({ mentions: [engineerMention, docsMention] }), "ling_agent");
});

test("transient linked replies bridge runtime refresh and authoritative runs replace them by run id", () => {
  const transientReply = activeReply("run_reply", "wu_reply", "teammate_designer", "queued");
  const beforeRefresh = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    runs: [],
    workUnits: [],
    transientReplies: [transientReply],
    teammateLabel,
  });

  assert.equal(beforeRefresh.length, 1);
  assert.equal(beforeRefresh[0].run, undefined);
  assert.equal(beforeRefresh[0].activeReply, transientReply);

  const authoritativeRun = run("run_reply", "wu_reply", "teammate_designer");
  const afterRefresh = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
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

function run(id, workUnitId, teammateId) {
  return {
    id,
    status: "running",
    cwd: "/tmp/ling",
    taskId: `task_${id}`,
    channelId: "channel_main",
    teammateId,
    providerName: "OpenAI",
    providerModel: "gpt-test",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `/tmp/${id}.jsonl`,
    workUnitId,
    createdAt: `2026-08-05T00:00:0${id.length % 10}.000Z`,
    updatedAt: "2026-08-05T00:00:10.000Z",
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

function activeReply(runId, workUnitId, teammateId, status) {
  return {
    runId,
    sourceRunId: runId,
    workUnitId,
    channelId: "channel_main",
    teammateId,
    status,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
  };
}
