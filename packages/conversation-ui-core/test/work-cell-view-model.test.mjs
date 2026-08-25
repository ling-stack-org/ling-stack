import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeConversationOperationCell,
  projectConversationActivity,
  projectConversationCommandBatches,
  summarizeConversationActivity,
} from "../dist/index.js";

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

test("activity projection groups three adjacent successful read actions", () => {
  const items = projectConversationActivity([
    readRow("one", "run-1", "src/one.ts"),
    readRow("two", "run-1", "src/two.ts"),
    readRow("three", "run-1", "src/three.ts"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["exploration_batch"]);
  assert.equal(items[0].batch.operationCount, 3);
  assert.equal(items[0].batch.targetCount, 3);
  assert.deepEqual(items[0].batch.actionIds, ["one", "two", "three"]);
  assert.match(items[0].batch.id, /^exploration-batch:primary:run-1:one$/u);
});

test("activity projection leaves one or two reads visible", () => {
  for (const count of [1, 2]) {
    const items = projectConversationActivity(
      ["one", "two"].slice(0, count).map((id) => readRow(id, "run-1", `src/${id}.ts`)),
    );
    assert.deepEqual(items.map((item) => item.kind), Array.from({ length: count }, () => "operation"));
  }
});

test("activity projection does not batch a read without source references", () => {
  const items = projectConversationActivity([
    readRow("one", "run-1", "src/one.ts", { sourceRefs: [] }),
    readRow("two", "run-1", "src/two.ts"),
    readRow("three", "run-1", "src/three.ts"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["operation", "operation", "operation"]);
});

test("activity projection keeps reads atomic when attempt lineage is missing", () => {
  const items = projectConversationActivity([
    readRow("one", "run-1", "src/one.ts", { attemptId: undefined }),
    readRow("two", "run-1", "src/two.ts"),
    readRow("three", "run-1", "src/three.ts"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["operation", "operation", "operation"]);
});

test("activity projection keeps a logical action note with its evidence row", () => {
  const noteExecution = operationExecution("one", "run-1", "read", "succeeded", [fileRef("src/one.ts")]);
  const items = projectConversationActivity([
    { id: "note:one", presentation: "note", title: "Read scope", operationExecution: noteExecution },
    readRow("one", "run-1", "src/one.ts"),
    readRow("two", "run-1", "src/two.ts"),
    readRow("three", "run-1", "src/three.ts"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["exploration_batch"]);
  assert.equal(items[0].batch.rows.length, 4);
  assert.equal(items[0].batch.actionIds.length, 3);
  assert.equal(items[0].batch.actionIds[0], "one");
});

test("activity projection splits reads at consequential actions and lineage boundaries", () => {
  const items = projectConversationActivity([
    readRow("one", "run-1", "src/one.ts"),
    readRow("two", "run-1", "src/two.ts"),
    readRow("three", "run-1", "src/three.ts"),
    operationRow("edit", "run-1", "edit", "succeeded", [fileRef("src/three.ts")]),
    readRow("four", "run-1", "src/four.ts"),
    readRow("five", "run-1", "src/five.ts"),
    readRow("six", "run-2", "src/six.ts"),
    readRow("seven", "run-2", "src/seven.ts"),
    readRow("eight", "run-2", "src/eight.ts"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["exploration_batch", "operation", "operation", "operation", "exploration_batch"]);
  assert.deepEqual(items.filter((item) => item.kind === "exploration_batch").map((item) => item.batch.runId), ["run-1", "run-2"]);
  assert.equal(items[1].row.operationExecution.actionId, "edit");
});

test("activity summary counts logical actions once and excludes notes and failures", () => {
  const readExecution = operationExecution("read-1", "run-1", "read", "succeeded", [fileRef("src/one.ts")]);
  const editExecution = operationExecution("edit-1", "run-1", "edit", "succeeded", [fileRef("src/one.ts"), fileRef("src/two.ts")]);
  const commandExecution = operationExecution("command-1", "run-1", "bash", "succeeded");
  const summary = summarizeConversationActivity([
    { id: "note:read-1", presentation: "note", title: "Read scope", operationExecution: readExecution },
    { id: "read:read-1", title: "Read one", operationExecution: readExecution },
    { id: "edit:edit-1", title: "Edit files", operationExecution: editExecution },
    { id: "command:command-1", presentation: "shell", title: "Run command", commandExecution: { risk: "low" }, operationExecution: commandExecution },
    { id: "failed", title: "Failed read", operationExecution: operationExecution("failed", "run-1", "read", "failed", [fileRef("src/failed.ts")]) },
  ]);

  assert.deepEqual(summary, {
    editedFileCount: 2,
    editedItemCount: 1,
    readItemCount: 1,
    commandCount: 1,
    hasStructuredActions: true,
  });
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
      attemptId: overrides.attemptId ?? (runId ? `attempt-${runId}` : undefined),
      turnRunRole: overrides.turnRunRole ?? "primary",
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

function readRow(id, runId, path, overrides = {}) {
  return operationRow(id, runId, "read", "succeeded", "sourceRefs" in overrides ? overrides.sourceRefs : [fileRef(path)], overrides);
}

function operationRow(id, runId, actionType, status, sourceRefs = [], overrides = {}) {
  return {
    id: `row-${id}`,
    title: `${actionType} ${id}`,
    operationExecution: operationExecution(id, runId, actionType, status, sourceRefs, overrides),
  };
}

function operationExecution(actionId, runId, actionType, status, sourceRefs = [], overrides = {}) {
  return {
    actionId,
    runId,
    attemptId: overrides.attemptId ?? (runId ? `attempt-${runId}` : undefined),
    turnRunRole: overrides.turnRunRole ?? "primary",
    actionType,
    status,
    sourceRefs,
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function fileRef(path) {
  return { kind: "file", id: path, label: path };
}
