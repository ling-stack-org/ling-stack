import test from "node:test";
import assert from "node:assert/strict";
import {
  channelConversationScopeKey,
  channelStreamErrorOwner,
  channelTopicScopeKey,
  shouldReportConversationStreamError,
} from "../src/shared/conversation/stream-error-ownership.ts";

test("channel stream errors have one explicit owner", () => {
  assert.equal(channelStreamErrorOwner({ hasAssistantReply: true, fallbackOwner: "channel-composer" }), "assistant-reply");
  assert.equal(channelStreamErrorOwner({ hasAssistantReply: true, fallbackOwner: "topic-thread" }), "assistant-reply");
  assert.equal(channelStreamErrorOwner({ hasAssistantReply: false, fallbackOwner: "channel-composer" }), "channel-composer");
  assert.equal(channelStreamErrorOwner({ hasAssistantReply: false, fallbackOwner: "topic-thread" }), "topic-thread");
});

test("channel feedback scopes distinguish workspace, branch and topic owners", () => {
  const root = channelConversationScopeKey({ workspaceCwd: " /workspace-a ", channelId: "engineering" });
  const branch = channelConversationScopeKey({ workspaceCwd: "/workspace-a", channelId: "engineering", branchRootThreadId: "branch-1" });
  const otherWorkspace = channelConversationScopeKey({ workspaceCwd: "/workspace-b", channelId: "engineering" });
  const topic = channelTopicScopeKey({ workspaceCwd: "/workspace-a", channelId: "engineering", topicThreadId: "topic-1" });
  assert.notEqual(root, branch);
  assert.notEqual(root, otherWorkspace);
  assert.notEqual(root, topic);
  assert.equal(root, channelConversationScopeKey({ workspaceCwd: "/workspace-a", channelId: "engineering", branchRootThreadId: "root" }));
});

test("normal/private legacy predicate still reports only unanchored stream failures", () => {
  assert.equal(shouldReportConversationStreamError({ error: "transport", hasAssistantReply: false }), true);
  assert.equal(shouldReportConversationStreamError({ error: "provider", hasAssistantReply: true }), false);
  assert.equal(shouldReportConversationStreamError({ error: "", hasAssistantReply: false }), false);
});
