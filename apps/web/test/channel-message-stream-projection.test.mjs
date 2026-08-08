import assert from "node:assert/strict";
import test from "node:test";
import {
  projectChannelStreamReady,
  projectChannelStreamTerminal,
} from "../src/app/channel-message-stream-projection.ts";

const sourceMessage = message("message_guidance", "message", "local-user");
const existingMessage = message("message_existing", "message", "local-user");

test("bare channel stream acceptance stays optimistic until dispatch is known", () => {
  assert.deepEqual(projectChannelStreamReady([existingMessage], { message: sourceMessage }), [existingMessage]);
});

test("queued channel guidance is removed from the transcript projection", () => {
  const projected = projectChannelStreamTerminal([existingMessage, sourceMessage], {
    message: sourceMessage,
    replyDispatch: {
      targetTeammateId: "teammate_designer",
      disposition: "followup_queued",
      sourceRunId: "run_active",
    },
  });
  assert.deepEqual(projected, [existingMessage]);
});

test("a normal reply commits the source message and reply together", () => {
  const reply = message("message_reply", "ai_reply", "ai-teammate");
  assert.deepEqual(projectChannelStreamTerminal([existingMessage], {
    message: sourceMessage,
    aiReply: reply,
  }), [existingMessage, sourceMessage, reply]);
});

function message(id, kind, authorType) {
  return {
    id,
    workspaceId: "workspace_default",
    channelId: "channel_main",
    kind,
    intent: "discuss",
    authorType,
    body: id,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}
