import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationOperationCell, projectConversationCommandBatches } from "../dist/index.js";

test("work cell view models normalize legacy row aliases", () => {
  const operationRows = [
    { id: "row-1", title: "Read workspace", tone: "success" },
  ];
  const agentBranches = [
    { id: "agent-1", label: "Designer", rows: operationRows },
  ];
  const terminalReportRows = [
    { id: "report-1", title: "Done", tone: "success" },
  ];

  const normalized = normalizeConversationOperationCell({
    id: "cell-1",
    sourceKind: "run_thread",
    threadId: "thread-1",
    anchorRunId: "run-1",
    runIds: ["run-1"],
    mode: "completed",
    status: "succeeded",
    title: "Workspace review",
    summary: "Completed",
    stats: [],
    operationRows,
    agentBranches,
    terminalReportRows,
    groups: [],
    evidenceLinks: [],
    artifactStripItems: [],
    updatedAt: "2026-06-28T00:00:00.000Z",
  });

  assert.equal(normalized.agentSpans, agentBranches);
  assert.equal(normalized.activeRows, operationRows);
  assert.equal(normalized.branchRows, agentBranches);
  assert.equal(normalized.finalReportRows, terminalReportRows);
});

test("command batching groups three adjacent low-risk successful commands", () => {
  const rows = [
    commandRow("one", "run-1", "pnpm typecheck", 1200),
    commandRow("two", "run-1", "pnpm lint", 800),
    commandRow("three", "run-1", "pnpm test", 2200),
  ];

  const items = projectConversationCommandBatches(rows, { participantScope: "engineer" });

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "command_batch");
  assert.equal(items[0].batch.commandCount, 3);
  assert.equal(items[0].batch.durationMs, 4200);
  assert.match(items[0].batch.id, /^command-batch:engineer:run-1:/u);
  assert.deepEqual(items[0].batch.commands.map((command) => command.commandText), ["pnpm typecheck", "pnpm lint", "pnpm test"]);
});

test("command batching preserves boundaries and leaves active or consequential commands visible", () => {
  const rows = [
    commandRow("one", "run-1", "pnpm typecheck", 1200),
    commandRow("two", "run-1", "pnpm lint", 800),
    { id: "note", presentation: "note", title: "Verify the changed surface" },
    commandRow("three", "run-1", "pnpm test", 2200),
    commandRow("four", "run-1", "pnpm e2e", 3500),
    commandRow("five", "run-1", "pnpm build", 1800),
    commandRow("active", "run-1", "pnpm preview", undefined, { status: "executing", exitCode: undefined }),
    commandRow("push", "run-1", "git push", 400, { actionType: "git_push", risk: "medium" }),
  ];

  const items = projectConversationCommandBatches(rows);

  assert.deepEqual(items.map((item) => item.kind), ["operation", "operation", "operation", "command_batch", "operation", "operation"]);
  assert.equal(items[3].kind, "command_batch");
  assert.equal(items[3].batch.commandCount, 3);
  assert.equal(items[4].kind, "operation");
  assert.equal(items[4].row.commandExecution.status, "executing");
  assert.equal(items[5].kind, "operation");
  assert.equal(items[5].row.commandExecution.actionType, "git_push");
});

test("command batch identity stays stable when another eligible command completes", () => {
  const first = projectConversationCommandBatches([
    commandRow("one", "run-1", "one", 100),
    commandRow("two", "run-1", "two", 100),
    commandRow("three", "run-1", "three", 100),
  ])[0];
  const second = projectConversationCommandBatches([
    commandRow("one", "run-1", "one", 100),
    commandRow("two", "run-1", "two", 100),
    commandRow("three", "run-1", "three", 100),
    commandRow("four", "run-1", "four", 100),
  ])[0];

  assert.equal(first.kind, "command_batch");
  assert.equal(second.kind, "command_batch");
  assert.equal(first.batch.id, second.batch.id);
  assert.notEqual(first.batch.revisionKey, second.batch.revisionKey);
});

test("command batching requires stable run and tool-call identities", () => {
  const missingRun = commandRow("missing-run", "", "one", 100);
  const missingToolCall = commandRow("missing-tool", "run-1", "two", 100, { toolCallId: undefined });

  const items = projectConversationCommandBatches([
    missingRun,
    missingToolCall,
    commandRow("three", "run-1", "three", 100),
    commandRow("four", "run-1", "four", 100),
    commandRow("five", "run-1", "five", 100),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["operation", "operation", "command_batch"]);
});

function commandRow(id, runId, commandText, durationMs, overrides = {}) {
  const status = overrides.status ?? "succeeded";
  const exitCode = "exitCode" in overrides ? overrides.exitCode : 0;
  return {
    id: `row-${id}`,
    presentation: "shell",
    title: status === "executing" ? "Running command" : "Ran command",
    commandText,
    commandExecution: {
      actionId: id,
      toolCallId: "toolCallId" in overrides ? overrides.toolCallId : `tool-${id}`,
      runId,
      actionType: overrides.actionType ?? "bash",
      risk: overrides.risk ?? "low",
      status,
      commandText,
      durationMs,
      exitCode,
      latestEventSeq: 1,
      outputTruncated: false,
    },
  };
}
