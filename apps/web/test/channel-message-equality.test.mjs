import assert from "node:assert/strict";
import test from "node:test";
import { channelMessagesEqual } from "../src/lib/channel-message-equality.ts";

const baseMessage = {
  id: "message-1",
  workspaceId: "workspace-1",
  channelId: "channel-1",
  kind: "ai_reply",
  intent: "discuss",
  authorType: "ai-teammate",
  authorId: "ling_agent",
  body: "Pending response",
  mentions: [],
  attachmentIds: [],
  linkPreviewIds: [],
  fileRefs: [],
  status: "pending",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
};

test("channel message equality detects decoration-only changes", () => {
  const current = [baseMessage];
  const next = [{
    ...baseMessage,
    linkedRunId: "run-1",
    pendingReplacement: {
      idempotencyKey: "replace-1",
      replacementBody: "Updated response",
    },
  }];

  assert.equal(channelMessagesEqual(current, current), true);
  assert.equal(channelMessagesEqual(current, next), false);
});
