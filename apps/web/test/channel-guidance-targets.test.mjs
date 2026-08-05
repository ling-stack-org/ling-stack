import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveChannelReplyGuidanceTargets,
  resolveChannelGuidanceRun,
} from "../src/features/workspace/channel-guidance-targets.ts";

test("one active channel reply run is selected automatically", () => {
  const replyRun = run("run_reply", "wu_reply", "teammate_designer");
  const targets = deriveChannelReplyGuidanceTargets({
    channelId: "channel_main",
    runs: [replyRun],
    workUnits: [workUnit("wu_reply", "channel_ai_reply")],
    teammateLabel: (teammateId) => teammateId === "teammate_designer" ? "Designer" : "AI teammate",
  });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].label, "Designer");
  assert.equal(resolveChannelGuidanceRun({ replyTargets: targets, selectedReplyRunId: "" }), replyRun);
});

test("multiple channel reply runs require an explicit target", () => {
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

  assert.equal(resolveChannelGuidanceRun({ replyTargets: targets, selectedReplyRunId: "" }), undefined);
  assert.equal(resolveChannelGuidanceRun({ replyTargets: targets, selectedReplyRunId: engineer.id }), engineer);
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
  assert.equal(resolveChannelGuidanceRun({ replyTargets: targets, selectedReplyRunId: "", fallbackRun }), fallbackRun);
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
