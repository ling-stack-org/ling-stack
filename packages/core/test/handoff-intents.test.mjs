import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeChannelHandoffToLingIntent,
  normalizeLingHandoffIntents,
  normalizeWorkflowHandoffIntentToLingIntent,
} from "../dist/index.js";

test("normalizes channel handoffs into shared Ling handoff intents", () => {
  const handoff = {
    id: "handoff_channel",
    workspaceId: "workspace_default",
    channelId: "channel_1",
    sourceMessageId: "message_1",
    sourceTaskId: "task_1",
    sourceRunId: "run_1",
    fromParticipantId: "local-user",
    fromParticipantLabel: "Tian",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    reason: "Needs implementation.",
    requiredInput: "Design notes and constraints.",
    expectedOutput: "Patch and tests.",
    status: "accepted",
    createdBy: "local-user",
    createdAt: "2026-06-19T02:00:00.000Z",
    updatedAt: "2026-06-19T02:01:00.000Z",
  };

  const normalized = normalizeChannelHandoffToLingIntent(handoff);

  assert.equal(normalized.id, "channel_handoff:handoff_channel");
  assert.equal(normalized.sourceKind, "channel_handoff");
  assert.equal(normalized.channelHandoffId, "handoff_channel");
  assert.deepEqual(normalized.from, { id: "local-user", label: "Tian" });
  assert.deepEqual(normalized.to, { id: "engineer", label: "Engineer" });
  assert.deepEqual(normalized.sourceRefs, [
    { type: "channel_message", id: "message_1", label: "source message" },
    { type: "task", id: "task_1", label: "source task" },
    { type: "run", id: "run_1", label: "source run" },
  ]);
  assert.deepEqual(normalized.inputPacket, {
    schemaVersion: 1,
    intentId: "channel_handoff:handoff_channel",
    sourceKind: "channel_handoff",
    channelId: "channel_1",
    sourceRunId: "run_1",
    sourceMessageId: "message_1",
    channelHandoffId: "handoff_channel",
    requiredInput: "Design notes and constraints.",
    expectedOutput: "Patch and tests.",
    sourceRefs: normalized.sourceRefs,
  });
});

test("normalizes workflow handoff intents and preserves explicit source refs", () => {
  const intent = {
    schemaVersion: 1,
    id: "wf_handoff_intent_1",
    workspaceId: "workspace_default",
    channelId: "channel_1",
    workflowId: "workflow_1",
    sourceWorkflowStepId: "step_1",
    sourceRunId: "run_1",
    sourceMessageId: "message_1",
    channelHandoffId: "handoff_1",
    fromParticipantId: "orchestrator",
    fromParticipantLabel: "Workflow",
    toParticipantId: "reviewer",
    reason: "Needs review.",
    requiredInput: "Implementation summary.",
    expectedOutput: "Review decision.",
    riskSummary: "May block release.",
    sourceRefs: [
      { type: "channel_message", id: "message_1", label: "custom label" },
      { type: "artifact", id: "artifact_1", label: "implementation summary" },
    ],
    status: "validated",
    validation: {
      targetTeammateExists: true,
      targetTeammateActive: true,
      skillExecutable: true,
      providerRunnable: true,
      approvalProfileCompatible: true,
      resourceLeaseAvailable: true,
      blockers: [],
    },
    createdBy: "orchestrator",
    createdAt: "2026-06-19T02:00:00.000Z",
    updatedAt: "2026-06-19T02:02:00.000Z",
  };

  const normalized = normalizeWorkflowHandoffIntentToLingIntent(intent);

  assert.equal(normalized.id, "workflow_handoff_intent:wf_handoff_intent_1");
  assert.equal(normalized.sourceKind, "workflow_handoff_intent");
  assert.deepEqual(normalized.to, { id: "reviewer", label: "reviewer" });
  assert.deepEqual(normalized.sourceRefs, [
    { type: "channel_message", id: "message_1", label: "custom label" },
    { type: "artifact", id: "artifact_1", label: "implementation summary" },
    { type: "run", id: "run_1", label: "source run" },
    { type: "workflow", id: "workflow_1", label: "workflow" },
    { type: "workflow_step", id: "step_1", label: "source workflow step" },
  ]);
  assert.equal(normalized.inputPacket.workflowId, "workflow_1");
  assert.equal(normalized.inputPacket.sourceWorkflowStepId, "step_1");
  assert.equal(normalized.validation.targetTeammateExists, true);
});

test("normalizes mixed handoff intents in newest-first order", () => {
  const channel = normalizeChannelHandoffToLingIntent({
    id: "handoff_old",
    workspaceId: "workspace_default",
    channelId: "channel_1",
    fromParticipantId: "local-user",
    fromParticipantLabel: "Tian",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    reason: "Older handoff.",
    requiredInput: "Plan.",
    expectedOutput: "Patch.",
    status: "proposed",
    createdBy: "local-user",
    createdAt: "2026-06-19T02:00:00.000Z",
    updatedAt: "2026-06-19T02:00:00.000Z",
  });
  const workflow = {
    schemaVersion: 1,
    id: "wf_handoff_intent_new",
    workspaceId: "workspace_default",
    channelId: "channel_1",
    fromParticipantId: "workflow",
    fromParticipantLabel: "Workflow",
    toParticipantId: "reviewer",
    toParticipantLabel: "Reviewer",
    reason: "Newer intent.",
    requiredInput: "Patch.",
    expectedOutput: "Review.",
    sourceRefs: [],
    status: "proposed",
    createdBy: "orchestrator",
    createdAt: "2026-06-19T02:00:00.000Z",
    updatedAt: "2026-06-19T02:05:00.000Z",
  };

  assert.deepEqual(
    normalizeLingHandoffIntents({
      channelHandoffs: [{
        id: "handoff_old",
        workspaceId: "workspace_default",
        channelId: "channel_1",
        fromParticipantId: "local-user",
        fromParticipantLabel: "Tian",
        toParticipantId: "engineer",
        toParticipantLabel: "Engineer",
        reason: "Older handoff.",
        requiredInput: "Plan.",
        expectedOutput: "Patch.",
        status: "proposed",
        createdBy: "local-user",
        createdAt: "2026-06-19T02:00:00.000Z",
        updatedAt: "2026-06-19T02:00:00.000Z",
      }],
      workflowHandoffIntents: [workflow],
    }).map((item) => item.id),
    ["workflow_handoff_intent:wf_handoff_intent_new", channel.id],
  );
});
