import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionLoopDetector } from "../dist/features/runs/execution-loop-detector.js";

function event(type, data, seq) {
  return { type, data, seq };
}

function complete(detector, seq, id, toolName, args, result) {
  detector.observe(event("tool_start", { toolCallId: id, toolName, args }, seq));
  return detector.observe(event("tool_end", { toolCallId: id, toolName, result, isError: false }, seq + 1));
}

test("detects an exact repeated action and result without persisting raw values", () => {
  const detector = new ExecutionLoopDetector("attempt-exact");
  const secret = "secret-value-must-not-escape";
  assert.equal(complete(detector, 1, "call-1", "read", { path: secret }, { text: secret }), undefined);
  assert.equal(complete(detector, 3, "call-2", "read", { path: secret }, { text: secret }), undefined);
  const finding = complete(detector, 5, "call-3", "read", { path: secret }, { text: secret });
  assert.equal(finding?.event.loopKind, "exact_repeat");
  assert.equal(finding?.event.repeatedCount, 3);
  assert.equal(finding?.event.retryable, false);
  assert.match(finding?.event.fingerprint ?? "", /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(finding), new RegExp(secret, "u"));
});

test("detects a bounded A-B cycle only after the configured repeated window", () => {
  const detector = new ExecutionLoopDetector("attempt-cycle");
  let finding;
  for (let index = 0; index < 3; index += 1) {
    finding = complete(detector, (index * 4) + 1, `a-${index}`, "read", { path: "a.txt" }, { text: "a" });
    if (index < 2) assert.equal(finding, undefined);
    finding = complete(detector, (index * 4) + 3, `b-${index}`, "grep", { query: "b" }, { text: "b" });
  }
  assert.equal(finding?.event.loopKind, "cycle");
  assert.equal(finding?.event.cycleLength, 2);
  assert.equal(finding?.event.repeatedCount, 3);
});

test("changing tool updates are progress while identical updates trip the breaker", () => {
  const changing = new ExecutionLoopDetector("attempt-changing");
  changing.observe(event("tool_start", { toolCallId: "stream", toolName: "bash", args: { command: "build" } }, 1));
  for (let index = 0; index < 20; index += 1) {
    assert.equal(changing.observe(event("tool_update", {
      toolCallId: "stream", toolName: "bash", partialResult: { text: `line-${index}` },
    }, index + 2)), undefined);
  }

  const repeated = new ExecutionLoopDetector("attempt-repeated-update");
  repeated.observe(event("tool_start", { toolCallId: "stuck", toolName: "bash", args: { command: "build" } }, 1));
  let finding;
  for (let index = 0; index < 6; index += 1) {
    finding = repeated.observe(event("tool_update", {
      toolCallId: "stuck", toolName: "bash", partialResult: { text: "unchanged" },
    }, index + 2));
  }
  assert.equal(finding?.event.loopKind, "repeated_update");
  assert.equal(finding?.event.repeatedCount, 6);
});

test("new evidence resets the no-progress budget and detector state is attempt-local", () => {
  const limits = { noProgressActionBudget: 3, exactRepeatThreshold: 20 };
  const first = new ExecutionLoopDetector("attempt-one", limits);
  first.observe(event("tool_start", { toolCallId: "one", toolName: "read", args: {} }, 1));
  first.observe(event("tool_start", { toolCallId: "two", toolName: "read", args: {} }, 2));
  first.observe(event("artifact_created", { artifactId: "new-artifact" }, 3));
  assert.equal(first.observe(event("tool_start", { toolCallId: "three", toolName: "read", args: {} }, 4)), undefined);
  assert.equal(first.observe(event("tool_start", { toolCallId: "four", toolName: "read", args: {} }, 5)), undefined);
  assert.equal(first.observe(event("tool_start", { toolCallId: "five", toolName: "read", args: {} }, 6))?.event.loopKind, "no_progress_budget");

  const second = new ExecutionLoopDetector("attempt-two", limits);
  assert.equal(second.observe(event("tool_start", { toolCallId: "fresh", toolName: "read", args: {} }, 1)), undefined);
});

test("Host receipts and approval state changes count as new evidence", () => {
  const detector = new ExecutionLoopDetector("attempt-host", { noProgressActionBudget: 2, exactRepeatThreshold: 20 });
  detector.observe(event("tool_start", { toolCallId: "one", toolName: "bash", args: {} }, 1));
  detector.observe(event("host_command_settled", { executionId: "host-one", outcome: "completed" }, 2));
  assert.equal(detector.observe(event("tool_start", { toolCallId: "two", toolName: "bash", args: {} }, 3)), undefined);
  detector.observe(event("approval_approved", { approvalId: "approval-one" }, 4));
  assert.equal(detector.observe(event("tool_start", { toolCallId: "three", toolName: "bash", args: {} }, 5)), undefined);
});
