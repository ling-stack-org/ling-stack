import assert from "node:assert/strict";
import test from "node:test";
import { ChannelReplyDispatchCoordinator } from "../dist/features/channels/channel-reply-dispatch-coordinator.js";

const lingLane = {
  workspaceId: "workspace_default",
  channelId: "channel_engineering",
  conversationLineKey: "root",
};

test("pending channel reply followers join one conversation line lane", async () => {
  const coordinator = new ChannelReplyDispatchCoordinator();
  const owner = coordinator.claim(lingLane, "message_root");
  const follower = coordinator.claim(lingLane, "message_guidance");
  const branchOwner = coordinator.claim({ ...lingLane, conversationLineKey: "branch:thread_engineering" }, "message_branch");

  assert.equal(owner.kind, "owner");
  assert.equal(follower.kind, "follower");
  assert.equal(follower.sourceMessageId, "message_root");
  assert.equal(branchOwner.kind, "owner");
  assert.equal(branchOwner.sourceMessageId, "message_branch");

  owner.linkRun("run_root");
  assert.equal(await follower.waitForRun(), "run_root");
  assert.equal(coordinator.claim(lingLane, "message_after_link").kind, "owner");
  branchOwner.release();
  coordinator.close();
});

test("releasing a pending channel reply lane lets the next message own it", async () => {
  const coordinator = new ChannelReplyDispatchCoordinator();
  const owner = coordinator.claim(lingLane, "message_without_run");
  const follower = coordinator.claim(lingLane, "message_next");
  assert.equal(owner.kind, "owner");
  assert.equal(follower.kind, "follower");

  owner.release();
  assert.equal(await follower.waitForRun(), undefined);
  assert.equal(coordinator.claim(lingLane, "message_next").kind, "owner");
  coordinator.close();
});

test("mode-only followers can join only an existing coordinator predecessor", async () => {
  const coordinator = new ChannelReplyDispatchCoordinator();
  assert.equal(coordinator.follow(lingLane), undefined);

  const owner = coordinator.claim(lingLane, "message_predecessor");
  const follower = coordinator.follow(lingLane);
  assert.equal(follower?.sourceMessageId, "message_predecessor");
  owner.linkRun("run_predecessor");
  assert.equal(await follower?.waitForRun(), "run_predecessor");
  assert.equal(coordinator.follow(lingLane), undefined);
  coordinator.close();
});

test("message classification visibility remains fenced until dispatch settles", () => {
  const coordinator = new ChannelReplyDispatchCoordinator();
  const release = coordinator.beginMessageClassification("workspace_default", "message_pending_dispatch");

  assert.equal(
    coordinator.isMessageClassificationPending("workspace_default", "message_pending_dispatch"),
    true,
  );
  release();
  release();
  assert.equal(
    coordinator.isMessageClassificationPending("workspace_default", "message_pending_dispatch"),
    false,
  );
  coordinator.close();
});
