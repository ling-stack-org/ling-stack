import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { visibleTerminalReportTimelineItem } from "@ling-stack/conversation-ui-core";
import { terminalReportDisplayPolicy } from "../src/shared/conversation/timeline/terminal-report-display-policy.ts";
import { hasFinalTimelineResponseNarration, projectTimelineResponsePresentation } from "../src/shared/conversation/timeline/timeline-response-presentation.ts";
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false, logLevel: "silent", server: { middlewareMode: true } });
after(() => vite.close());
const { timelineResponseCopyText } = await vite.ssrLoadModule("/src/shared/conversation/timeline/terminal-report-copy-text.ts");

function report(overrides = {}) {
  return { id: "report", kind: "terminalReport", reportId: "report", turnId: "turn", runId: "run",
    revision: 1, generation: 1, threadSequence: 3, partIndex: 0, status: "succeeded", outcomeStatus: "succeeded",
    title: "Completed", summary: "Final fallback", outcomeSourceRefs: [], sourceRefs: [],
    changes: [], verification: [], participants: [], artifacts: [], risks: [], corrections: [], references: [], ...overrides };
}

test("a successful report with final narration has no second summary; facts are not mutated", () => {
  const item = Object.freeze(report({
    changes: [{ paths: ["src/file.ts"] }], verification: [{ status: "passed" }],
    participants: [{ status: "completed" }, { status: "completed" }],
    artifacts: [{ kind: "diff" }, { kind: "file" }, { kind: "test_result" }],
    risks: [{ status: "mitigated" }, { status: "accepted" }],
  }));
  const before = JSON.stringify(item);
  assert.deepEqual(terminalReportDisplayPolicy(item, true), { visible: false, needsAttention: false });
  assert.equal(JSON.stringify(item), before);
  assert.equal(terminalReportDisplayPolicy(item, false).visible, true);
});

test("report prose and counts are not success evidence", () => {
  const item = report({ verificationCount: 99, participantCount: 99, riskCount: 99 });
  Object.defineProperty(item, "summary", { get() { throw new Error("Must not infer success from prose"); } });
  assert.equal(terminalReportDisplayPolicy(item, true).visible, false);
});

test("every non-success or missing status remains visible even with final-looking prose", () => {
  for (const status of [undefined, "pending", "running", "waiting", "failed", "blocked", "cancelled", "partially_succeeded"]) {
    assert.deepEqual(terminalReportDisplayPolicy(report({ status }), true), { visible: true, needsAttention: true });
  }
  assert.equal(terminalReportDisplayPolicy(report({ outcomeStatus: "failed" }), true).visible, true);
});

test("failed, skipped, unrun and unknown checks never disappear behind success", () => {
  for (const status of ["failed", "blocked", "cancelled", "skipped", "not_run", "unknown"]) {
    assert.deepEqual(terminalReportDisplayPolicy(report({ verification: [{ status }] }), true), { visible: true, needsAttention: true });
  }
});

test("only Host-classified informational non-execution avoids false attention", () => {
  for (const status of ["not_run", "skipped"]) {
    assert.deepEqual(terminalReportDisplayPolicy(report({ verification: [{ status, expectation: "informational" }] }), true), { visible: false, needsAttention: false });
    for (const expectation of [undefined, "unknown", "evidence_backed"]) assert.equal(terminalReportDisplayPolicy(report({ verification: [{ status, expectation }] }), true).needsAttention, true);
  }
  for (const status of ["failed", "blocked", "unknown", "cancelled"]) assert.equal(terminalReportDisplayPolicy(report({ verification: [{ status, expectation: "informational" }] }), true).needsAttention, true);
  assert.equal(terminalReportDisplayPolicy(report({ verification: [{ status: "not_run", expectation: "informational" }, { status: "not_run", expectation: "evidence_backed" }] }), true).needsAttention, true);
});

test("incomplete participants and unresolved risks keep required attention", () => {
  for (const status of ["failed", "blocked", "cancelled"]) {
    assert.equal(terminalReportDisplayPolicy(report({ participants: [{ status }] }), true).needsAttention, true);
  }
  for (const status of ["unresolved", "unverified"]) {
    assert.equal(terminalReportDisplayPolicy(report({ risks: [{ status }] }), true).needsAttention, true);
  }
  for (const approvalDecision of ["pending", "denied", "expired", "cancelled"]) {
    assert.equal(terminalReportDisplayPolicy(report({ risks: [{ status: "accepted", approvalDecision }] }), true).needsAttention, true);
  }
});

test("visible corrections and non-file deliverables may supplement final narration", () => {
  assert.deepEqual(terminalReportDisplayPolicy(report({ corrections: [{}] }), true), { visible: true, needsAttention: false });
  assert.equal(terminalReportDisplayPolicy(report({ artifacts: [{ kind: "image" }] }), true).visible, true);
});

test("privacy projection precedes attention, so hidden evidence cannot change disclosure", () => {
  const sourceRefs = [{ kind: "file", id: "hidden", visibility: "developer_only" }];
  const item = report({
    verification: [{ id: "private-check", title: "SECRET", status: "failed", sourceRefs }],
    participants: [{ agentId: "private", displayName: "SECRET", status: "blocked", contribution: "SECRET", sourceRefs }],
    risks: [{ summary: "SECRET", status: "unresolved", sourceRefs }],
  });
  assert.equal(terminalReportDisplayPolicy(visibleTerminalReportTimelineItem(item), true).visible, false);
  assert.equal(item.verification.length, 1, "history is retained");
});

test("commentary and blank/live final text cannot suppress a fallback; copy contains the result", () => {
  const message = { id: "message", kind: "agentMessage", turnId: "turn", runId: "run", participantId: "engineer",
    markdown: "I will execute", phase: "commentary", status: "succeeded", sourceRefs: [] };
  for (const overrides of [{}, { phase: "final", markdown: " " }, { phase: "final", status: "running" }]) {
    const response = projectTimelineResponsePresentation([{ ...message, ...overrides }, report()]).responseByItemId.get("report");
    assert.equal(hasFinalTimelineResponseNarration(response), false);
    assert.equal(terminalReportDisplayPolicy(response.report, false).visible, true);
    if (response.settled) assert.match(timelineResponseCopyText(response, hasFinalTimelineResponseNarration(response)), /Final fallback/u);
    else assert.equal(timelineResponseCopyText(response, hasFinalTimelineResponseNarration(response)), "");
  }
  const response = projectTimelineResponsePresentation([{ ...message, phase: "final", markdown: "Done" }, report()]).responseByItemId.get("report");
  assert.equal(hasFinalTimelineResponseNarration(response), true);
  assert.equal(timelineResponseCopyText(response, hasFinalTimelineResponseNarration(response)), "Done");
});

test("a parent's final reply cannot suppress a child's fallback or warning", () => {
  const parentMessage = { id: "parent-message", kind: "agentMessage", turnId: "turn", runId: "run",
    markdown: "Parent complete", phase: "final", status: "succeeded", sourceRefs: [] };
  const childReport = report({ id: "child-report", reportId: "child-report", turnId: "child-turn", runId: "child-run" });
  const child = { id: "child", kind: "subAgentActivity", turnId: "turn", runId: "run",
    lifecycle: "completed", status: "succeeded", childItems: [childReport], sourceRefs: [] };
  const presentation = projectTimelineResponsePresentation([parentMessage, child, report()]);
  const parentResponse = presentation.responseByItemId.get("report");
  const childResponse = presentation.responseByItemId.get("child-report");
  assert.equal(terminalReportDisplayPolicy(parentResponse.report, hasFinalTimelineResponseNarration(parentResponse)).visible, false);
  assert.equal(hasFinalTimelineResponseNarration(childResponse), false);
  assert.equal(terminalReportDisplayPolicy(childResponse.report, false).visible, true);
  assert.doesNotMatch(timelineResponseCopyText(childResponse, false), /Parent complete/u);
  const childFinal = { ...parentMessage, id: "child-message", turnId: "child-turn", runId: "child-run", markdown: "Child complete" };
  const warnedChild = { ...child, childItems: [childFinal, { ...childReport,
    risks: [{ summary: "Required follow-up", status: "unresolved" }],
  }] };
  const warnedPresentation = projectTimelineResponsePresentation([parentMessage, warnedChild, report()]);
  const warnedResponse = warnedPresentation.responseByItemId.get("child-report");
  assert.equal(hasFinalTimelineResponseNarration(warnedResponse), true);
  assert.deepEqual(terminalReportDisplayPolicy(warnedResponse.report, true), { visible: true, needsAttention: true });
  assert.equal(terminalReportDisplayPolicy(warnedPresentation.responseByItemId.get("report").report, true).visible, false);
});
