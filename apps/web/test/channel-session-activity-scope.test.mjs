import assert from "node:assert/strict";
import test from "node:test";
import { channelActivityItemBelongsToSession } from "../src/features/workspace/channel-session-activity-scope.ts";

const scope = {
  threadId: "A", messageIds: new Set(["message-A"]), runIds: new Set(["work-run-A"]),
  taskIds: new Set(["task-A"]), workflowIds: new Set(["workflow-A"]),
  workflowStepIds: new Set(["step-A"]), approvalIds: new Set(["preflight-A"]),
};
const owns = (kind, record) => channelActivityItemBelongsToSession({ kind, record }, scope);

test("session activity retains sourced execution threads and approval-only workflow preflight", () => {
  assert.equal(owns("run", { id: "work-run-A", threadId: "execution-thread" }), true);
  assert.equal(owns("approval", { id: "preflight-A" }), true);
  assert.equal(owns("approval", { id: "history", runId: "work-run-A" }), true);
  assert.equal(owns("run", { id: "work-run-B", threadId: "execution-thread" }), false);
  assert.equal(owns("approval", { id: "preflight-B" }), false);
});

test("protocol facts follow their durable message, task or run source and reject unowned channel records", () => {
  for (const kind of ["decision", "handoff"]) {
    assert.equal(owns(kind, { sourceMessageId: "message-A" }), true);
    assert.equal(owns(kind, { sourceTaskId: "task-A" }), true);
    assert.equal(owns(kind, { sourceRunId: "work-run-A" }), true);
    assert.equal(owns(kind, { sourceMessageId: "message-B" }), false);
    assert.equal(owns(kind, {}), false);
  }
  assert.equal(owns("summary", { targetId: "A", sourceMessageIds: [] }), true);
  assert.equal(owns("summary", { targetId: "B", sourceMessageIds: ["message-B"] }), false);
});
