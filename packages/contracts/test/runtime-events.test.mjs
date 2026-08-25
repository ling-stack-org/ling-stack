import assert from "node:assert/strict";
import test from "node:test";
import { isRunEventData, isRunEventType } from "../dist/index.js";

test("typed run event validation accepts required payload fields", () => {
  assert.equal(isRunEventType("tool_start"), true);
  assert.equal(isRunEventData("tool_start", { toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } }), true);
  assert.equal(isRunEventData("tool_end", { toolName: "bash", isError: false, result: "ok" }), true);
  assert.equal(isRunEventData("approval_requested", { approvalId: "approval-1", title: "Confirm" }), true);
  assert.equal(isRunEventData("run_end", { messageCount: 1 }), true);
});

test("typed run event validation rejects malformed or unknown rows", () => {
  assert.equal(isRunEventType("not-a-run-event"), false);
  assert.equal(isRunEventData("assistant_text_delta", { text: 42 }), false);
  assert.equal(isRunEventData("tool_end", { toolName: "bash", isError: "false" }), false);
  assert.equal(isRunEventData("approval_requested", { title: "missing id" }), false);
  assert.equal(isRunEventData("run_error", "not an object"), false);
});
