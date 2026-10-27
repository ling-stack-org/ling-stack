import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false, logLevel: "silent", server: { middlewareMode: true } });
after(() => vite.close());
const { ConversationTimelineTerminalReportRenderer } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/ConversationTimelineTerminalReportRenderer.tsx");
const { ConversationTimelineCommandRenderer } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/ConversationTimelineCommandRenderer.tsx");
const { timelineResponseCopyText, terminalReportCopyText } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/terminal-report-copy-text.ts");

const command = "node --test EXECUTION_COMMAND_SENTINEL.test.mjs";
function report(overrides = {}) {
  return { id: "report", kind: "terminalReport", reportId: "report", resultItemId: "result",
    turnId: "turn", runId: "run", revision: 1, generation: 1, threadSequence: 3, partIndex: 0,
    status: "failed", outcomeStatus: "failed", title: "Task failed", summary: "REPORT_SECOND_SUMMARY_SENTINEL",
    sourceRefs: [], outcomeSourceRefs: [], corrections: [], changes: [], verification: [], participants: [],
    artifacts: [], risks: [], references: [], ...overrides };
}
function check(status, overrides = {}) {
  return { id: `check-${status}`, title: `Check ${status}`, status, command, durationMs: 12345,
    summary: `Conclusion ${status}`, sourceRefs: [], ...overrides };
}
function render(item, hasNarration = true, depth = 0) {
  return renderToStaticMarkup(React.createElement(ConversationTimelineTerminalReportRenderer,
    { item, hasNarration, depth }));
}
function response(item, copyText = "Final model result") {
  return { settled: true, report: item, copyText };
}

// Regression: ISSUE-EXECUTION-OWNERSHIP-01 — the final report repeated tool evidence and final prose.
// Found by /qa on 2026-10-27.
// Report: output/e6-20260928/execution-detail-ownership-audit-20261027.md
for (const depth of [0, 1]) {
  test(`depth ${depth}: final limitations are compact, without a second execution transcript`, () => {
    const item = Object.freeze(report({ verification: [check("failed"), check("passed"),
      check("skipped", { expectation: "informational", title: "Informational check" })],
      participants: [{ agentId: "qa", displayName: "Required QA", status: "blocked", contribution: "Waiting for evidence", sourceRefs: [] },
        { agentId: "done", displayName: "Completed agent", status: "completed", contribution: "REPEATED_AGENT_NARRATION", sourceRefs: [] }],
      risks: [{ id: "unknown", severity: "critical", status: "unverified", summary: "Effects remain unknown", nextAction: "Inspect before retry", sourceRefs: [] }],
    }));
    const before = JSON.stringify(item);
    const html = render(item, true, depth);
    for (const value of ["Check failed", "Conclusion failed", "Required QA", "Effects remain unknown", "Inspect before retry"]) {
      assert.ok(html.includes(value), `Missing result limitation: ${value}`);
    }
    assert.doesNotMatch(html, /Execution details|REPORT_SECOND_SUMMARY_SENTINEL|EXECUTION_COMMAND_SENTINEL|12\.3s|Check passed|Informational check|REPEATED_AGENT_NARRATION/u);
    assert.match(html, /data-conversation-timeline-kind="terminalReport"/u);
    assert.match(html, new RegExp(`data-conversation-timeline-depth="${depth}"`));
    assert.equal(JSON.stringify(item), before, "durable report facts remain intact");
    const text = timelineResponseCopyText(response(item), true);
    assert.match(text, /Final model result/u);
    for (const value of ["Check failed", "Conclusion failed", "Required QA", "Effects remain unknown"]) assert.ok(text.includes(value));
    assert.doesNotMatch(text, /REPORT_SECOND_SUMMARY_SENTINEL|EXECUTION_COMMAND_SENTINEL|12\.3s|Check passed|REPEATED_AGENT_NARRATION/u);
  });
}

test("a report-only Host fallback and its response copy use check titles, not raw commands", () => {
  const item = report({ reportStatus: "fallback", status: "succeeded", outcomeStatus: "succeeded",
    summary: "Host fallback result", verification: [check("passed", { title: "Ledger tests" })] });
  const html = render(item, false);
  assert.match(html, /Host fallback result/u);
  assert.match(html, /Ledger tests/u);
  assert.doesNotMatch(html, /Execution details|EXECUTION_COMMAND_SENTINEL|12\.3s/u);
  const text = timelineResponseCopyText(response(item, "Earlier commentary"), false);
  assert.match(text, /Earlier commentary[\s\S]*Host fallback result/u);
  assert.match(text, /Ledger tests/u);
  assert.doesNotMatch(text, /EXECUTION_COMMAND_SENTINEL|12\.3s|## Verification|# Task failed/u);
});

test("non-success status, unknown checks and interruptions survive empty or optimistic final prose", () => {
  for (const status of ["failed", "blocked", "cancelled", "partially_succeeded"]) {
    const item = report({ status, outcomeStatus: status, summary: "", verification: [check("unknown")],
      risks: [{ id: "run-failure:run", severity: "critical", status: "unverified", summary: "Interrupted; do not replay automatically", sourceRefs: [] }] });
    const html = render(item);
    assert.match(html, /Check unknown/u);
    assert.match(html, /Interrupted; do not replay automatically/u);
    assert.match(html, new RegExp(`data-conversation-timeline-status="${status}"`));
    assert.doesNotMatch(html, /EXECUTION_COMMAND_SENTINEL/u);
    assert.match(timelineResponseCopyText(response(item, ""), true), /Check unknown/u);
  }
});

test("restricted result supplements cannot change visible narration or clipboard text", () => {
  for (const visibility of ["private", "developer_only", "audit"]) {
    const sourceRefs = [{ kind: "file", id: "public", visibility: "conversation" },
      { kind: "file", id: "hidden", visibility }];
    const item = report({ status: "succeeded", outcomeStatus: "succeeded", verification: [check("failed", { title: "PRIVATE_SENTINEL", sourceRefs })],
      corrections: [{ id: "correction", correctedFact: "PRIVATE_SENTINEL", originalAssumption: "PRIVATE_SENTINEL", confidence: "high", sourceRefs }],
      risks: [{ id: "risk", severity: "critical", status: "unresolved", summary: "PRIVATE_SENTINEL", sourceRefs }] });
    assert.equal(render(item), "");
    assert.equal(timelineResponseCopyText(response(item), true), "Final model result");
  }
});

test("corrections and non-file deliveries still supplement the result and response copy", () => {
  const item = report({ status: "succeeded", outcomeStatus: "succeeded",
    corrections: [{ id: "correct", correctedFact: "Uses SQLite", originalAssumption: "Expected MySQL", confidence: "high", sourceRefs: [] }],
    artifacts: [{ id: "notes", kind: "document", title: "Usage notes", path: "docs/usage.md", summary: "Read these instructions", sourceRefs: [] }] });
  const html = render(item);
  const text = timelineResponseCopyText(response(item), true);
  for (const value of ["Uses SQLite", "Expected MySQL", "Usage notes", "Read these instructions", "docs/usage.md"]) {
    assert.ok(html.includes(value));
    assert.ok(text.includes(value));
  }
  assert.doesNotMatch(html + text, /REPORT_SECOND_SUMMARY_SENTINEL/u);
});

test("the existing tool renderer retains actual command, output, duration and nonzero exit", () => {
  const html = renderToStaticMarkup(React.createElement(ConversationTimelineCommandRenderer, { depth: 0,
    item: { id: "tool", kind: "commandExecution", revision: 1, status: "failed", title: "Command",
      command, cwd: "/synthetic/qa", outputTail: [{ stream: "stdout", text: "TOOL_OUTPUT_SENTINEL" }], outputTruncated: false,
      exitCode: 7, durationMs: 12345, sourceRefs: [] } }));
  assert.match(html, /EXECUTION_COMMAND_SENTINEL/u);
  assert.match(html, /TOOL_OUTPUT_SENTINEL/u);
  assert.match(html, /exit 7/u);
  assert.match(html, /12s/u);
  const full = terminalReportCopyText(report({ verification: [check("failed")] }));
  assert.match(full, /EXECUTION_COMMAND_SENTINEL/u, "explicit full report serialization is not ordinary response copy");
  assert.match(full, /12\.3s/u);
});

test("unsettled responses have no copy and report-only child results never import parent prose", () => {
  assert.equal(timelineResponseCopyText({ ...response(report()), settled: false }, true), "");
  const text = timelineResponseCopyText(response(report({ summary: "Child result" }), ""), false);
  assert.match(text, /Child result/u);
  assert.doesNotMatch(text, /Final model result/u);
});

test("whole-response copy preserves every model paragraph and its intentional command narration", () => {
  const prose = "First commentary.\n\nI ran node --test with exit 0.\n\nSecond commentary.\n\nFinal answer.";
  const text = timelineResponseCopyText(response(report({ verification: [check("unknown")] }), prose), true);
  assert.ok(text.startsWith(prose));
  assert.match(text, /Check unknown/u);
  assert.doesNotMatch(text, /EXECUTION_COMMAND_SENTINEL/u);
});

test("the compact status and check labels are shared by Chinese UI and ordinary copy", () => {
  const item = report({ language: "zh-CN", status: "succeeded", outcomeStatus: "succeeded",
    verification: [check("unknown")] });
  const html = render(item);
  const text = timelineResponseCopyText(response(item), true);
  for (const value of ["未解决事项", "未知"]) {
    assert.ok(html.includes(value), `Missing localized UI label: ${value}`);
    assert.ok(text.includes(value), `Missing localized copy label: ${value}`);
  }
  assert.doesNotMatch(text, /Needs attention| · unknown/u);
});

test("a blank report-only result retains a copyable status instead of an empty ending", () => {
  const item = report({ status: "succeeded", outcomeStatus: "succeeded", summary: "" });
  assert.match(render(item, false), /The task completed\./u);
  assert.equal(timelineResponseCopyText(response(item, ""), false), "The task completed.");
});
