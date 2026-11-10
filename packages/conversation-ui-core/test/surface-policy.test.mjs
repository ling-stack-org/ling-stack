import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationActionAllowedByPolicy,
  findLatestEditableConversationMessage,
  getConversationInteractionPolicy,
  getTerminalReportProjectionPolicy,
  mergeConversationInteractionPolicy,
} from "../dist/index.js";

test("private chat policy blocks channel-only controls", () => {
  const policy = getConversationInteractionPolicy("teammate_direct");

  assert.equal(conversationActionAllowedByPolicy("copy", policy), true);
  assert.equal(conversationActionAllowedByPolicy("like", policy), true);
  assert.equal(conversationActionAllowedByPolicy("dislike", policy), true);
  assert.equal(conversationActionAllowedByPolicy("create_task", policy), true);
  assert.equal(conversationActionAllowedByPolicy("reply_topic", policy), false);
  assert.equal(conversationActionAllowedByPolicy("edit_latest", policy), true);
  assert.equal(conversationActionAllowedByPolicy("fork", policy), false);
  assert.equal(policy.allowToolExecution, true);
  assert.equal(policy.showTerminalReportParticipants, false);
  assert.equal(policy.allowMentions, false);
  assert.equal(policy.allowMultiAgent, false);
});

test("channel policies allow topic reply and teammate collaboration", () => {
  for (const surface of ["channel_root", "channel_branch"]) {
    const policy = getConversationInteractionPolicy(surface);

    assert.equal(conversationActionAllowedByPolicy("reply_topic", policy), true);
    assert.equal(conversationActionAllowedByPolicy("edit_latest", policy), true);
    assert.equal(conversationActionAllowedByPolicy("fork", policy), true);
    assert.equal(policy.allowMentions, true);
    assert.equal(policy.allowMultiAgent, true);
    assert.equal(policy.showTerminalReportParticipants, true);
  }
});

test("normal conversations keep shared transcript controls but no channel controls", () => {
  const policy = getConversationInteractionPolicy("normal_conversation");

  assert.equal(conversationActionAllowedByPolicy("reply_topic", policy), false);
  assert.equal(conversationActionAllowedByPolicy("edit_latest", policy), true);
  assert.equal(conversationActionAllowedByPolicy("fork", policy), true);
  assert.equal(policy.showRoster, false);
  assert.equal(policy.showUserAvatar, false);
  assert.equal(policy.showAgentAvatar, false);
  assert.equal(policy.showTerminalReportParticipants, false);
});

test("policy overrides cannot drift the surface identity", () => {
  const policy = mergeConversationInteractionPolicy("run_thread", {
    surface: "channel_root",
    allowRetry: false,
  });

  assert.equal(policy.surface, "run_thread");
  assert.equal(policy.allowRetry, false);
  assert.equal(policy.modelControl, "readonly");
});

test("latest edit selection is scoped and never falls back behind a read-only latest prompt", () => {
  const messages = [
    candidate("normal-old", "normal_conversation", "conversation-1", "root", "local-user"),
    candidate("channel-user", "channel_root", "channel-1", "root", "local-user"),
    candidate("normal-assistant", "normal_conversation", "conversation-1", "root", "assistant"),
    { ...candidate("normal-latest", "normal_conversation", "conversation-1", "root", "local-user"), readOnly: true },
  ];

  assert.equal(findLatestEditableConversationMessage(messages, {
    surface: "normal_conversation",
    ownerId: "conversation-1",
    laneId: "root",
  }), undefined);
  assert.equal(findLatestEditableConversationMessage(messages, {
    surface: "channel_root",
    ownerId: "channel-1",
    laneId: "root",
  })?.id, "channel-user");
});

test("latest edit selection ignores superseded revisions and disabled surfaces", () => {
  const messages = [
    candidate("current", "normal_conversation", "conversation-1", "root", "local-user"),
    { ...candidate("superseded", "normal_conversation", "conversation-1", "root", "local-user"), superseded: true },
  ];

  assert.equal(findLatestEditableConversationMessage(messages, {
    surface: "normal_conversation",
    ownerId: "conversation-1",
    laneId: "root",
  })?.id, "current");
  assert.equal(findLatestEditableConversationMessage([
    candidate("run-user", "run_thread", "run-1", "root", "local-user"),
  ], {
    surface: "run_thread",
    ownerId: "run-1",
    laneId: "root",
  }), undefined);
});

test("terminal report projection follows surface policy without deleting semantic data", () => {
  assert.deepEqual(getTerminalReportProjectionPolicy("channel_root"), {
    showParticipants: true,
    showReferences: true,
    artifactMode: "compact",
  });
  assert.equal(getTerminalReportProjectionPolicy("normal_conversation").showParticipants, false);
  assert.equal(getTerminalReportProjectionPolicy("teammate_direct").showParticipants, false);
  assert.equal(getTerminalReportProjectionPolicy("run_thread").artifactMode, "detail");
});

function candidate(id, surface, ownerId, laneId, author) {
  return { id, surface, ownerId, laneId, author, revision: 1 };
}
