import assert from "node:assert/strict";
import test from "node:test";
import { ChannelReplyDispatchCoordinator } from "../dist/features/channels/channel-reply-dispatch-coordinator.js";

const lingLane = {
  workspaceId: "workspace_default",
  channelId: "channel_engineering",
  teammateId: "ling_agent",
};

test("pending channel reply followers join one channel lane regardless of target teammate", async () => {
  const coordinator = new ChannelReplyDispatchCoordinator();
  const owner = coordinator.claim(lingLane, "message_root");
  const follower = coordinator.claim(lingLane, "message_guidance");
  const otherTeammate = coordinator.claim({ ...lingLane, teammateId: "teammate_engineer" }, "message_engineer");

  assert.equal(owner.kind, "owner");
  assert.equal(follower.kind, "follower");
  assert.equal(follower.sourceMessageId, "message_root");
  assert.equal(otherTeammate.kind, "follower");
  assert.equal(otherTeammate.sourceMessageId, "message_root");

  owner.linkRun("run_root");
  assert.equal(await follower.waitForRun(), "run_root");
  assert.equal(await otherTeammate.waitForRun(), "run_root");
  assert.equal(coordinator.claim(lingLane, "message_after_link").kind, "owner");
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
