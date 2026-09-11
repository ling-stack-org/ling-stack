import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeCanonicalTranscriptInputs,
  projectCanonicalConversationTimeline,
  batchCanonicalTranscriptItems,
  expandDisplayBatch,
  projectDisplayBatches,
} from "../dist/index.js";

const scope = {
  surface: "normal",
  threadId: "thread-1",
  workspaceId: "workspace-1",
  depth: 0,
};

test("unhydrated user-input references never become messages, commands or terminal evidence", () => {
  const result = projectCanonicalConversationTimeline({ scope, sourceSequence: 2, sourceRevision: "user-input-1",
    items: [item("question", 1, "user_input_request", { requestId: "request-1", requestVersion: 1 }),
      item("answer", 2, "user_input_answer", { requestId: "request-1", requestVersion: 1, answerId: "answer-1" })],
    actions: [], turnRuns: [] });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.terminalEvidence, []);
  assert.deepEqual(result.diagnostics, []);
});

const childScope = { ...scope, surface: "child", depth: 1, turnId: "turn-1", runId: "run-1", attemptId: "attempt-1", participantId: "qa" };
const childMessage = () => ({
  ...item("child-message", 1, "assistant_message", { body: "Inspecting the result.", deliveryStatus: "ready", presentationRole: "narration" }),
  turnId: "turn-1", actorType: "teammate", actorId: "qa", domainRefs: [{ type: "run", id: "run-1" }],
});
const childInput = (message, overrides = {}) => ({
  scope: childScope, sourceSequence: 2, sourceRevision: "child-scope", items: [message, item("child-tool", 2, "tool_call", { toolName: "bash", toolCallId: "child-call" })],
  actions: [action("child-action", 1, { participantId: "qa", toolCallId: "child-call", sourceRefs: [conversationRef("child-tool")] })],
  turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }], ...overrides,
});

test("child canonical narration keeps exact run, attempt, participant and commentary phase", () => {
  const result = projectCanonicalConversationTimeline(childInput(childMessage()));
  const message = result.items.find((entry) => entry.kind === "agentMessage");
  assert.ok(message);
  assert.equal(message.runId, "run-1");
  assert.equal(message.attemptId, "attempt-1");
  assert.equal(message.participantId, "qa");
  assert.equal(message.phase, "commentary");
  assert.ok(message.sourceRefs.some((ref) => ref.kind === "run" && ref.id === "run-1"));
});

for (const [name, overrides] of [
  ["another run on the same turn", { domainRefs: [{ type: "run", id: "run-other" }] }],
  ["two run owners", { domainRefs: [{ type: "run", id: "run-1" }, { type: "run", id: "run-other" }] }],
  ["same turn without a run owner", { domainRefs: [] }],
  ["another participant", { actorId: "engineer" }],
  ["another turn", { turnId: "turn-other" }],
]) {
  test(`child scope rejects ${name}`, () => {
    const result = projectCanonicalConversationTimeline(childInput({ ...childMessage(), ...overrides }));
    assert.equal(result.items.some((entry) => entry.kind === "agentMessage"), false);
    assert.ok(result.diagnostics.some((entry) => ["scope_mismatch", "owner_conflict", "missing_lineage"].includes(entry.code)));
  });
}

test("child narration cannot borrow a selected attempt or missing run from its display scope", () => {
  for (const scopeOverride of [{ attemptId: "attempt-other" }, { runId: undefined }, { participantId: undefined }]) {
    const result = projectCanonicalConversationTimeline(childInput(childMessage(), { scope: { ...childScope, ...scopeOverride } }));
    assert.equal(result.items.some((entry) => entry.kind === "agentMessage"), false);
    assert.ok(result.diagnostics.some((entry) => ["scope_mismatch", "missing_lineage"].includes(entry.code)));
  }
});

test("canonical projector keeps messages and action evidence on one source-order spine", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 4,
    sourceRevision: "digest-1",
    items: [
      item("user-1", 1, "user_message", { body: "Inspect the parser", format: "markdown" }),
      item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
      item("result-1", 3, "tool_result", { toolCallId: "call-1", status: "succeeded" }),
      item("assistant-1", 4, "assistant_message", { body: "The parser is healthy.", format: "markdown", streaming: false, deliveryStatus: "ready" }),
    ],
    actions: [action("action-1", 7, {
      toolCallId: "call-1",
      actionType: "bash",
      status: "succeeded",
      sourceRefs: [conversationRef("tool-1"), { kind: "command", id: "pnpm test" }],
      commandEvidence: { command: "pnpm test", latestEventSeq: 7, outputTail: [{ eventSeq: 7, stream: "stdout", text: "ok\\n", redacted: false }], outputTruncated: false, exitCode: 0 },
    })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });

  assert.deepEqual(projection.items.map((entry) => entry.kind), ["userMessage", "commandExecution", "agentMessage"]);
  assert.deepEqual(projection.items.map((entry) => [entry.threadSequence, entry.partIndex]), [[1, 0], [2, 1], [4, 0]]);
  assert.equal(projection.items[1].revision, 7);
  assert.equal(projection.items[1].actionId, "action-1");
  assert.equal(projection.items[1].sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === "tool-1"), true);
  assert.deepEqual(projection.terminalEvidence, [{ actionId: "action-1", runId: "run-1", attemptId: "attempt-1", participantId: "ling", status: "succeeded" }]);
  assert.equal(projection.diagnostics.length, 0);
});

test("canonical command projection preserves Host output totals and artifact identities", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "command-output-totals",
    items: [item("tool-output", 1, "tool_call", { toolCallId: "call-output", toolName: "bash" })],
    actions: [action("action-output", 9, {
      toolCallId: "call-output",
      actionType: "bash",
      status: "succeeded",
      sourceRefs: [conversationRef("tool-output")],
      commandEvidence: {
        command: "node verify.mjs",
        latestEventSeq: 9,
        outputTail: [{ eventSeq: 8, stream: "stdout", text: "ok\n", redacted: false }],
        outputByteCount: 42,
        outputLineCount: 3,
        stdoutArtifactId: "artifact-stdout",
        stderrArtifactId: "artifact-stderr",
        resultArtifactId: "artifact-result",
        outputTruncated: false,
        exitCode: 0,
      },
    })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });

  const command = projection.items[0];
  assert.equal(command.kind, "commandExecution");
  assert.equal(command.outputByteCount, 42);
  assert.equal(command.outputLineCount, 3);
  assert.equal(command.stdoutArtifactId, "artifact-stdout");
  assert.equal(command.stderrArtifactId, "artifact-stderr");
  assert.equal(command.resultArtifactId, "artifact-result");
  assert.equal(command.outputTail[0].text, "ok\n");
});

test("runtime loop evidence renders as one diagnostic and never as Agent narration or successful evidence", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "loop-diagnostic",
    items: [item("user-1", 1, "user_message", { body: "Finish the task" })],
    actions: [action("loop-action", 8, {
      actionType: "runtime_diagnostic",
      status: "failed",
      title: "Repeated execution stopped",
      summary: "Execution stopped after the same action repeated 3 times.",
      sourceRefs: [conversationRef("user-1"), { kind: "run_event", id: "loop-event" }],
      commandEvidence: undefined,
      runtimeDiagnostic: {
        code: "execution_loop_detected", loopKind: "exact_repeat", repeatedCount: 3,
        noProgressActionCount: 2, cycleLength: 1, fingerprint: "a".repeat(64), retryable: false,
      },
    })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });
  const diagnostic = projection.items.find(entry => entry.kind === "diagnostic");
  assert.ok(diagnostic);
  assert.equal(diagnostic.code, "execution_loop_detected");
  assert.equal(diagnostic.status, "failed");
  assert.deepEqual(diagnostic.runtimeDiagnostic, {
    code: "execution_loop_detected", loopKind: "exact_repeat", repeatedCount: 3,
    noProgressActionCount: 2, cycleLength: 1, fingerprint: "a".repeat(64), retryable: false,
  });
  assert.equal(projection.items.some(entry => entry.kind === "agentMessage"), false);
  assert.equal(projection.terminalEvidence.some(entry => entry.status === "succeeded"), false);
  assert.equal(projection.diagnostics.some(entry => entry.message.includes("unsupported action type")), false);
});

for (const [actionType, kind] of [
  ["mcp_tool_call", "mcpToolCall"],
  ["dynamic_tool_call", "dynamicToolCall"],
  ["host_capability", "dynamicToolCall"],
  ["collab_agent_tool_call", "collabAgentToolCall"],
]) {
  for (const status of ["succeeded", "failed"]) {
    test(`canonical ${kind} preserves Host input and ${status} output evidence`, () => {
      const outputText = status === "succeeded" ? '{"text":"实际工具输出"}\n' : "Provider error: request rejected\n";
      const toolEvidence = {
        toolName: "registered_lookup",
        inputSummary: "query=parser · limit=2",
        outputText,
        outputTruncated: true,
        latestEventSeq: 9,
      };
      const projection = projectCanonicalConversationTimeline({
        scope,
        sourceSequence: 1,
        sourceRevision: `${kind}-${status}-output`,
        items: [item("tool-output", 1, "tool_call", { toolCallId: "call-output", toolName: toolEvidence.toolName })],
        actions: [action("action-output", 9, {
          toolCallId: "call-output",
          actionType,
          status,
          summary: "Action summary is not the input or result.",
          sourceRefs: [conversationRef("tool-output")],
          commandEvidence: undefined,
          toolEvidence,
        })],
        turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
      });

      const projected = projection.items[0];
      assert.equal(projected.kind, kind);
      assert.equal(projected.status, status);
      assert.equal(projected.resultSummary, outputText);
      assert.equal(projected.inputSummary, toolEvidence.inputSummary);
      assert.equal(projected.toolName, toolEvidence.toolName);
      assert.equal(projected.outputTruncated, true);
      assert.equal(projection.diagnostics.length, 0);
    });
  }

  test(`canonical ${kind} never invents input or output from an action summary`, () => {
    for (const toolEvidence of [
      undefined,
      { toolName: "registered_lookup", inputSummary: "query=parser", outputTruncated: false, latestEventSeq: 1 },
      { toolName: "registered_lookup", inputSummary: "", outputText: "", outputTruncated: false, latestEventSeq: 1 },
    ]) {
      const projection = projectCanonicalConversationTimeline({
        scope,
        sourceSequence: 1,
        sourceRevision: `${kind}-without-output`,
        items: [item("tool-empty", 1, "tool_call", { toolCallId: "call-empty", toolName: "registered_lookup" })],
        actions: [action("action-empty", 1, {
          toolCallId: "call-empty",
          actionType,
          summary: "Legacy action summary",
          sourceRefs: [conversationRef("tool-empty")],
          commandEvidence: undefined,
          toolEvidence,
        })],
        turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
      });

      const projected = projection.items[0];
      assert.equal(projected.kind, kind);
      assert.equal(projected.resultSummary, toolEvidence?.outputText);
      assert.equal(projected.inputSummary, toolEvidence?.inputSummary);
    }
  });
}

test("canonical projector surfaces rejected lifecycle diagnostics without changing the action row", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "diagnostic-fold",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [action("action-1", 3, {
      toolCallId: "call-1",
      status: "succeeded",
      sourceRefs: [conversationRef("tool-1"), { kind: "run_event", id: "event-start" }, { kind: "run_event", id: "event-end" }],
      diagnostics: [{
        code: "late_event",
        message: "tool_update arrived after the terminal tool_end.",
        sourceRefs: [{ kind: "run_event", id: "event-late" }],
      }],
      commandEvidence: { command: "printf done", latestEventSeq: 2, outputTail: [], outputTruncated: false, exitCode: 0 },
    })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });

  assert.equal(projection.items[0].kind, "commandExecution");
  assert.equal(projection.items[0].sourceRefs.some((ref) => ref.kind === "run_event" && ref.id === "event-end"), true);
  assert.deepEqual(projection.diagnostics.filter((diagnostic) => diagnostic.code === "late_event"), [{
    code: "late_event",
    message: "tool_update arrived after the terminal tool_end.",
    sourceRefs: [{ kind: "run_event", id: "event-late" }],
  }]);
});

test("canonical projector returns atomic facts and leaves display batching to the explicit adapter", () => {
  const inputItems = [
    item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    item("tool-2", 2, "tool_call", { toolCallId: "call-2", toolName: "bash" }),
    item("tool-3", 3, "tool_call", { toolCallId: "call-3", toolName: "bash" }),
  ];
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 3,
    sourceRevision: "atomic-only",
    items: inputItems,
    actions: inputItems.map((record, index) => action(`atomic-${index + 1}`, index + 1, {
      toolCallId: `call-${index + 1}`,
      status: "succeeded",
      sourceRefs: [conversationRef(record.id)],
      commandEvidence: { command: `node task-${index + 1}.js`, latestEventSeq: index + 1, outputTail: [], outputTruncated: false, exitCode: 0 },
    })),
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });

  assert.deepEqual(projection.items.map((entry) => entry.kind), ["commandExecution", "commandExecution", "commandExecution"]);
  assert.equal(projection.items.some((entry) => entry.kind === "commandBatch"), false);
  assert.deepEqual(
    batch(projection.items).map((entry) => entry.kind),
    ["commandBatch"],
  );
});

test("canonical projector selects the newest attempt and keeps the older action auditable", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "digest-2",
    items: [item("user-1", 1, "user_message", { body: "Run checks", format: "plain_text" }), item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [
      action("old-action", 2, { attemptId: "attempt-1", attemptNumber: 1, toolCallId: "call-1", sourceRefs: [conversationRef("tool-1")] }),
      action("new-action", 1, { runId: "run-2", attemptId: "attempt-2", attemptNumber: 2, toolCallId: "call-1", sourceRefs: [conversationRef("tool-1")] }),
    ],
    turnRuns: [
      { runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" },
      { runId: "run-2", turnId: "turn-1", attemptNumber: 2, role: "retry" },
    ],
  });

  assert.deepEqual(projection.items.filter((entry) => entry.actionId).map((entry) => entry.actionId), ["new-action"]);
  assert.deepEqual(projection.auditItems.map((entry) => entry.actionId), ["old-action"]);
  assert.deepEqual(projection.terminalEvidence.map((entry) => entry.actionId), ["new-action"]);
  assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.code === "stale_revision" && diagnostic.message.includes("old-action")), true);
});

test("terminal evidence follows the projected atomic fact instead of trusting a malformed success action", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "digest-blocked-terminal",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [action("command-without-evidence", 4, {
      status: "succeeded",
      sourceRefs: [conversationRef("tool-1")],
      commandEvidence: undefined,
    })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });

  assert.equal(projection.items[0]?.kind, "diagnostic");
  assert.equal(projection.items[0]?.status, "blocked");
  assert.deepEqual(projection.terminalEvidence, [{
    actionId: "command-without-evidence",
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    status: "blocked",
  }]);
});

test("canonical projector rejects duplicate positions instead of ordering by timestamps or ids", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "digest-3",
    items: [
      item("user-a", 1, "user_message", { body: "A", format: "plain_text" }),
      item("user-b", 1, "user_message", { body: "B", format: "plain_text" }),
      item("assistant", 2, "assistant_message", { body: "Answer", format: "plain_text", streaming: false, deliveryStatus: "ready" }),
    ],
    actions: [],
    turnRuns: [],
  });

  assert.deepEqual(projection.items.map((entry) => entry.itemId), ["assistant"]);
  assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.code === "duplicate_sequence"), true);
});

test("canonical projector keeps an anchored malformed action visible but gives it no completion credit", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "digest-4",
    items: [item("user-1", 1, "user_message", { body: "Edit the file", format: "plain_text" }), item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "edit" })],
    actions: [action("edit-1", 1, {
      actionType: "edit",
      status: "succeeded",
      attemptId: undefined,
      sourceRefs: [conversationRef("tool-1"), { kind: "file", id: "src/app.ts", path: "src/app.ts" }],
    })],
    turnRuns: [],
  });

  const blocked = projection.items.find((entry) => entry.id === "action:edit-1");
  assert.equal(blocked?.kind, "diagnostic");
  assert.equal(blocked?.status, "blocked");
  assert.deepEqual(projection.terminalEvidence, []);
  assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.code === "missing_lineage"), true);
});

test("canonical projector reports missing and cross-thread anchors without fabricating rows", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "digest-5",
    items: [item("user-1", 1, "user_message", { body: "Read files", format: "plain_text" })],
    actions: [
      action("missing-anchor", 1, { sourceRefs: [{ kind: "run", id: "run-1" }] }),
      action("cross-thread", 1, { threadId: "thread-other", sourceRefs: [conversationRef("user-1")] }),
    ],
    turnRuns: [],
  });

  assert.deepEqual(projection.items.map((entry) => entry.kind), ["userMessage"]);
  assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.code === "missing_anchor"), true);
  assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.code === "scope_mismatch"), true);
});

test("typed batching folds only adjacent same-scope atomic facts and preserves maximum revision", () => {
  const base = (kind, id, sequence, revision) => ({
    id,
    kind,
    revision,
    threadSequence: sequence,
    partIndex: 1,
    status: "succeeded",
    actionId: id,
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    workflowStepId: null,
    sourceRefs: [conversationRef(`item-${id}`)],
    title: id,
    ...(kind === "commandExecution"
      ? { command: `node ${id}.js`, risk: "low", outputTail: [], outputTruncated: false, exitCode: 0 }
      : { operation: "read", targets: [{ kind: "file", id: `src/${id}.ts` }] }),
  });
  const items = batch([
    base("commandExecution", "c1", 1, 4),
    base("commandExecution", "c2", 2, 8),
    base("commandExecution", "c3", 3, 6),
    { ...base("fileChange", "edit", 4, 20), status: "succeeded" },
    base("commandExecution", "c4", 5, 2),
    base("commandExecution", "c5", 6, 3),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ["commandBatch", "fileChange", "commandExecution", "commandExecution"]);
  assert.equal(items[0].revision, 8);
  assert.deepEqual(items[0].actionIds, ["c1", "c2", "c3"]);
  assert.equal(items[1].actionId, "edit");
});

test("typed batching keeps approval-linked commands atomic even when low-risk and successful", () => {
  const base = (id, sequence, approvalId) => ({
    id,
    kind: "commandExecution",
    revision: sequence,
    threadSequence: sequence,
    partIndex: 1,
    status: "succeeded",
    actionId: id,
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    workflowStepId: null,
    approvalId,
    sourceRefs: [conversationRef(`item-${id}`)],
    title: id,
    command: `node ${id}.js`,
    risk: "low",
    outputTail: [],
    outputTruncated: false,
    exitCode: 0,
  });
  const items = batch([
    base("c1", 1, undefined),
    base("approval-command", 2, "approval-1"),
    base("c2", 3, undefined),
    base("c3", 4, undefined),
    base("c4", 5, undefined),
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["commandExecution", "commandExecution", "commandBatch"]);
  assert.equal(items[1].approvalId, "approval-1");
  assert.deepEqual(items[2].actionIds, ["c2", "c3", "c4"]);
});

test("typed batching does not bridge a canonical sequence gap", () => {
  const base = (id, sequence, partIndex = 1) => ({
    id,
    kind: "commandExecution",
    revision: sequence,
    threadSequence: sequence,
    partIndex,
    status: "succeeded",
    actionId: id,
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    workflowStepId: null,
    sourceRefs: [conversationRef(`item-${id}`)],
    title: id,
    command: `node ${id}.js`,
    risk: "low",
    outputTail: [],
    outputTruncated: false,
    exitCode: 0,
  });
  const items = batch([
    base("c1", 1),
    base("c3", 3),
    base("c4", 4),
    base("c5", 5),
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["commandExecution", "commandBatch"]);
  assert.deepEqual(items[1].actionIds, ["c3", "c4", "c5"]);
});

test("typed batching accepts only contiguous parts on one canonical anchor", () => {
  const base = (id, partIndex) => ({
    id,
    kind: "commandExecution",
    revision: partIndex,
    threadSequence: 7,
    partIndex,
    status: "succeeded",
    actionId: id,
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    workflowStepId: null,
    sourceRefs: [conversationRef(`item-${id}`)],
    title: id,
    command: `node ${id}.js`,
    risk: "low",
    outputTail: [],
    outputTruncated: false,
    exitCode: 0,
  });
  const contiguous = batch([base("p1", 1), base("p2", 2), base("p3", 3)]);
  assert.equal(contiguous[0].kind, "commandBatch");
  const gap = batch([base("p1", 1), base("p3", 3), base("p4", 4), base("p5", 5)]);
  assert.deepEqual(gap.map((item) => item.kind), ["commandExecution", "commandBatch"]);
  assert.deepEqual(gap[1].actionIds, ["p3", "p4", "p5"]);
});

test("typed batching flushes at context segment changes and unknown lookups", () => {
  const base = (id, sequence) => ({
    id,
    kind: "commandExecution",
    revision: sequence,
    threadSequence: sequence,
    partIndex: 1,
    status: "succeeded",
    actionId: id,
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    workflowStepId: null,
    sourceRefs: [conversationRef(`item-${id}`)],
    title: id,
    command: `node ${id}.js`,
    risk: "low",
    outputTail: [],
    outputTruncated: false,
    exitCode: 0,
  });
  const items = [base("c1", 1), base("c2", 2), base("c3", 3), base("c4", 4), base("c5", 5)];
  const split = batch(items, { c1: "segment-a", c2: "segment-a", c3: "segment-b", c4: "segment-b", c5: "segment-b" });
  assert.deepEqual(split.map((item) => item.kind), ["commandExecution", "commandExecution", "commandBatch"]);
  assert.deepEqual(split[2].actionIds, ["c3", "c4", "c5"]);

  const unknown = batchCanonicalTranscriptItems(items, {
    contextSegmentIdByItemId: new Map([["c1", "segment-a"], ["c2", "segment-a"]]),
  });
  assert.deepEqual(unknown.map((item) => item.kind), items.map(() => "commandExecution"));
});

test("typed batching exposes deterministic split reasons without changing the display projection", () => {
  const base = (id, sequence, overrides = {}) => ({
    id,
    kind: "commandExecution",
    revision: sequence,
    threadSequence: sequence,
    partIndex: 1,
    status: "succeeded",
    actionId: id,
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    workflowStepId: null,
    turnRunRole: "primary",
    sourceRefs: [conversationRef(`item-${id}`)],
    title: id,
    command: `node ${id}.js`,
    risk: "low",
    outputTail: [],
    outputTruncated: false,
    exitCode: 0,
    ...overrides,
  });
  const source = [
    base("c1", 1),
    base("c2", 2),
    base("c3", 3),
    base("c4", 4, { participantId: "reviewer" }),
    base("c5", 5, { participantId: "reviewer", attemptId: "attempt-2", turnRunRole: "retry" }),
    base("c6", 6, { participantId: "reviewer", attemptId: "attempt-2", turnRunRole: "retry", workflowStepId: "step-2" }),
    base("c7", 8, { participantId: "reviewer", attemptId: "attempt-2", turnRunRole: "retry", workflowStepId: "step-2" }),
  ];
  const projection = projectDisplayBatches(source, {
    contextSegmentIdByItemId: new Map(source.map((item) => [item.id, "segment-a"])),
  });

  assert.deepEqual(projection.items.map((item) => item.kind), ["commandBatch", "commandExecution", "commandExecution", "commandExecution", "commandExecution"]);
  assert.deepEqual(projection.boundaries.map((boundary) => [boundary.beforeItemId, boundary.reason]), [
    ["c4", "participant"],
    ["c5", "retry"],
    ["c6", "workflow_step"],
    ["c7", "non_adjacent"],
  ]);
  assert.deepEqual(expandDisplayBatch(projection.items[0]).map((item) => item.id), ["c1", "c2", "c3"]);
  assert.deepEqual(expandDisplayBatch(projection.items[1]).map((item) => item.id), ["c4"]);
});

test("typed batching treats missing context as an explicit context boundary", () => {
  const make = (id, sequence) => ({
    id,
    kind: "exploration",
    revision: sequence,
    threadSequence: sequence,
    partIndex: 1,
    status: "succeeded",
    actionId: id,
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    workflowStepId: null,
    sourceRefs: [conversationRef(`item-${id}`)],
    title: id,
    operation: "read",
    targets: [{ kind: "file", id: `${id}.ts` }],
  });
  const source = [make("r1", 1), make("r2", 2), make("r3", 3)];
  const projection = projectDisplayBatches(source);
  assert.deepEqual(projection.items.map((item) => item.kind), ["exploration", "exploration", "exploration"]);
  assert.deepEqual(projection.boundaries.map((boundary) => boundary.reason), ["context_scope", "context_scope"]);
});

test("canonical projector gives multiple evidence facts one persisted anchor ordered part positions", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "digest-parts",
    items: [
      item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
      item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    ],
    actions: [
      action("a-read", 2, { actionType: "read", toolCallId: "call-1", sourceEventSequence: 2, sourceRefs: [conversationRef("tool-1")] }),
      action("a-command", 3, { actionType: "bash", toolCallId: "call-2", sourceEventSequence: 3, sourceRefs: [conversationRef("tool-1")] }),
    ],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });
  const facts = projection.items.filter((entry) => entry.actionId);
  assert.deepEqual(facts.map((entry) => entry.actionId), ["a-read", "a-command"]);
  assert.deepEqual(facts.map((entry) => entry.partIndex), [1, 2]);
  assert.equal(projection.diagnostics.length, 0);
});

test("canonical projector accepts live aggregate cursor changes but fails closed on equal action revisions", () => {
  const base = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "digest-a",
    items: [item("user-1", 1, "user_message", { body: "A", format: "plain_text" })],
    actions: [],
    turnRuns: [],
  });
  const sourceConflict = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "digest-b",
    previousCursor: { sourceSequence: 1, sourceRevision: base.sourceRevision },
    items: [item("user-1", 1, "user_message", { body: "A", format: "plain_text" })],
    actions: [],
    turnRuns: [],
  });
  assert.equal(sourceConflict.items.length, 1);
  assert.equal(sourceConflict.diagnostics.length, 0);

  const equalRevision = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "digest-c",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [
      action("same", 5, { title: "one", sourceRefs: [conversationRef("tool-1")] }),
      action("same", 5, { title: "two", sourceRefs: [conversationRef("tool-1")] }),
    ],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });
  assert.equal(equalRevision.items.some((entry) => entry.actionId === "same"), false);
  assert.equal(equalRevision.diagnostics.some((entry) => entry.code === "owner_conflict"), true);
});

test("canonical projector deterministically orders distinct equal-revision actions on one anchor", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "digest-equal-distinct",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [
      action("same-b", 5, { title: "second", sourceRefs: [conversationRef("tool-1")] }),
      action("same-a", 5, { title: "first", sourceRefs: [conversationRef("tool-1")] }),
    ],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });

  const facts = projection.items.filter((entry) => entry.actionId);
  assert.deepEqual(facts.map((entry) => entry.actionId), ["same-a", "same-b"]);
  assert.deepEqual(facts.map((entry) => entry.partIndex), [1, 2]);
  assert.equal(projection.diagnostics.some((entry) => entry.code === "owner_conflict"), false);
});

test("canonical action order follows immutable start events when earlier output revisions advance", () => {
  const input = {
    scope,
    sourceSequence: 1,
    sourceRevision: "causal-action-order",
    items: [item("user-1", 1, "user_message", { body: "Inspect then write" })],
    actions: [
      action("a-later", 100, { sourceEventSequence: 99 }),
      action("z-earlier", 144, { sourceEventSequence: 49 }),
    ],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  };
  const first = projectCanonicalConversationTimeline(input);
  const refreshed = projectCanonicalConversationTimeline({ ...input, actions: input.actions.map((entry) => ({ ...entry, revision: entry.revision + 50 })) });
  for (const projection of [first, refreshed]) {
    const facts = projection.items.filter((entry) => entry.actionId);
    assert.deepEqual(facts.map((entry) => entry.actionId), ["z-earlier", "a-later"]);
    assert.deepEqual(facts.map((entry) => entry.sourceEventSequence), [49, 99]);
    assert.deepEqual(facts.map((entry) => entry.partIndex), [1, 2]);
  }
});

test("canonical action ordering never treats different run event cursors as a shared clock", () => {
  const input = {
    scope, sourceSequence: 1, sourceRevision: "run-local-cursors",
    items: [item("user-1", 1, "user_message", { body: "Parallel work" })],
    actions: [
      action("a-late", 144, { sourceEventSequence: 99 }),
      action("b-first", 5, { sourceEventSequence: 1, runId: "run-2", attemptId: "attempt-2", participantId: "qa" }),
      action("a-first", 150, { sourceEventSequence: 49 }),
    ],
    turnRuns: [
      { runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" },
      { runId: "run-2", turnId: "turn-1", attemptNumber: 1, role: "primary" },
    ],
  };
  const forward = projectCanonicalConversationTimeline(input);
  const reverse = projectCanonicalConversationTimeline({ ...input, actions: [...input.actions].reverse() });
  assert.deepEqual(forward.items.filter((entry) => entry.actionId).map((entry) => entry.actionId), ["a-first", "a-late", "b-first"]);
  assert.deepEqual(forward.items, reverse.items);
});

test("canonical projector maps approvals, plans, compactions, artifacts, and child spans without creating a second history", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "digest-supplemental",
    items: [
      item("user-1", 1, "user_message", { body: "Ship the change", format: "plain_text" }),
      item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    ],
    actions: [action("delegate-1", 2, { actionType: "delegate_agent", status: "executing", title: "Delegate QA", summary: "Run QA", sourceRefs: [conversationRef("tool-1")], resultArtifactIds: ["image-1"] })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
    approvals: [{
      id: "approval-1", revision: 1, workspaceId: "workspace-1", threadId: "thread-1", runId: "run-1", attemptId: "attempt-1", participantId: "ling", anchorItemId: "tool-1", title: "Allow deploy", status: "pending", sourceRefs: [],
    }],
    plans: [{
      id: "plan-1", revision: 1, workspaceId: "workspace-1", threadId: "thread-1", anchorItemId: "user-1", title: "Ship", steps: [{ id: "step-1", text: "Run QA", status: "running" }], sourceRefs: [conversationRef("user-1")],
    }],
    compactions: [{
      id: "compact-1", revision: 1, workspaceId: "workspace-1", threadId: "thread-1", anchorItemId: "user-1", summary: "Earlier context summarized", sourceRefs: [conversationRef("user-1")],
    }],
    artifacts: [{
      id: "image-1", revision: 1, workspaceId: "workspace-1", threadId: "thread-1", anchorItemId: "tool-1", type: "image", path: "artifacts/result.png", title: "Result", sourceRefs: [conversationRef("tool-1"), { kind: "run_event", id: "event-image" }],
    }],
    participantSpans: [{
      id: "span-1", revision: 1, workspaceId: "workspace-1", threadId: "thread-1", anchorItemId: "tool-1", parentActionId: "delegate-1", participantId: "qa", label: "QA", lifecycle: "running", sourceRefs: [conversationRef("tool-1")], childItems: [],
    }],
  });

  assert.deepEqual(projection.items.map((entry) => entry.kind), [
    "userMessage", "plan", "contextCompaction", "collabAgentToolCall", "approval", "subAgentActivity", "imageView",
  ]);
  assert.equal(projection.items.find((entry) => entry.kind === "approval")?.status, "waiting");
  assert.equal(projection.items.find((entry) => entry.kind === "imageView")?.sourceRefs.some((ref) => ref.kind === "artifact"), true);
  assert.equal(projection.activeItemId, "sub-agent:span-1");
});

test("canonical projector blocks a nested child Agent instead of creating a third timeline", () => {
  const nestedChild = {
    id: "sub-agent:qa:researcher",
    kind: "subAgentActivity",
    revision: 3,
    threadSequence: 2,
    partIndex: 0,
    status: "succeeded",
    itemId: "tool-1",
    actionId: "delegate-qa",
    runId: "run-qa",
    attemptId: "attempt-qa",
    participantId: "researcher",
    workflowStepId: null,
    sourceRefs: [conversationRef("tool-1"), { kind: "participant_span", id: "span-researcher" }],
    label: "Researcher",
    lifecycle: "completed",
    childItems: [],
  };
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "nested-depth",
    items: [
      item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
      item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "spawn_agent" }),
    ],
    actions: [action("delegate-1", 1, {
      actionType: "delegate_agent",
      status: "succeeded",
      sourceRefs: [conversationRef("tool-1")],
    })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
    participantSpans: [{
      id: "span-qa",
      revision: 1,
      workspaceId: "workspace-1",
      threadId: "thread-1",
      anchorItemId: "tool-1",
      parentActionId: "delegate-1",
      participantId: "qa",
      label: "QA",
      runId: "run-qa",
      attemptId: "attempt-qa",
      workflowStepId: null,
      lifecycle: "completed",
      sourceRefs: [conversationRef("tool-1"), { kind: "participant_span", id: "span-qa" }],
      childItems: [nestedChild],
    }],
  });

  const child = projection.items.find((entry) => entry.kind === "subAgentActivity");
  assert.equal(child?.childItems.length, 1);
  assert.equal(child?.childItems[0]?.kind, "diagnostic");
  assert.equal(child?.childItems[0]?.code, "nested_depth_exceeded");
  assert.equal(child?.childItems[0]?.status, "blocked");
  assert.equal(child?.childItems[0]?.sourceRefs.some((ref) => ref.kind === "participant_span" && ref.id === "span-researcher"), true);
  assert.equal(projection.items.some((entry) => entry.id === "sub-agent:qa:researcher"), false);
});

test("canonical projector keeps an anchored actionless artifact blocked and out of completion evidence", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "digest-artifact-blocked",
    items: [item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" })],
    actions: [],
    turnRuns: [],
    artifacts: [{
      id: "file-1", revision: 1, workspaceId: "workspace-1", threadId: "thread-1", anchorItemId: "user-1", type: "file", path: "src/app.ts", sourceRefs: [conversationRef("user-1")],
    }],
  });
  assert.equal(projection.items.find((entry) => entry.id === "artifact:file-1")?.kind, "diagnostic");
  assert.equal(projection.items.find((entry) => entry.id === "artifact:file-1")?.status, "blocked");
  assert.deepEqual(projection.terminalEvidence, []);
});

test("canonical projector is deterministic when supplemental records arrive in a different order", () => {
  const approvals = [
    { id: "approval-b", revision: 1, workspaceId: "workspace-1", threadId: "thread-1", runId: "run-1", attemptId: "attempt-1", participantId: "ling", anchorItemId: "tool-1", title: "Allow B", status: "pending", sourceRefs: [conversationRef("tool-1")] },
    { id: "approval-a", revision: 1, workspaceId: "workspace-1", threadId: "thread-1", runId: "run-1", attemptId: "attempt-1", participantId: "ling", anchorItemId: "tool-1", title: "Allow A", status: "pending", sourceRefs: [conversationRef("tool-1")] },
  ];
  const base = {
    scope,
    sourceSequence: 2,
    sourceRevision: "same-digest",
    items: [item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }), item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [],
    turnRuns: [],
  };
  const forward = projectCanonicalConversationTimeline({ ...base, approvals });
  const reversed = projectCanonicalConversationTimeline({ ...base, approvals: [...approvals].reverse() });
  assert.deepEqual(reversed.items, forward.items);
  assert.deepEqual(reversed.terminalEvidence, forward.terminalEvidence);
  assert.deepEqual(forward.items.filter((entry) => entry.kind === "approval").map((entry) => entry.id), ["approval:approval-a", "approval:approval-b"]);
});

test("terminal evidence includes every atomic terminal state and ignores display batches", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 4,
    sourceRevision: "terminal-states",
    items: [
      item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
      item("tool-2", 2, "tool_call", { toolCallId: "call-2", toolName: "bash" }),
      item("tool-3", 3, "tool_call", { toolCallId: "call-3", toolName: "bash" }),
      item("tool-4", 4, "tool_call", { toolCallId: "call-4", toolName: "bash" }),
    ],
    actions: [
      action("succeeded", 1, { toolCallId: "call-1", status: "succeeded", sourceRefs: [conversationRef("tool-1")] }),
      action("failed", 2, { toolCallId: "call-2", status: "failed", sourceRefs: [conversationRef("tool-2")] }),
      action("cancelled", 3, { toolCallId: "call-3", status: "cancelled", sourceRefs: [conversationRef("tool-3")] }),
      action("blocked", 4, { toolCallId: "call-4", status: "blocked", sourceRefs: [conversationRef("tool-4")] }),
    ],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });
  assert.deepEqual(
    projection.terminalEvidence.map(({ actionId, status }) => [actionId, status]),
    [["succeeded", "succeeded"], ["failed", "failed"], ["cancelled", "cancelled"], ["blocked", "blocked"]],
  );
  assert.equal(projection.items.some((entry) => entry.kind === "commandBatch"), false);
});

test("terminal evidence does not treat supplemental approvals or participant spans as action completion", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 2,
    sourceRevision: "supplemental-not-terminal",
    items: [
      item("user-1", 1, "user_message", { body: "Deploy", format: "plain_text" }),
      item("tool-1", 2, "assistant_message", { body: "Please approve", format: "plain_text", streaming: false, deliveryStatus: "ready" }),
    ],
    actions: [],
    turnRuns: [],
    approvals: [{
      id: "approval-1", revision: 1, workspaceId: "workspace-1", threadId: "thread-1",
      runId: "run-1", attemptId: "attempt-1", participantId: "ling", anchorItemId: "tool-1",
      title: "Allow deploy", status: "approved", sourceRefs: [conversationRef("tool-1")],
    }],
    participantSpans: [{
      id: "span-1", revision: 1, workspaceId: "workspace-1", threadId: "thread-1",
      anchorItemId: "tool-1", participantId: "qa", label: "QA", runId: "run-qa",
      attemptId: "attempt-qa", lifecycle: "completed", sourceRefs: [conversationRef("tool-1")], childItems: [],
    }],
  });
  assert.deepEqual(projection.items.map((entry) => entry.kind), ["userMessage", "agentMessage", "approval", "subAgentActivity"]);
  assert.deepEqual(projection.terminalEvidence, []);
});

test("unknown succeeded actions become blocked evidence and never claim success", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "unknown-succeeded",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "future_tool" })],
    actions: [action("future-1", 1, {
      actionType: "future_tool",
      status: "succeeded",
      sourceRefs: [conversationRef("tool-1")],
    })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });
  assert.equal(projection.items[0]?.kind, "diagnostic");
  assert.equal(projection.items[0]?.status, "blocked");
  assert.deepEqual(projection.terminalEvidence, [{
    actionId: "future-1",
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    status: "blocked",
  }]);
});

test("canonical input merge is order-independent for reconnect and reordered deltas", () => {
  const initial = {
    scope,
    sourceSequence: 2,
    sourceRevision: "snapshot-2",
    items: [
      item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
      item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    ],
    actions: [action("run-1", 2, { revision: 2, sourceRefs: [conversationRef("tool-1")] })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  };
  const update = {
    ...initial,
    sourceRevision: "snapshot-3",
    actions: [action("run-1", 3, { revision: 3, title: "Run command", sourceRefs: [{ id: "tool-1", kind: "conversation_item" }] })],
  };
  const forward = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(initial, update));
  const reversed = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(update, initial));
  assert.deepEqual(reversed.items, forward.items);
  assert.deepEqual(reversed.auditItems, forward.auditItems);
  assert.deepEqual(reversed.terminalEvidence, forward.terminalEvidence);
  assert.deepEqual(reversed.diagnostics, forward.diagnostics);
  assert.equal(forward.items.find((entry) => entry.actionId === "run-1")?.revision, 3);
  assert.equal(forward.sourceRevision, "snapshot-3");
});

test("canonical input merge ignores lower revisions but rejects equal-revision payload conflicts", () => {
  const base = {
    scope,
    sourceSequence: 1,
    sourceRevision: "base",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [action("run-1", 4, { revision: 4, sourceRefs: [conversationRef("tool-1")] })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  };
  const stale = { ...base, actions: [action("run-1", 2, { revision: 2, title: "stale", sourceRefs: [conversationRef("tool-1")] })] };
  const staleProjection = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(base, stale));
  assert.equal(staleProjection.items.find((entry) => entry.actionId === "run-1")?.revision, 4);

  const equalConflict = { ...base, actions: [action("run-1", 4, { revision: 4, title: "conflicting", sourceRefs: [conversationRef("tool-1")] })] };
  const conflictProjection = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(base, equalConflict));
  assert.equal(conflictProjection.items.some((entry) => entry.actionId === "run-1"), false);
  assert.equal(conflictProjection.diagnostics.some((entry) => entry.code === "owner_conflict"), true);
});

test("stable payload equality does not depend on object key order", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "stable-equality",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [
      action("run-1", 4, { revision: 4, sourceRefs: [conversationRef("tool-1")], commandEvidence: { command: "node -v", latestEventSeq: 4, outputTail: [], outputTruncated: false } }),
      action("run-1", 4, { revision: 4, sourceRefs: [conversationRef("tool-1")], commandEvidence: { outputTruncated: false, outputTail: [], latestEventSeq: 4, command: "node -v" } }),
    ],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });
  assert.equal(projection.items.filter((entry) => entry.actionId === "run-1").length, 1);
  assert.equal(projection.diagnostics.some((entry) => entry.code === "owner_conflict"), false);
});

test("reasoning summaries reconcile stale and equal revisions without entering terminal evidence", () => {
  const anchor = { ...item("assistant-summary", 3, "assistant_message", { body: "Done", format: "markdown", streaming: false, deliveryStatus: "ready" }),
    turnId: "turn-1", domainRefs: [{ type: "run", id: "run-1" }] };
  const base = { scope, sourceSequence: 3, sourceRevision: "reasoning-v2", items: [anchor], actions: [],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
    reasoningSummaries: [reasoningSummary(2, "Newest safe summary")] };
  const stale = { ...base, sourceRevision: "reasoning-v1", reasoningSummaries: [reasoningSummary(1, "Stale safe summary")] };
  const forward = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(base, stale));
  const reversed = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(stale, base));
  assert.deepEqual(reversed.items, forward.items);
  assert.equal(forward.items.find((entry) => entry.kind === "reasoning")?.summary, "Newest safe summary");
  assert.deepEqual(forward.terminalEvidence, []);

  const conflict = { ...base, sourceRevision: "reasoning-conflict", reasoningSummaries: [reasoningSummary(2, "Conflicting safe summary")] };
  const rejected = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(base, conflict));
  assert.equal(rejected.items.some((entry) => entry.kind === "reasoning"), false);
  assert.equal(rejected.diagnostics.some((entry) => entry.code === "owner_conflict"), true);
  assert.deepEqual(rejected.terminalEvidence, []);
});

test("child reasoning requires exact run participant and attempt lineage", () => {
  const anchor = { ...item("child-summary", 4, "assistant_message", { body: "Child done", format: "markdown", streaming: false, deliveryStatus: "ready" }),
    turnId: "turn-1", actorType: "teammate", actorId: "qa", domainRefs: [{ type: "run", id: "run-1" }] };
  const valid = reasoningSummary(3, "Checked by QA", { participantId: "qa", attemptId: "attempt-1", anchorItemId: anchor.id });
  const projected = projectCanonicalConversationTimeline({ scope: childScope, sourceSequence: 4, sourceRevision: "child-reasoning",
    items: [anchor], actions: [], turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }], reasoningSummaries: [valid] });
  assert.equal(projected.items.find((entry) => entry.kind === "reasoning")?.summary, "Checked by QA");
  assert.deepEqual(projected.terminalEvidence, []);

  for (const mismatch of [{ runId: "other-run" }, { participantId: "engineer" }, { attemptId: "other-attempt" }]) {
    const result = projectCanonicalConversationTimeline({ scope: childScope, sourceSequence: 4, sourceRevision: JSON.stringify(mismatch),
      items: [anchor], actions: [], turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
      reasoningSummaries: [{ ...valid, ...mismatch }] });
    assert.equal(result.items.some((entry) => entry.kind === "reasoning"), false);
    assert.ok(result.diagnostics.some((entry) => ["scope_mismatch", "missing_lineage"].includes(entry.code)));
  }
});

test("canonical input merge is order-independent for reconnect and reordered deltas", () => {
  const initial = {
    scope,
    sourceSequence: 2,
    sourceRevision: "snapshot-2",
    items: [
      item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
      item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    ],
    actions: [action("run-1", 2, { revision: 2, sourceRefs: [conversationRef("tool-1")] })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  };
  const update = {
    ...initial,
    sourceRevision: "snapshot-3",
    actions: [action("run-1", 3, { revision: 3, title: "Run command", sourceRefs: [{ id: "tool-1", kind: "conversation_item" }] })],
  };
  const forward = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(initial, update));
  const reversed = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(update, initial));
  assert.deepEqual(reversed.items, forward.items);
  assert.deepEqual(reversed.auditItems, forward.auditItems);
  assert.deepEqual(reversed.terminalEvidence, forward.terminalEvidence);
  assert.deepEqual(reversed.diagnostics, forward.diagnostics);
  assert.equal(forward.items.find((entry) => entry.actionId === "run-1")?.revision, 3);
  assert.equal(forward.sourceRevision, "snapshot-3");
});

test("canonical input merge ignores lower revisions but rejects equal-revision payload conflicts", () => {
  const base = {
    scope,
    sourceSequence: 1,
    sourceRevision: "base",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [action("run-1", 4, { revision: 4, sourceRefs: [conversationRef("tool-1")] })],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  };
  const stale = { ...base, actions: [action("run-1", 2, { revision: 2, title: "stale", sourceRefs: [conversationRef("tool-1")] })] };
  const staleProjection = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(base, stale));
  assert.equal(staleProjection.items.find((entry) => entry.actionId === "run-1")?.revision, 4);

  const equalConflict = { ...base, actions: [action("run-1", 4, { revision: 4, title: "conflicting", sourceRefs: [conversationRef("tool-1")] })] };
  const conflictProjection = projectCanonicalConversationTimeline(mergeCanonicalTranscriptInputs(base, equalConflict));
  assert.equal(conflictProjection.items.some((entry) => entry.actionId === "run-1"), false);
  assert.equal(conflictProjection.diagnostics.some((entry) => entry.code === "owner_conflict"), true);
});

test("stable payload equality does not depend on object key order", () => {
  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "stable-equality",
    items: [item("tool-1", 1, "tool_call", { toolCallId: "call-1", toolName: "bash" })],
    actions: [
      action("run-1", 4, { revision: 4, sourceRefs: [conversationRef("tool-1")], commandEvidence: { command: "node -v", latestEventSeq: 4, outputTail: [], outputTruncated: false } }),
      action("run-1", 4, { revision: 4, sourceRefs: [conversationRef("tool-1")], commandEvidence: { outputTruncated: false, outputTail: [], latestEventSeq: 4, command: "node -v" } }),
    ],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });
  assert.equal(projection.items.filter((entry) => entry.actionId === "run-1").length, 1);
  assert.equal(projection.diagnostics.some((entry) => entry.code === "owner_conflict"), false);
});

function item(id, sequence, kind, payload) {
  return {
    id,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    sequence,
    kind,
    status: "committed",
    actorType: kind === "user_message" ? "local_user" : "ling_agent",
    revision: 1,
    payload,
  };
}

function action(id, revision, overrides = {}) {
  return {
    id,
    revision,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    turnId: "turn-1",
    runId: "run-1",
    attemptId: "attempt-1",
    attemptNumber: 1,
    turnRunRole: "primary",
    participantId: "ling",
    actionType: "bash",
    risk: "low",
    status: "succeeded",
    title: "Run command",
    summary: "Verified the change.",
    sourceRefs: [conversationRef("user-1")],
    commandEvidence: { command: "pnpm test", latestEventSeq: revision, outputTail: [], outputTruncated: false, exitCode: 0 },
    ...overrides,
  };
}

function conversationRef(id) {
  return { kind: "conversation_item", id };
}

function reasoningSummary(revision, text, overrides = {}) {
  const runId = overrides.runId ?? "run-1";
  const anchorItemId = overrides.anchorItemId ?? "assistant-summary";
  const attemptId = overrides.attemptId ?? "attempt-1";
  const participantId = overrides.participantId ?? "ling";
  const eventId = `reasoning-event-${revision}`;
  return {
    id: "reasoning-summary-1", revision, workspaceId: "workspace-1", threadId: "thread-1", turnId: "turn-1",
    runId, attemptId, participantId,
    anchorItemId, eventId, eventSequence: revision, text, parts: [text], semantic: "safe_summary", source: "openai_responses",
    truncated: false, sourceRefs: [conversationRef(anchorItemId), { kind: "run", id: runId }, { kind: "run_event", id: eventId },
      { kind: "attempt", id: attemptId }, { kind: "participant", id: participantId }],
  };
}

function batch(items, segments) {
  const contextSegmentIdByItemId = new Map(items.map((item) => [item.id, segments?.[item.id] ?? "segment-test"]));
  return batchCanonicalTranscriptItems(items, { contextSegmentIdByItemId });
}
