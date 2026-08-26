import assert from "node:assert/strict";
import test from "node:test";
import { projectRunEventsToConversationItems } from "../dist/index.js";

const run = {
  id: "run_projection_1",
  status: "running",
  cwd: "/tmp/workspace",
  taskId: "task_projection_1",
  providerName: "test",
  providerModel: "test-model",
  taskSnapshot: {},
  providerSnapshot: {},
  requestSnapshot: {},
  eventLogPath: "/tmp/run-events.jsonl",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

const turn = {
  id: "turn_projection_1",
  workspaceId: "workspace_default",
  threadId: "thread_projection_1",
  kind: "conversation",
  status: "running",
  title: "Projection",
  userInstruction: "Inspect the workspace",
  createdByActor: "local-user",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function event(seq, type, data) {
  return {
    id: `event-${seq}`,
    runId: run.id,
    seq,
    ts: `2026-08-25T00:00:0${seq}.000Z`,
    type,
    data,
  };
}

test("run evidence projects to deterministic typed items and replays idempotently", () => {
  const events = [
    event(1, "assistant_text_delta", { text: "Inspect " }),
    event(2, "assistant_text_delta", { text: "complete." }),
    event(3, "message_end", { role: "assistant" }),
    event(4, "tool_start", { toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } }),
    event(5, "tool_end", { toolCallId: "call-1", toolName: "bash", result: "/tmp/workspace", isError: false }),
    event(6, "approval_requested", { approvalId: "approval-1", title: "Confirm write" }),
    event(7, "approval_denied", { approvalId: "approval-1", decisionReason: "not now" }),
    event(8, "artifact_created", { artifactId: "artifact-1", toolName: "bash", artifact: { type: "file" } }),
    event(9, "run_end", { messageCount: 1 }),
  ];

  const first = projectRunEventsToConversationItems({ run, turn, events });
  const replay = projectRunEventsToConversationItems({ run, turn, events, existingItems: first });

  assert.deepEqual(replay, first);
  assert.deepEqual(first.map((item) => item.kind), [
    "assistant_message",
    "tool_call",
    "tool_result",
    "approval_request",
    "approval_decision",
    "artifact_ref",
    "operation_state",
  ]);
  const assistant = first.find((item) => item.kind === "assistant_message");
  assert.equal(assistant.payload.body, "Inspect complete.");
  assert.equal(assistant.payload.streaming, false);
  const approval = first.find((item) => item.kind === "approval_decision");
  assert.equal(approval.payload.decision, "denied");
  assert.ok(first.every((item) => item.domainRefs.some((ref) => ref.type === "run" && ref.id === run.id)));
});

test("unpaired tool completion remains renderable", () => {
  const items = projectRunEventsToConversationItems({
    run,
    turn,
    events: [event(1, "tool_end", { toolCallId: "missing-start", toolName: "bash", isError: true, result: "failed" })],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tool_result");
  assert.equal(items[0].payload.status, "failed");
});
