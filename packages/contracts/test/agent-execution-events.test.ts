import assert from "node:assert/strict";
import test from "node:test";
import { isRunEventData, isRunEventType } from "../dist/index.js";

test("nested tool events preserve a nonempty optional parent identity", () => {
  for (const type of ["tool_start", "tool_update", "tool_end"] as const) {
    const event = { toolCallId: "parent/1", toolName: "read", parentToolCallId: "parent", isError: false };
    assert.equal(isRunEventData(type, event), true);
    assert.equal(isRunEventData(type, { ...event, parentToolCallId: "" }), false);
    assert.equal(isRunEventData(type, { ...event, parentToolCallId: 1 }), false);
    assert.equal(isRunEventData(type, { ...event, parentToolCallId: undefined }), true);
  }
});

test("Hook audit receipts validate configuration, lifecycle, outcome and timing", () => {
  const receipt = { hookId: "project.guard", configDigest: `sha256:${"a".repeat(64)}`, event: "before_tool",
    toolCallId: "parent/1", status: "denied", durationMs: 10, message: "Protected file" };
  assert.equal(isRunEventType("hook_execution"), true);
  assert.equal(isRunEventData("hook_execution", receipt), true);
  for (const patch of [{ configDigest: "unsealed" }, { event: "grant_permission" }, { status: "approved" },
    { durationMs: -1 }, { durationMs: Infinity }, { toolCallId: "" }, { hookId: "" }]) {
    assert.equal(isRunEventData("hook_execution", { ...receipt, ...patch }), false);
  }
});
