import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveExecutionActionCommandEvidence,
  executionActionStatusFromCommandEvidence,
} from "../dist/features/runs/execution-action-command-evidence.js";
import { listExecutionActions } from "../dist/features/runs/execution-actions.js";

test("active command evidence folds tool updates into a bounded redacted tail", () => {
  const start = event(1, "tool_start", {
    toolCallId: "tool-live",
    toolName: "bash",
    args: { command: "pnpm test", cwd: "/repo" },
  });
  const updates = Array.from({ length: 80 }, (_, index) => event(index + 2, "tool_update", {
    toolCallId: "tool-live",
    toolName: "bash",
    partialResult: {
      toolCallId: "tool-live",
      stream: index % 2 === 0 ? "stdout" : "stderr",
      sequence: index + 1,
      text: `\u001b[31mline-${index}-${"x".repeat(160)}\u001b[0m\n`,
      byteCount: 180,
      redacted: index === 0,
      truncated: false,
      ts: `2026-07-13T00:00:${String(index).padStart(2, "0")}.000Z`,
    },
  }));

  const evidence = deriveExecutionActionCommandEvidence({
    events: [start, ...updates],
    toolCallId: "tool-live",
    start,
  });

  assert.ok(evidence);
  assert.equal(evidence.command, "pnpm test");
  assert.equal(evidence.cwd, "/repo");
  assert.equal(evidence.latestEventSeq, 81);
  assert.equal(evidence.completedAt, undefined);
  assert.equal(evidence.exitCode, undefined);
  assert.equal(executionActionStatusFromCommandEvidence(evidence), undefined);
  assert.equal(evidence.outputTail.length <= 64, true);
  const output = evidence.outputTail.map((chunk) => chunk.text).join("");
  assert.equal(Buffer.byteLength(output, "utf8") <= 8 * 1024, true);
  assert.equal(output.split(/\r?\n/u).length <= 41, true);
  assert.doesNotMatch(output, /\u001b/u);
  assert.match(output, /line-79/u);
  assert.doesNotMatch(output, /line-0-/u);
  assert.equal(evidence.outputTruncated, true);
});

test("execution action projection reads command completion after the first event page", () => {
  const runId = "run-paged";
  const toolCallId = "tool-paged";
  const start = event(1, "tool_start", {
    toolCallId,
    toolName: "bash",
    args: { command: "pnpm test", cwd: "/repo" },
  }, runId);
  const filler = Array.from({ length: 999 }, (_, index) => event(index + 2, "assistant_text_delta", {
    text: `filler-${index}`,
  }, runId));
  const update = event(1001, "tool_update", {
    toolCallId,
    toolName: "bash",
    partialResult: {
      toolCallId,
      stream: "stdout",
      sequence: 1,
      text: "final output\n",
      byteCount: 13,
      redacted: false,
      truncated: false,
      ts: "2026-07-13T00:16:41.000Z",
    },
  }, runId);
  const end = event(1002, "tool_end", {
    toolCallId,
    toolName: "bash",
    isError: false,
    result: {
      details: {
        unifiedExec: {
          status: "succeeded",
          cwd: "/repo",
          command: { kind: "shell", command: "pnpm test", shell: "bash" },
          startedAt: start.ts,
          endedAt: "2026-07-13T00:16:42.000Z",
          durationMs: 1000,
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          stdout: { byteCount: 13, lineCount: 1, preview: "final output\n", truncated: false },
          stderr: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
          artifacts: [],
        },
      },
    },
  }, runId);
  const events = [start, ...filler, update, end];
  const run = {
    id: runId,
    taskId: "task-paged",
    threadId: "thread-paged",
    workUnitId: "work-unit-paged",
    cwd: "/repo",
    status: "succeeded",
    createdAt: start.ts,
    updatedAt: end.ts,
  };
  const store = {
    getRun: (id) => id === runId ? run : undefined,
    listRuns: () => [run],
    listApprovalRequests: () => [],
    listEvents: (id, options = {}) => id === runId
      ? events.filter((entry) => entry.seq > (options.afterSeq ?? 0)).slice(0, options.limit ?? 200)
      : [],
  };

  const actions = listExecutionActions(store, { runId, limit: 100 });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "succeeded");
  assert.equal(actions[0].risk, "low");
  assert.equal(actions[0].commandEvidence.latestEventSeq, 1002);
  assert.equal(actions[0].commandEvidence.exitCode, 0);
  assert.match(actions[0].commandEvidence.outputTail.map((chunk) => chunk.text).join(""), /final output/u);
});

function event(seq, type, data, runId = "run-live") {
  return {
    id: `event-${seq}`,
    runId,
    seq,
    ts: `2026-07-13T00:00:${String(seq).padStart(2, "0")}.000Z`,
    type,
    data,
  };
}
