import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeConversationOperationCell,
  projectConversationActivity,
  projectConversationCommandBatches,
  projectConversationSubAgentActivity,
  projectConversationTimelineItems,
  mergeConversationTimelineItems,
  normalizeConversationTimelineItems,
  summarizeConversationActivity,
  fingerprintConversationTimeline,
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

test("work-cell exploration preserves Host output and never promotes its input or status to output", () => {
  const row = {
    ...readRow("read-output", "run-1", "src/todo.test.mjs"),
    description: "src/todo.test.mjs",
    meta: "Failed",
    toolEvidence: {
      toolName: "read", inputSummary: "src/todo.test.mjs · limit 400",
      outputText: "ENOENT: no such file or directory\n  src/todo.test.mjs",
      outputTruncated: true, latestEventSeq: 50,
    },
  };
  const [item] = projectConversationTimelineItems([row]);
  assert.equal(item.kind, "exploration");
  assert.equal(item.resultSummary, row.toolEvidence.outputText);
  assert.equal(item.inputSummary, row.toolEvidence.inputSummary);
  assert.equal(item.outputTruncated, true);
  const [withoutOutput] = projectConversationTimelineItems([{ ...row, toolEvidence: undefined }]);
  assert.equal(withoutOutput.resultSummary, undefined);

  const [tool] = projectConversationTimelineItems([{
    ...row,
    operationExecution: { ...row.operationExecution, actionType: "mcp_tool" },
    toolEvidence: undefined,
  }]);
  assert.equal(tool.resultSummary, undefined, "A status label must never become tool result evidence");
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

test("typed batch revision is monotonic when a child updates or is appended", () => {
  const first = projectConversationTimelineItems(projectConversationActivity([
    commandRow("one", "run-1", "one", 100, { revision: 100 }),
    commandRow("two", "run-1", "two", 100, { revision: 1 }),
    commandRow("three", "run-1", "three", 100, { revision: 1 }),
  ]))[0];
  const updated = projectConversationTimelineItems(projectConversationActivity([
    commandRow("one", "run-1", "one", 100, { revision: 100 }),
    commandRow("two", "run-1", "two", 100, { revision: 2 }),
    commandRow("three", "run-1", "three", 100, { revision: 1 }),
  ]))[0];
  const appended = projectConversationTimelineItems(projectConversationActivity([
    commandRow("one", "run-1", "one", 100, { revision: 100 }),
    commandRow("two", "run-1", "two", 100, { revision: 1 }),
    commandRow("three", "run-1", "three", 100, { revision: 1 }),
    commandRow("four", "run-1", "four", 100, { revision: 1 }),
  ]))[0];

  assert.equal(first.kind, "commandBatch");
  assert.equal(updated.kind, "commandBatch");
  assert.equal(appended.kind, "commandBatch");
  assert.ok(updated.revision > first.revision);
  assert.ok(appended.revision > updated.revision);
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

test("command batching keeps approval-linked commands standalone", () => {
  const items = projectConversationCommandBatches([
    commandRow("one", "run-1", "one", 100),
    commandRow("approved", "run-1", "approved", 100, { approvalId: "approval-1" }),
    commandRow("two", "run-1", "two", 100),
    commandRow("three", "run-1", "three", 100),
    commandRow("four", "run-1", "four", 100),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["operation", "operation", "command_batch"]);
  assert.deepEqual(items[2].batch.actionIds, ["two", "three", "four"]);
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

test("activity projection keeps approval-linked reads standalone", () => {
  const items = projectConversationActivity([
    readRow("one", "run-1", "src/one.ts"),
    readRow("approved", "run-1", "src/approved.ts", { approvalId: "approval-1" }),
    readRow("two", "run-1", "src/two.ts"),
    readRow("three", "run-1", "src/three.ts"),
    readRow("four", "run-1", "src/four.ts"),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["operation", "operation", "exploration_batch"]);
  assert.deepEqual(items[2].batch.actionIds, ["two", "three", "four"]);
});

test("activity projection preserves source order when reads and commands are interleaved", () => {
  const items = projectConversationActivity([
    readRow("read-a", "run-1", "src/a.ts"),
    commandRow("command-b", "run-1", "pnpm test", 100),
    readRow("read-c", "run-1", "src/c.ts"),
    commandRow("command-d", "run-1", "pnpm lint", 100),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["operation", "operation", "operation", "operation"]);
  assert.deepEqual(items.map((item) => item.row.operationExecution?.actionId ?? item.row.commandExecution?.actionId), [
    "read-a",
    "command-b",
    "read-c",
    "command-d",
  ]);
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

test("typed timeline keeps batch identity and maps evidence to semantic item kinds", () => {
  const items = projectConversationTimelineItems(projectConversationActivity([
    readRow("one", "run-1", "src/one.ts"),
    readRow("two", "run-1", "src/two.ts"),
    readRow("three", "run-1", "src/three.ts"),
    operationRow("edit", "run-1", "edit", "succeeded", [fileRef("src/three.ts")]),
  ]), { turnId: "turn-1" });

  assert.deepEqual(items.map((item) => item.kind), ["explorationBatch", "fileChange"]);
  assert.equal(items[0].turnId, "turn-1");
  assert.equal(items[0].batch.actionIds.length, 3);
  assert.equal(items[1].actionId, "edit");
  assert.equal(items[1].sourceRefs[0].id, "src/three.ts");
});

test("timeline fingerprint is stable across nested and batched rendering", () => {
  const items = projectConversationTimelineItems(projectConversationActivity([
    { id: "note-1", presentation: "note", title: "Inspect parser" },
    readRow("read-1", "run-1", "src/parser.ts"),
    readRow("read-2", "run-1", "src/parser.test.ts"),
    readRow("read-3", "run-1", "src/index.ts"),
  ]));
  const fingerprint = fingerprintConversationTimeline(items);

  assert.deepEqual(fingerprint.itemKinds, ["agentMessage", "explorationBatch", "exploration", "exploration", "exploration"]);
  assert.deepEqual(fingerprint.rendererKeys, ["message.document", "batch.exploration", "fact.exploration", "fact.exploration", "fact.exploration"]);
  assert.equal(fingerprint.disclosureCount, 4);
  assert.equal(fingerprint.itemIds[0], "message:note-1");
});

test("protocol lifecycle records use the shared factual renderer without execution credit", () => {
  const item = {
    id: "protocol:workflow:workflow-1",
    kind: "protocolEvent",
    protocolKind: "workflow",
    revision: 1,
    threadSequence: 4,
    partIndex: 0,
    status: "running",
    sourceRefs: [{ kind: "workflow", id: "workflow-1", visibility: "audit" }],
    title: "Implement transcript",
    description: "Render every surface through one registry.",
  };

  assert.deepEqual(projectConversationTimelineItems([item]), [item]);
  assert.deepEqual(fingerprintConversationTimeline([item]), {
    rendererKeys: ["fact.protocol"],
    itemKinds: ["protocolEvent"],
    itemIds: ["protocol:workflow:workflow-1"],
    disclosureCount: 1,
  });
  assert.equal("actionId" in item, false);
});

test("typed timeline maps agent notes to narrative without treating them as evidence", () => {
  const items = projectConversationTimelineItems([
    { id: "note-1", presentation: "note", title: "Inspect parser", description: "I will inspect the parser first." },
    readRow("read-1", "run-1", "src/parser.ts"),
  ]);

  assert.equal(items[0].kind, "agentMessage");
  assert.equal(items[0].phase, "commentary");
  assert.equal(items[0].markdown, "I will inspect the parser first.");
  assert.equal(items[0].sourceRefs.length, 0);
  assert.equal(items[1].kind, "exploration");
});

test("nested agent projection reuses the same typed child timeline", () => {
  const span = {
    id: "agent-engineer",
    participantId: "engineer",
    label: "Engineer",
    tone: "running",
    rows: [],
  };
  const nested = projectConversationSubAgentActivity(span, [
    { id: "note-1", presentation: "note", title: "Plan", description: "I will inspect the parser." },
    readRow("read-1", "run-1", "src/parser.ts", { participantId: "engineer" }),
  ]);

  assert.equal(nested.kind, "subAgentActivity");
  assert.equal(nested.lifecycle, "running");
  assert.equal(nested.childItems[0].kind, "agentMessage");
  assert.equal(nested.childItems[1].kind, "exploration");
  assert.equal(nested.childItems[1].participantId, "engineer");
});

test("explicit participant lifecycle is not inferred from tone or localized labels", () => {
  for (const [lifecycle, status] of [
    ["started", "pending"], ["running", "running"], ["waiting", "waiting"],
    ["blocked", "blocked"], ["interrupted", "cancelled"],
    ["completed", "succeeded"], ["errored", "failed"],
  ]) {
    const item = projectConversationSubAgentActivity({ id: "owned-agent", label: "Engineer",
      lifecycle, stateLabel: "source label only", tone: "waiting", rows: [],
    }, [readRow("owned-read", "owned-run", "owned.txt", { participantId: "owned-agent" })]);
    assert.equal(item.lifecycle, lifecycle);
    assert.equal(item.status, status);
    assert.equal(item.stateLabel, "source label only");
  }
});

test("legacy child projection converts a third-level participant into a blocked diagnostic", () => {
  const nestedAgent = {
    id: "sub-agent:researcher",
    kind: "subAgentActivity",
    revision: 1,
    threadSequence: 2,
    partIndex: 0,
    status: "succeeded",
    participantId: "researcher",
    workflowStepId: null,
    sourceRefs: [{ kind: "participant_span", id: "span-researcher" }],
    label: "Researcher",
    lifecycle: "completed",
    childItems: [],
  };
  const projected = projectConversationSubAgentActivity({
    id: "agent-qa",
    participantId: "qa",
    label: "QA",
    rows: [],
    tone: "running",
    sourceRefs: [{ kind: "participant_span", id: "span-qa" }],
  }, [nestedAgent]);

  assert.equal(projected.childItems[0].kind, "diagnostic");
  assert.equal(projected.childItems[0].code, "nested_depth_exceeded");
  assert.equal(projected.childItems[0].status, "blocked");
  assert.equal(projected.childItems[0].sourceRefs[0].id, "span-researcher");
});

test("typed timeline prefers action type over legacy row kind", () => {
  const items = projectConversationTimelineItems([
    {
      id: "edit-row",
      kind: "read",
      title: "Update settings",
      operationExecution: operationExecution("edit-1", "run-1", "edit", "succeeded", [fileRef("src/settings.ts")]),
    },
    {
      id: "mcp-row",
      title: "Fetch issue metadata",
      operationExecution: operationExecution("mcp-1", "run-1", "mcp_tool_call", "succeeded", [{ kind: "mcp_tool", id: "issues.get" }]),
    },
    {
      id: "plan-row",
      title: "Implementation plan",
      operationExecution: operationExecution("plan-1", "run-1", "plan", "succeeded"),
    },
    {
      id: "delegate-row",
      title: "Delegate verification",
      operationExecution: operationExecution("delegate-1", "run-1", "spawn_agent", "succeeded", [{ kind: "participant", id: "qa" }]),
    },
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["fileChange", "mcpToolCall", "plan", "collabAgentToolCall"]);
});

test("legacy action adapters preserve bounded runtime diagnostics as failed facts", () => {
  const runtimeDiagnostic = {
    code: "execution_loop_detected", loopKind: "cycle", repeatedCount: 3,
    noProgressActionCount: 8, cycleLength: 2, fingerprint: "c".repeat(64), retryable: false,
  };
  const [item] = projectConversationTimelineItems([{
    id: "loop-row",
    kind: "watch",
    title: "execution_loop_detected",
    description: "Execution stopped after repeated activity produced no new evidence.",
    tone: "failed",
    operationExecution: operationExecution("loop-1", "run-1", "runtime_diagnostic", "failed", [conversationItemRef("loop-1")], { runtimeDiagnostic }),
  }]);

  assert.equal(item.kind, "diagnostic");
  assert.equal(item.status, "failed");
  assert.equal(item.code, "execution_loop_detected");
  assert.equal(item.actionId, "loop-1");
  assert.deepEqual(item.runtimeDiagnostic, runtimeDiagnostic);
});

test("typed timeline fail-closes malformed rows without crashing the feed", () => {
  const items = projectConversationTimelineItems([null, { id: "missing-title" }, {
    id: "unsafe-source",
    title: "Read file",
    operationExecution: {
      ...operationExecution("read-unsafe", "run-1", "read", "succeeded"),
      sourceRefs: [null, { kind: "file", id: "src/safe.ts" }, { kind: 42, id: "bad" }],
    },
  }]);

  assert.equal(items[0].kind, "diagnostic");
  assert.equal(items[0].status, "blocked");
  assert.equal(items[1].kind, "diagnostic");
  assert.equal(items[2].kind, "diagnostic");
  assert.deepEqual(items[2].sourceRefs, [{ kind: "file", id: "src/safe.ts" }]);
});

test("typed timeline can be projected again without changing identity", () => {
  const first = projectConversationTimelineItems([
    { id: "note-1", presentation: "note", title: "Check output" },
  ]);
  const second = projectConversationTimelineItems(first);

  assert.equal(second[0].kind, "agentMessage");
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[0].revision, first[0].revision);
});

test("typed timeline keeps command output totals on the atomic row", () => {
  const row = commandRow("command-output", "run-1", "node verify.mjs", 12, {
    timedOut: true,
    outputByteCount: 42,
    outputLineCount: 3,
    stdoutArtifactId: "stdout-artifact",
    stderrArtifactId: "stderr-artifact",
    resultArtifactId: "result-artifact",
  });
  const [item] = projectConversationTimelineItems([row]);

  assert.equal(item.kind, "commandExecution");
  assert.equal(item.timedOut, true);
  assert.equal(item.outputByteCount, 42);
  assert.equal(item.outputLineCount, 3);
  assert.equal(item.stdoutArtifactId, "stdout-artifact");
  assert.equal(item.stderrArtifactId, "stderr-artifact");
  assert.equal(item.resultArtifactId, "result-artifact");
});

test("timeline replay rejects stale revisions and preserves current order", () => {
  const current = projectConversationTimelineItems([
    { id: "note-a", presentation: "note", title: "A" },
    { id: "note-b", presentation: "note", title: "B" },
  ]);
  const newer = { ...current[1], revision: current[1].revision + 1, markdown: "B updated" };
  const merged = mergeConversationTimelineItems(current, [newer, current[0]]);

  assert.deepEqual(merged.map((item) => item.id), ["message:note-b", "message:note-a"]);
  assert.equal(merged[0].revision, newer.revision);
  assert.equal(merged[0].kind, "agentMessage");
  assert.equal(merged[1].revision, current[0].revision);
});

test("timeline normalization ignores untyped replay payloads", () => {
  const projected = projectConversationTimelineItems([
    { id: "note-a", presentation: "note", title: "A" },
  ]);
  const normalized = normalizeConversationTimelineItems([projected[0], null, { id: "bad", kind: "agentMessage" }]);
  assert.deepEqual(normalized.map((item) => item.id), [projected[0].id]);
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
      revision: overrides.revision,
      toolCallId: "toolCallId" in overrides ? overrides.toolCallId : `tool-${id}`,
      runId,
      attemptId: overrides.attemptId ?? (runId ? `attempt-${runId}` : undefined),
      approvalId: overrides.approvalId,
      turnRunRole: overrides.turnRunRole ?? "primary",
      participantId: overrides.participantId ?? "primary",
      actionType: overrides.actionType ?? "bash",
      risk: overrides.risk ?? "low",
      status,
      commandText,
      durationMs,
      exitCode,
      timedOut: overrides.timedOut,
      latestEventSeq: 1,
      outputByteCount: overrides.outputByteCount,
      outputLineCount: overrides.outputLineCount,
      stdoutArtifactId: overrides.stdoutArtifactId,
      stderrArtifactId: overrides.stderrArtifactId,
      resultArtifactId: overrides.resultArtifactId,
      outputTruncated: false,
      sourceRefs: overrides.sourceRefs ?? [conversationItemRef(id), { kind: "command", id: commandText, label: commandText }],
    },
  };
}

function readRow(id, runId, path, overrides = {}) {
  return operationRow(id, runId, "read", "succeeded", "sourceRefs" in overrides ? overrides.sourceRefs : [fileRef(path), conversationItemRef(id)], overrides);
}

function operationRow(id, runId, actionType, status, sourceRefs = [], overrides = {}) {
  return {
    id: `row-${id}`,
    title: `${actionType} ${id}`,
    operationExecution: operationExecution(id, runId, actionType, status,
      sourceRefs.length > 0 && !sourceRefs.some((ref) => ref?.kind === "conversation_item")
        ? [...sourceRefs, conversationItemRef(id)]
        : sourceRefs,
      overrides),
  };
}

function operationExecution(actionId, runId, actionType, status, sourceRefs = [], overrides = {}) {
  const anchoredSourceRefs = sourceRefs.length > 0 && !sourceRefs.some((ref) => ref?.kind === "conversation_item")
    ? [...sourceRefs, conversationItemRef(actionId)]
    : sourceRefs;
  return {
    actionId,
    runId,
    attemptId: overrides.attemptId ?? (runId ? `attempt-${runId}` : undefined),
    approvalId: overrides.approvalId,
    turnRunRole: overrides.turnRunRole ?? "primary",
    participantId: overrides.participantId ?? "primary",
    actionType,
    status,
    sourceRefs: anchoredSourceRefs,
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function conversationItemRef(id) {
  return { kind: "conversation_item", id: `item-${id}` };
}

function fileRef(path) {
  return { kind: "file", id: path, label: path };
}
