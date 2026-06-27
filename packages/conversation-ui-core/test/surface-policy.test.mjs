import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationActionAllowedByPolicy,
  getConversationSurfacePolicy,
  mergeConversationSurfacePolicy,
} from "../dist/index.js";

test("private chat policy blocks channel-only controls", () => {
  const policy = getConversationSurfacePolicy("teammate_direct");

  assert.equal(conversationActionAllowedByPolicy("copy", policy), true);
  assert.equal(conversationActionAllowedByPolicy("create_task", policy), true);
  assert.equal(conversationActionAllowedByPolicy("reply_topic", policy), false);
  assert.equal(policy.allowTeammateMentions, false);
  assert.equal(policy.allowMultiTeammateActivity, false);
});

test("channel policies allow topic reply and teammate collaboration", () => {
  for (const surface of ["channel_root", "channel_branch"]) {
    const policy = getConversationSurfacePolicy(surface);

    assert.equal(conversationActionAllowedByPolicy("reply_topic", policy), true);
    assert.equal(policy.allowTeammateMentions, true);
    assert.equal(policy.allowMultiTeammateActivity, true);
  }
});

test("normal conversations keep compact evidence but no channel controls", () => {
  const policy = getConversationSurfacePolicy("normal_conversation");

  assert.equal(policy.evidenceMode, "compact");
  assert.equal(policy.workCellMode, "compact");
  assert.equal(conversationActionAllowedByPolicy("reply_topic", policy), false);
  assert.equal(policy.showChannelRoster, false);
});

test("policy overrides cannot drift the surface identity", () => {
  const policy = mergeConversationSurfacePolicy("run_thread", {
    surface: "channel_root",
    allowRetry: false,
  });

  assert.equal(policy.surface, "run_thread");
  assert.equal(policy.allowRetry, false);
  assert.equal(policy.evidenceMode, "rich");
});
