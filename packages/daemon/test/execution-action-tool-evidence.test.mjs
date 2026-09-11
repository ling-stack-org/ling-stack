import assert from "node:assert/strict";
import test from "node:test";
import { listExecutionActions } from "../dist/features/runs/execution-actions.js";

function event(seq, type, data) {
  return { id: `event-${seq}`, runId: "run-tool", seq, type, ts: `2026-09-05T00:00:${String(seq).padStart(2, "0")}.000Z`, data };
}

function actionFor(events, approvals = []) {
  const run = { id: "run-tool", cwd: "/repo", status: "running", createdAt: events[0].ts, updatedAt: events.at(-1).ts };
  return listExecutionActions({
    getRun: () => run, listRuns: () => [run], listApprovalRequests: () => approvals,
    listArtifacts: () => [],
    listEvents: () => events,
  }, { runId: run.id, complete: true })[0];
}

function toolEvent(seq, type, data = {}) {
  return event(seq, type, { toolCallId: "read-1", toolName: "read", ...data });
}

test("loop detection projects a distinct failed runtime diagnostic with atomic lineage", () => {
  const events = [event(7, "loop_detected", {
    code: "execution_loop_detected", attemptId: "attempt-loop", loopKind: "cycle",
    observedEventType: "tool_end", observedEventSeq: 6, repeatedCount: 3,
    noProgressActionCount: 4, cycleLength: 2, fingerprint: "a".repeat(64),
    message: "Execution stopped after a 2-action cycle repeated 3 times.", retryable: false,
  })];
  const run = { id: "run-tool", cwd: "/repo", status: "failed", workUnitId: "unit-loop",
    workflowStepId: "step-loop", teammateId: "engineer", threadId: "thread-loop",
    createdAt: events[0].ts, updatedAt: events[0].ts };
  const [action] = listExecutionActions({
    getRun: () => run, listRuns: () => [run], listApprovalRequests: () => [],
    listArtifacts: () => [], listEvents: () => events,
  }, { runId: run.id, complete: true });
  assert.equal(action.actionType, "runtime_diagnostic");
  assert.equal(action.status, "failed");
  assert.equal(action.attemptId, "attempt-loop");
  assert.equal(action.participantId, "engineer");
  assert.equal(action.workflowStepId, "step-loop");
  assert.equal(action.runtimeDiagnostic.code, "execution_loop_detected");
  assert.equal(action.runtimeDiagnostic.retryable, false);
  assert.deepEqual(action.sourceRefs.filter(ref => ["run_event", "attempt", "workflow_step"].includes(ref.kind)).map(ref => ref.kind).sort(),
    ["attempt", "run_event", "workflow_step"]);
});

test("failed read keeps exact target and actual error, not a generic tool-call label", () => {
  const action = actionFor([
    toolEvent(1, "tool_start", { args: { path: "morning-todo/todo.test.mjs" } }),
    toolEvent(2, "tool_end", { isError: true, result: { content: [{ type: "text", text: "ENOENT: no such file, morning-todo/todo.test.mjs" }] } }),
  ]);
  assert.equal(action.summary, "morning-todo/todo.test.mjs");
  assert.equal(action.sourceEventSequence, 1);
  assert.equal(action.status, "failed");
  assert.ok(action.sourceRefs.some(ref => ref.kind === "file" && ref.path === "morning-todo/todo.test.mjs"));
  assert.equal(action.toolEvidence.outputText, "ENOENT: no such file, morning-todo/todo.test.mjs");
  assert.equal(action.toolEvidence.latestEventSeq, 2);
  assert.equal(action.toolEvidence.outputTruncated, false);
});

test("read output updates in place and excludes stale or late lifecycle evidence", () => {
  const before = toolEvent(1, "tool_update", { partialResult: { content: [{ type: "text", text: "stale" }] } });
  const start = toolEvent(2, "tool_start", { args: { path: "README.md" } });
  const update = toolEvent(3, "tool_update", { partialResult: { content: [{ type: "text", text: "first line\nsecond line" }] } });
  const live = actionFor([before, start, update]);
  assert.equal(live.toolEvidence.outputText, "first line\nsecond line");
  assert.equal(live.toolEvidence.latestEventSeq, 3);
  const end = toolEvent(4, "tool_end", { result: { content: [{ type: "text", text: "final content" }] } });
  const late = toolEvent(5, "tool_update", { partialResult: { text: "late" } });
  const duplicate = toolEvent(6, "tool_end", { isError: true, result: { content: [{ type: "text", text: "conflicting end" }] } });
  const terminal = actionFor([duplicate, late, start, end, update, before]);
  assert.equal(terminal.id, live.id);
  assert.equal(terminal.sourceEventSequence, 2);
  assert.equal(terminal.toolEvidence.latestEventSeq, 4);
  assert.equal(terminal.toolEvidence.outputText, "final content");
  assert.equal(terminal.status, "succeeded");
});

test("directory listing keeps its cwd default and does not invent output", () => {
  const action = actionFor([toolEvent(1, "tool_start", { toolName: "ls", args: {} })]);
  assert.equal(action.summary, "/repo");
  assert.equal(action.toolEvidence.toolName, "ls");
  assert.equal(action.toolEvidence.outputText, undefined);
  assert.ok(action.sourceRefs.some(ref => ref.kind === "file" && ref.path === "/repo"));
});

test("search input preserves the pattern, root and numeric range without arbitrary args", () => {
  const action = actionFor([toolEvent(1, "tool_start", { toolName: "grep", args: { pattern: "useTimeline", path: "apps/web", limit: 5, token: "never-show-this" } })]);
  assert.match(action.summary, /useTimeline/u);
  assert.match(action.summary, /apps\/web/u);
  assert.match(action.toolEvidence.inputSummary, /limit=5/u);
  assert.doesNotMatch(JSON.stringify(action.toolEvidence), /never-show-this/u);
});

test("tool output is redacted and bounded without splitting Unicode", () => {
  const action = actionFor([
    toolEvent(1, "tool_start", { args: { path: "README.md" } }),
    toolEvent(2, "tool_end", { result: { content: [
      { type: "text", text: "\u001b[31msk-testsecret0000000\u001b[0m\n" + "鲸".repeat(4000) },
      { type: "image", data: "image-base64-must-not-be-displayed" },
    ] } }),
  ]);
  assert.match(action.toolEvidence.outputText, /\[REDACTED\]/u);
  assert.doesNotMatch(action.toolEvidence.outputText, /sk-testsecret|\u001b|\uFFFD|image-base64/u);
  assert.ok(Buffer.byteLength(action.toolEvidence.outputText, "utf8") <= 8192);
  assert.equal(action.toolEvidence.outputTruncated, true);
});

test("tool output line budget and terminal empty output remain explicit", () => {
  const start = toolEvent(1, "tool_start", { args: { path: "README.md" } });
  const update = toolEvent(2, "tool_update", { partialResult: { text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") } });
  const live = actionFor([start, update]);
  assert.ok(live.toolEvidence.outputText.split("\n").length <= 40);
  assert.equal(live.toolEvidence.outputTruncated, true);
  const terminal = actionFor([start, update, toolEvent(3, "tool_end", { result: { content: [] } })]);
  assert.equal(terminal.toolEvidence.outputText, undefined);
  assert.equal(terminal.toolEvidence.latestEventSeq, 3);
});

test("ANSI-decorated sensitive input cannot escape redaction or become a fake file target", () => {
  const action = actionFor([toolEvent(1, "tool_start", { toolName: "grep", args: {
    path: "\u001b[31msk-testpath000000000\u001b[0m",
    pattern: "\u001b[32msk-testpattern000000000\u001b[0m",
  } })]);
  assert.match(action.summary, /\[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(action), /sk-testpath|sk-testpattern|\\u001b/u);
  assert.equal(action.targetRefs.some(ref => ref.type === "file"), false);
});

test("oversized paths stay bounded for display and are never truncated into navigation targets", () => {
  const action = actionFor([toolEvent(1, "tool_start", { args: { path: "a".repeat(100_000) } })]);
  assert.ok(Buffer.byteLength(action.summary, "utf8") <= 1024);
  assert.ok(Buffer.byteLength(action.toolEvidence.inputSummary, "utf8") <= 1024);
  assert.equal(action.targetRefs.some(ref => ref.type === "file"), false);
});

test("MCP lifecycle exposes actual text output and redacted input without binary or internal metadata", () => {
  const action = actionFor([
    toolEvent(1, "tool_start", { toolName: "mcp_docs_lookup_12345678", args: {
      query: "parser", credentials: { access_token: "do-not-display-token" }, limit: 2,
    } }),
    toolEvent(2, "tool_end", { toolName: "mcp_docs_lookup_12345678", result: {
      content: [{ type: "text", text: "Found parser.ts\nTwo results." }, { type: "image", data: "binary-payload" }],
      details: { result: "internal-transport-metadata" },
    } }),
  ]);
  assert.equal(action.actionType, "mcp_tool_call");
  assert.equal(action.title, "mcp_docs_lookup_12345678");
  assert.equal(action.toolEvidence?.toolName, "mcp_docs_lookup_12345678");
  assert.match(action.toolEvidence.inputSummary, /parser/u);
  assert.match(action.toolEvidence.inputSummary, /\[REDACTED\]/u);
  assert.equal(action.toolEvidence.outputText, "Found parser.ts\nTwo results.");
  assert.doesNotMatch(JSON.stringify(action.toolEvidence), /do-not-display-token|binary-payload|internal-transport/u);
  assert.equal(action.toolEvidence.outputTruncated, false);
});

test("MCP output uses one identity through update, failure, empty terminal and late replay", () => {
  const start = toolEvent(2, "tool_start", { toolName: "mcp_docs_lookup_12345678", args: { query: "parser" } });
  const update = toolEvent(3, "tool_update", { partialResult: { content: [{ type: "text", text: "Searching\nfirst result" }] } });
  const live = actionFor([start, update]);
  assert.equal(live.toolEvidence?.outputText, "Searching\nfirst result");
  const end = toolEvent(4, "tool_end", { isError: true, result: { content: [{ type: "text", text: "Lookup rejected" }] } });
  const terminal = actionFor([toolEvent(5, "tool_update", { partialResult: { text: "late result" } }), end, update, start]);
  assert.equal(terminal.id, live.id);
  assert.equal(terminal.revision, 4);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.toolEvidence.outputText, "Lookup rejected");
  assert.equal(terminal.toolEvidence.latestEventSeq, 4);
  const empty = actionFor([start, update, toolEvent(4, "tool_end", { result: { content: [] } })]);
  assert.equal(empty.toolEvidence.outputText, undefined);
});

test("generic tool output and input remain bounded and sanitized", () => {
  const action = actionFor([
    toolEvent(1, "tool_start", { toolName: "registered_lookup", args: { query: "鲸".repeat(50_000), token: "hidden-value" } }),
    toolEvent(2, "tool_end", { result: { content: [{ type: "text", text: "\u001b[31msk-faketoolsecret123456\u001b[0m\n" + "鲸".repeat(4000) }] } }),
  ]);
  assert.ok(action.toolEvidence);
  assert.ok(Buffer.byteLength(action.toolEvidence.inputSummary, "utf8") <= 1024);
  assert.ok(Buffer.byteLength(action.toolEvidence.outputText, "utf8") <= 8192);
  assert.equal(action.toolEvidence.outputTruncated, true);
  assert.doesNotMatch(JSON.stringify(action.toolEvidence), /hidden-value|sk-faketoolsecret|\\u001b|\uFFFD/u);
});

test("MCP evidence redacts mixed authentication and API keys without relying on prior event redaction", () => {
  const action = actionFor([
    toolEvent(1, "tool_start", { toolName: "registered_lookup", args: { query: "parser" } }),
    toolEvent(2, "tool_end", { result: { content: [{ type: "text", text:
      "\u001b[31mBearer fake-auth-value\u001b[0m\nBasic fake-basic-value\nother sk-fakeoutputkey123456",
    }] } }),
  ]);
  assert.equal(action.toolEvidence.outputText, "[REDACTED]\n[REDACTED]\nother [REDACTED]");
  assert.equal(action.toolEvidence.outputTruncated, false);
});

test("generic tool with no arguments or text has no fabricated detail", () => {
  const action = actionFor([
    toolEvent(1, "tool_start", { toolName: "registered_ping", args: {} }),
    toolEvent(2, "tool_end", { result: { content: [{ type: "image", data: "opaque" }] } }),
  ]);
  assert.equal(action.toolEvidence?.inputSummary, "");
  assert.equal(action.toolEvidence?.outputText, undefined);
});

test("generic tool input normalizes nested control-decorated keys before redaction", () => {
  const action = actionFor([toolEvent(1, "tool_start", { toolName: "registered_lookup", args: {
    credentials: { "\u001b[31maccess_token\u001b[0m": "nested-sensitive-value" },
    query: "\u001b[32msk-inputsecret123456\u001b[0m",
  } })]);
  assert.match(action.toolEvidence.inputSummary, /\[REDACTED\]/u);
  assert.doesNotMatch(action.toolEvidence.inputSummary, /nested-sensitive-value|sk-inputsecret|\\u001b/u);
});

test("non-JSON generic input cannot break evidence replay or fabricate an input summary", () => {
  const action = actionFor([
    toolEvent(1, "tool_start", { toolName: "registered_lookup", args: { unsupported: 1n } }),
    toolEvent(2, "tool_end", { result: { text: "Actual result is still available" } }),
  ]);
  assert.equal(action.toolEvidence.inputSummary, "");
  assert.equal(action.toolEvidence.outputText, "Actual result is still available");
});

test("approved MCP execution keeps approval identity and correlates the tool lifecycle", () => {
  const approval = {
    id: "approval-mcp", runId: "run-tool", toolCallId: "read-1", actionType: "mcp_tool_call", risk: "medium",
    title: "Approve MCP tool call", description: "Lookup request",
    payload: { type: "mcp_tool_call", toolName: "registered_lookup", cwd: "/repo", input: { query: "parser" } },
    createdAt: "2026-09-05T00:00:01.000Z", resolvedAt: "2026-09-05T00:00:02.000Z", status: "approved",
  };
  const start = toolEvent(2, "tool_start", { toolName: "registered_lookup", args: { query: "parser" } });
  const before = actionFor([start], [approval]);
  const live = actionFor([start, toolEvent(3, "tool_update", { partialResult: { text: "Live result" } })], [approval]);
  assert.equal(live.id, "approval:approval-mcp");
  assert.equal(live.id, before.id);
  assert.equal(live.approvalId, approval.id);
  assert.equal(live.toolCallId, "read-1");
  assert.equal(live.title, "Approve MCP tool call");
  assert.equal(live.status, "executing");
  assert.ok(live.revision > before.revision);
  assert.equal(live.toolEvidence.outputText, "Live result");
  const denied = actionFor([start], [{ ...approval, status: "denied" }]);
  assert.equal(denied.id, "approval:approval-mcp");
  assert.equal(denied.status, "denied");
  assert.equal(denied.title, "Approve MCP tool call");
  assert.equal(denied.approvalId, approval.id);
});
