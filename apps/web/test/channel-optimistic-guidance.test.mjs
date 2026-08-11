import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmOptimisticChannelGuidance,
  projectOptimisticChannelGuidanceItems,
  pruneVisibleOptimisticChannelGuidance,
  removeOptimisticChannelGuidance,
} from "../src/features/workspace/channel-optimistic-guidance.ts";

const localGuidance = {
  channelId: "channel_1",
  item: {
    id: "local_1",
    instruction: "Queue this second message",
    attachments: [],
    linkPreviews: [],
    fileRefs: [],
    statusLabel: "Sending...",
    meta: "Ling Agent",
  },
};

const intervention = {
  id: "intervention_1",
  workspaceId: "workspace_default",
  sourceRunId: "run_1",
  mode: "queue_followup",
  status: "queued",
  instruction: localGuidance.item.instruction,
  messagePayload: {
    sourceMessageId: "message_2",
    targetTeammateId: "ling_agent",
    body: localGuidance.item.instruction,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
  },
  requestedBy: "local-user",
  idempotencyKey: "channel_message:message_2:queue_followup",
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

test("confirmed optimistic guidance bridges a torn authoritative refresh without disappearing", () => {
  const confirmed = confirmOptimisticChannelGuidance(
    [localGuidance],
    localGuidance.item.id,
    intervention,
    "Queued",
  );

  assert.equal(confirmed[0].item.id, intervention.id);
  assert.equal(confirmed[0].sourceMessageId, "message_2");
  assert.equal(removeOptimisticChannelGuidance(confirmed, localGuidance.item.id).length, 1);
  assert.deepEqual(projectOptimisticChannelGuidanceItems({
    current: confirmed,
    channelId: "channel_1",
    sourceRunId: "run_1",
    authoritativeInterventionIds: new Set(),
    visibleMessageIds: new Set(),
  }).map((item) => item.id), [intervention.id]);
});

test("authoritative guidance deduplicates the bridge and visible source messages retire it", () => {
  const confirmed = confirmOptimisticChannelGuidance(
    [localGuidance],
    localGuidance.item.id,
    intervention,
    "Queued",
  );

  assert.deepEqual(projectOptimisticChannelGuidanceItems({
    current: confirmed,
    channelId: "channel_1",
    sourceRunId: "run_1",
    authoritativeInterventionIds: new Set([intervention.id]),
    visibleMessageIds: new Set(),
  }), []);
  assert.deepEqual(pruneVisibleOptimisticChannelGuidance(
    confirmed,
    new Set(["message_2"]),
  ), []);
});
