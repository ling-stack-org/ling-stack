import assert from "node:assert/strict";
import test from "node:test";
import { projectConversationItemToChannelMessage } from "../dist/index.js";

test("canonical conversation items project to browser-safe Channel presentation views", () => {
  const user = projectConversationItemToChannelMessage({
    schemaVersion: 1,
    id: "item_user",
    workspaceId: "workspace_default",
    channelId: "channel_1",
    threadId: "thread_1",
    turnId: "turn_1",
    sequence: 1,
    kind: "user_message",
    status: "committed",
    actorType: "local_user",
    actorId: "local-user",
    visibility: "channel",
    payload: {
      body: "Ask Engineer",
      format: "plain_text",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai_teammate" }],
      attachmentIds: ["attachment_1"],
      linkPreviewIds: [],
      fileRefs: [{ path: "README.md", source: "composer" }],
    },
    domainRefs: [{ type: "task", id: "task_1" }],
    revision: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    committedAt: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(user.kind, "message");
  assert.equal(user.authorType, "local-user");
  assert.equal(user.intent, "task");
  assert.deepEqual(user.mentions, [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }]);
  assert.deepEqual(user.fileRefs, [{ path: "README.md", source: "composer" }]);

  const assistant = projectConversationItemToChannelMessage({
    schemaVersion: 1,
    id: "item_reply",
    workspaceId: "workspace_default",
    channelId: "channel_1",
    threadId: "thread_1",
    turnId: "turn_1",
    sequence: 2,
    kind: "assistant_message",
    status: "committed",
    actorType: "ling_agent",
    actorId: "ling_agent",
    visibility: "channel",
    payload: {
      body: "Need a target.",
      format: "markdown",
      streaming: false,
      deliveryStatus: "blocked",
      errorMessage: "target missing",
    },
    domainRefs: [{ type: "run", id: "run_1" }],
    revision: 2,
    createdAt: "2026-08-10T00:00:01.000Z",
    updatedAt: "2026-08-10T00:00:02.000Z",
    committedAt: "2026-08-10T00:00:02.000Z",
  });
  assert.equal(assistant.kind, "ai_reply");
  assert.equal(assistant.authorType, "ai-teammate");
  assert.equal(assistant.status, "blocked");
  assert.equal(assistant.linkedRunId, "run_1");
  assert.equal(assistant.errorMessage, "target missing");
});
