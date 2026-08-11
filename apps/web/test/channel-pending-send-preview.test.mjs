import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgePendingChannelSendPreview,
  projectPendingChannelReply,
} from "../src/features/workspace/channel-pending-send-preview.ts";
import { derivePendingChannelSendState } from "../src/features/workspace/useChannelMessageFeedAssembly.ts";

const preview = {
  id: "pending_local_1",
  channelId: "channel_engineering",
  body: "Continue with the current reply.",
  mentions: [],
  attachmentIds: [],
  linkPreviewIds: [],
  fileRefs: [],
  requestAiReply: true,
  autoReplyMode: "mentions_only",
  createdAt: "2026-08-07T00:00:00.000Z",
};

test("accepted channel sends retain their pending reply projection until dispatch takes over", () => {
  const accepted = acknowledgePendingChannelSendPreview(preview, preview.id, "message_accepted_1");
  assert.deepEqual(accepted, { ...preview, sourceMessageId: "message_accepted_1" });

  const pending = projectPendingChannelReply(accepted, preview.id, {
    sourceMessageId: "message_accepted_1",
    targetTeammateId: "ling_agent",
    startedAt: "2026-08-07T00:00:00.100Z",
  });
  assert.deepEqual(pending, {
    ...preview,
    sourceMessageId: "message_accepted_1",
    targetTeammateId: "ling_agent",
  });
});

test("stale channel reply events cannot replace a newer pending send", () => {
  assert.equal(acknowledgePendingChannelSendPreview(preview, "pending_old", "message_old"), preview);
  assert.equal(projectPendingChannelReply(
    { ...preview, sourceMessageId: "message_current" },
    preview.id,
    {
      sourceMessageId: "message_old",
      targetTeammateId: "ling_agent",
      startedAt: "2026-08-07T00:00:00.100Z",
    },
  ).sourceMessageId, "message_current");
});

test("canonical root acknowledgement matches a root preview without overloading threadId", () => {
  const source = channelMessage({
    id: "item_user",
    turnId: "turn_user",
    threadId: "thread_root",
    threadSurfaceKind: "channel_root",
    kind: "message",
    authorType: "local-user",
    body: preview.body,
  });
  const unrelatedReply = channelMessage({
    id: "item_other_reply",
    turnId: "turn_other",
    threadId: "thread_root",
    threadSurfaceKind: "channel_root",
    kind: "ai_reply",
    authorType: "ai-teammate",
    body: "Unrelated reply",
  });
  assert.deepEqual(derivePendingChannelSendState([source, unrelatedReply], preview), {
    acknowledged: true,
    acknowledgedMessageId: source.id,
    aiReplyStarted: false,
  });
});

function channelMessage(overrides) {
  return {
    workspaceId: "workspace_default",
    channelId: preview.channelId,
    intent: "discuss",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}
