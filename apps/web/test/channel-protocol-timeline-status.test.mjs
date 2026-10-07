import assert from "node:assert/strict";
import test from "node:test";
import {
  channelApprovalTimelineStatus,
  channelDecisionTimelineStatus,
  channelHandoffTimelineStatus,
  channelRunTimelineStatus,
  channelStateTransitionTimelineStatus,
  channelTaskTimelineStatus,
  channelWorkflowStepTimelineStatus,
  channelWorkflowTimelineStatus,
} from "../src/features/workspace/channel-protocol-timeline-status.ts";

test("channel protocol timeline status maps each domain lifecycle explicitly", () => {
  assert.deepEqual(
    ["pending", "approved", "denied", "expired", "cancelled"].map(channelApprovalTimelineStatus),
    ["waiting", "succeeded", "failed", "failed", "cancelled"],
  );
  assert.deepEqual(
    ["active", "superseded", "rejected"].map(channelDecisionTimelineStatus),
    [undefined, "cancelled", "failed"],
  );
  assert.deepEqual(
    ["proposed", "accepted", "declined", "completed", "cancelled"].map(channelHandoffTimelineStatus),
    ["pending", "running", "failed", "succeeded", "cancelled"],
  );
  assert.deepEqual(
    ["draft", "ready", "running", "waiting_for_approval", "blocked", "succeeded", "failed", "cancelled"].map(channelWorkflowTimelineStatus),
    ["pending", "pending", "running", "waiting", "blocked", "succeeded", "failed", "cancelled"],
  );
  assert.deepEqual(
    ["queued", "claimed", "running", "waiting_for_approval", "blocked", "succeeded", "failed", "skipped", "cancelled"].map(channelWorkflowStepTimelineStatus),
    ["pending", "running", "running", "waiting", "blocked", "succeeded", "failed", "succeeded", "cancelled"],
  );
  assert.deepEqual(
    ["todo", "claimed", "running", "blocked", "review", "done", "failed", "cancelled"].map(channelTaskTimelineStatus),
    ["pending", "running", "running", "blocked", "pending", "succeeded", "failed", "cancelled"],
  );
  assert.deepEqual(
    ["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"].map(channelRunTimelineStatus),
    ["pending", "running", "waiting", "succeeded", "failed", "cancelled"],
  );
});

test("state-transition projection uses the entity lifecycle and fails closed for unknown statuses", () => {
  assert.equal(channelRunTimelineStatus("yielded"), "waiting");
  assert.equal(channelWorkflowTimelineStatus("waiting_for_input"), "waiting");
  assert.equal(channelWorkflowStepTimelineStatus("waiting_for_input"), "waiting");
  assert.equal(channelTaskTimelineStatus("waiting_for_input"), "waiting");
  assert.equal(channelStateTransitionTimelineStatus({ entityType: "turn", toStatus: "waiting_for_input" }), "waiting");
  assert.equal(channelStateTransitionTimelineStatus({ entityType: "work_unit", toStatus: "waiting_for_input" }), "waiting");
  assert.equal(channelStateTransitionTimelineStatus({ entityType: "workflow_step", toStatus: "skipped" }), "succeeded");
  assert.equal(channelStateTransitionTimelineStatus({ entityType: "workflow", toStatus: "cancelled" }), "cancelled");
  assert.equal(channelStateTransitionTimelineStatus({ entityType: "approval", toStatus: "pending" }), "waiting");
  assert.equal(channelStateTransitionTimelineStatus({ entityType: "turn", toStatus: "superseded" }), "cancelled");
  assert.equal(channelStateTransitionTimelineStatus({ entityType: "work_unit", toStatus: "stale" }), "failed");
  assert.equal(channelStateTransitionTimelineStatus({ entityType: "workflow_step", toStatus: "mystery" }), undefined);
});
