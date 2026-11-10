import assert from "node:assert/strict";
import test from "node:test";
import { readBrokerCommandResult } from "../dist/features/harness/tool-execution/broker-command-result.js";

const identity = { runId: "run", taskId: "task", toolCallId: "call", approvalId: "approval" };
const executed = () => ({ ...identity, status: "succeeded", timedOut: false, cancelled: false, durationMs: 0, exitCode: 0,
  stdout: { byteCount: 0, preview: "", truncated: false }, stderr: { byteCount: 0, preview: "", truncated: false }, artifacts: [] });
const handled = (result, isError = false) => ({ content: [], isError, details: { unifiedExec: result } });

test("Broker accepts owned execution and sparse denial as different evidence kinds", () => {
  const actual = executed();
  assert.equal(readBrokerCommandResult(handled(actual), identity), actual);
  const denial = { toolCallId: identity.toolCallId, approvalId: identity.approvalId, status: "failed", denied: true, reason: "policy" };
  assert.equal(readBrokerCommandResult(handled(denial, true), identity), denial);
  assert.equal(Object.hasOwn(denial, "stdout"), false);
});

const malformed = [
  ["missing result", () => undefined],
  ["foreign tool call", () => ({ ...executed(), toolCallId: "foreign" })],
  ["foreign approval", () => ({ ...executed(), approvalId: "foreign" })],
  ["missing approval", () => ({ ...executed(), approvalId: undefined })],
  ["foreign Run", () => ({ ...executed(), runId: "foreign" })],
  ["foreign Task", () => ({ ...executed(), taskId: "foreign" })],
  ["missing stdout", () => ({ ...executed(), stdout: undefined })],
  ["negative bytes", () => ({ ...executed(), stdout: { byteCount: -1, preview: "", truncated: false } })],
  ["invalid duration", () => ({ ...executed(), durationMs: NaN })],
  ["invalid artifact", () => ({ ...executed(), artifacts: [{ artifactId: "a", role: "stdout" }] })],
  ["unrecognized status", () => ({ ...executed(), status: "ready" })],
  ["denial without error flag", () => ({ ...identity, status: "failed", denied: true, reason: "policy" })],
  ["denial without reason", () => ({ ...identity, status: "failed", denied: true })],
];
for (const [name, make] of malformed) test(`Broker rejects ${name} without a secondary output access error`, () => {
  assert.throws(() => readBrokerCommandResult(handled(make()), identity), { message: "tool_executor_result_invalid" });
});

test("sparse denials still require exact call and approval ownership", () => {
  for (const field of ["toolCallId", "approvalId"]) {
    assert.throws(() => readBrokerCommandResult(handled({ toolCallId: "call", approvalId: "approval", status: "failed",
      denied: true, reason: "policy", [field]: "foreign" }, true), identity), { message: "tool_executor_result_invalid" });
  }
});
