import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteConversationMessageV1 } from "@ling-stack/contracts";
import { adaptRemoteConversationMessage } from "../src/features/conversations/domain/MobileConversationAdapter.ts";

test("Mobile only makes settled assistant or teammate visualization references actionable", () => {
  const artifactId = "viz_" + "a".repeat(32);
  const body = "Before\n\n[Mockup](#ling-visualization-v1-" + artifactId + ")\n\nAfter";
  const message: RemoteConversationMessageV1 = {
    messageId: "message", workspaceId: "workspace", conversationId: "session",
    role: "assistant", authorLabel: "Ling", body, status: "ready", revision: 1, activitySeq: 1,
    createdAt: "2026-11-25T00:00:00.000Z", updatedAt: "2026-11-25T00:00:00.000Z",
  };
  assert.deepEqual(adaptRemoteConversationMessage("conversation", message).blocks.map(block => block.kind),
    ["paragraph", "visualization", "paragraph"]);
  assert.ok(adaptRemoteConversationMessage("conversation", { ...message, role: "local_user" }).blocks.every(block => block.kind !== "visualization"));
  assert.ok(adaptRemoteConversationMessage("conversation", { ...message, status: "streaming" }).blocks.every(block => block.kind !== "visualization"));
});
