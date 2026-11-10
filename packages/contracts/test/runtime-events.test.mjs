import assert from "node:assert/strict";
import test from "node:test";
import { isRunEventData, isRunEventType } from "../dist/index.js";

test("typed run event validation accepts required payload fields", () => {
  assert.equal(isRunEventType("tool_start"), true);
  assert.equal(isRunEventData("tool_start", { toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } }), true);
  assert.equal(isRunEventData("tool_end", { toolName: "bash", isError: false, result: "ok" }), true);
  assert.equal(isRunEventData("approval_requested", { approvalId: "approval-1", title: "Confirm" }), true);
  assert.equal(isRunEventData("run_end", { messageCount: 1 }), true);
  assert.equal(isRunEventType("assistant_reasoning_summary"), true);
  assert.equal(isRunEventType("context_compaction_end"), true);
  assert.equal(isRunEventData("context_compaction_start", {
    reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", attemptId: "attempt-1",
  }), true);
  assert.equal(isRunEventData("context_compaction_end", {
    reason: "overflow", policyVersion: "pi_sdk_lifecycle_v1", outcome: "sdk_installed",
    willRetry: true, tokensBefore: 1800, estimatedTokensAfter: 400,
    usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 320 },
  }), true);
  assert.equal(isRunEventData("assistant_reasoning_summary", {
    text: "Checked the request.\n\nSelected the safe path.",
    parts: ["Checked the request.", "Selected the safe path."],
    semantic: "safe_summary",
    source: "openai_responses",
    truncated: false,
  }), true);
  assert.equal(isRunEventType("loop_detected"), true);
  assert.equal(isRunEventData("loop_detected", {
    code: "execution_loop_detected", attemptId: "attempt-1", loopKind: "exact_repeat",
    observedEventType: "tool_end", observedEventSeq: 7, repeatedCount: 3,
    noProgressActionCount: 2, cycleLength: 1, fingerprint: "a".repeat(64),
    message: "Repeated execution stopped.", retryable: false,
  }), true);
});

test("typed run event validation rejects malformed or unknown rows", () => {
  assert.equal(isRunEventType("not-a-run-event"), false);
  assert.equal(isRunEventData("assistant_text_delta", { text: 42 }), false);
  assert.equal(isRunEventData("tool_end", { toolName: "bash", isError: "false" }), false);
  assert.equal(isRunEventData("approval_requested", { title: "missing id" }), false);
  assert.equal(isRunEventData("run_error", "not an object"), false);
  for (const value of [
    { reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "sdk_installed", willRetry: "true" },
    { reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "completed", willRetry: false },
    { reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "failed", willRetry: false, tokensBefore: -1 },
    { reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "failed", willRetry: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: Infinity } },
  ]) assert.equal(isRunEventData("context_compaction_end", value), false);
  for (const value of [
    { text: "raw", parts: ["raw"], semantic: "raw_thinking", source: "openai_responses", truncated: false },
    { text: "mismatch", parts: ["other"], semantic: "safe_summary", source: "openai_responses", truncated: false },
    { text: "safe", parts: ["safe"], semantic: "safe_summary", source: "anthropic", truncated: false },
    { text: "safe", parts: ["safe"], semantic: "safe_summary", source: "openai_responses", truncated: "false" },
  ]) assert.equal(isRunEventData("assistant_reasoning_summary", value), false);
  assert.equal(isRunEventData("loop_detected", {
    code: "execution_loop_detected", attemptId: "attempt-1", loopKind: "exact_repeat",
    observedEventType: "tool_end", observedEventSeq: 7, repeatedCount: 0,
    noProgressActionCount: 2, fingerprint: "raw-arguments", message: "bad", retryable: true,
  }), false);
});

test("Host command journal events preserve typed identity and process observations", () => {
  const source = { workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "fence" };
  assert.equal(isRunEventType("host_command_prepared"), true);
  assert.equal(isRunEventData("host_command_prepared", { executionId: "command", toolCallId: "call", source,
    workspace: { path: "/workspace", realPath: "/physical" }, cwd: "/physical", commandDigest: "a".repeat(64) }), true);
  assert.equal(isRunEventData("host_command_settled", { executionId: "command", ownerCurrent: false, outcome: "stop_unconfirmed" }), true);
});
test("Host command settlement cannot call an incomplete, cancelled or stale observation completed", () => {
  const observation = { scope: "process_group", leaderExited: true, stdioClosed: true, descendants: "unverified",
    settledBy: "close", signalFailures: [] };
  const completed = { executionId: "command", ownerCurrent: true, outcome: "completed", observation };
  assert.equal(isRunEventData("host_command_settled", completed), true);
  for (const bad of [
    { ...completed, ownerCurrent: false }, { ...completed, observation: undefined },
    ...[{ stopReason: "cancelled" }, { stdioClosed: false }, { leaderExited: false }, { descendants: "stopped" },
      { settledBy: "cleanup_deadline" }, { signalFailures: ["SIGTERM:denied"] },
      { scope: { toString: () => "process_group" } }].map(change => ({ ...completed, observation: { ...observation, ...change } })),
  ]) assert.equal(isRunEventData("host_command_settled", bad), false);
});
