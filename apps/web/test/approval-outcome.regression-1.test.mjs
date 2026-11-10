import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { projectCanonicalConversationTimeline } from "@ling-stack/conversation-ui-core";

const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false, logLevel: "silent", server: { middlewareMode: true } });
after(() => vite.close());
const { ConversationTimelineCommandRenderer } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/ConversationTimelineCommandRenderer.tsx");
const { TimelineFactRow } = await vite.ssrLoadModule("/src/shared/conversation/timeline/TimelineFactRow.tsx");

function project(surface, status, overrides = {}) {
  const scope = { surface, workspaceId: "workspace", threadId: "thread", depth: surface === "child" ? 1 : 0,
    ...(surface === "child" ? { turnId: "turn", runId: "run", attemptId: "attempt", participantId: "engineer" } : {}) };
  const action = { id: "action", revision: 3, workspaceId: "workspace", threadId: "thread", turnId: "turn",
    runId: "run", attemptId: "attempt", participantId: "engineer", workflowStepId: null, approvalId: "approval",
    actionType: "bash", risk: "medium", title: "Approve shell command", status,
    commandEvidence: { command: "node nonce.mjs", latestEventSeq: 7, outputTail: [], outputTruncated: false },
    sourceRefs: [{ kind: "conversation_item", id: "tool" }], ...overrides };
  return projectCanonicalConversationTimeline({ scope, sourceSequence: 1, sourceRevision: "outcome-3",
    items: [{ id: "tool", workspaceId: "workspace", threadId: "thread", turnId: "turn", sequence: 1,
      kind: "tool_call", status: "committed", actorType: "teammate", actorId: "engineer", revision: 1,
      payload: { toolCallId: "call", toolName: action.actionType }, domainRefs: [{ type: "run", id: "run" }] }],
    actions: [action], turnRuns: [{ runId: "run", turnId: "turn", attemptNumber: 1, role: "primary" }] });
}

// Regression: ISSUE-A01-01 — approval denial was rendered as command execution failure.
// Found by /qa on 2026-10-26.
// Report: output/e6-20260928/a01-deny-packaged-live-20261026/qa-report-a01-deny-packaged-2026-10-26.md
for (const surface of ["normal", "private", "channel_root", "child"]) {
  for (const [status, label] of [["denied", "Denied"], ["expired", "Expired"]]) {
    test(`${surface} ${status}: canonical Host decision reaches the real shared command renderer`, () => {
      const projection = project(surface, status);
      const row = projection.items.find(item => item.actionId === "action");
      assert.ok(row);
      assert.equal(row.approvalOutcome, status);
      assert.equal(row.status, "failed", "non-success lifecycle remains unchanged for grouping and fan-in");
      assert.equal(projection.terminalEvidence[0].status, "failed");
      const html = renderToStaticMarkup(React.createElement(ConversationTimelineCommandRenderer, { item: row, depth: surface === "child" ? 1 : 0 }));
      assert.match(html, new RegExp(`conversation-timeline-activity-status">${label}<`));
      assert.doesNotMatch(html, /conversation-timeline-activity-status">Failed</);
      assert.ok(html.includes("node nonce.mjs"));
    });
  }
}

test("shared non-command facts retain exact approval outcome without changing their renderer kind", () => {
  for (const [actionType, kind, extra] of [["write", "fileChange", { sourceRefs: [
    { kind: "conversation_item", id: "tool" }, { kind: "file", id: "nonce.txt", path: "nonce.txt" }] }],
    ["mcp", "mcpToolCall", {}], ["permission_request", "approval", {}]]) {
    const row = project("normal", "denied", { actionType, ...extra }).items.find(item => item.actionId === "action");
    assert.equal(row.kind, kind);
    assert.equal(row.approvalOutcome, "denied");
    const html = renderToStaticMarkup(React.createElement(TimelineFactRow, { item: row, title: row.title, icon: null }));
    assert.match(html, /conversation-timeline-activity-status">Denied</);
  }
});

test("generic execution failure and unbound actions never invent an approval outcome", () => {
  for (const [status, extra] of [["failed", {}], ["denied", { approvalId: undefined }],
    ["expired", { approvalId: undefined }], ["succeeded", {}]]) {
    const row = project("normal", status, extra).items.find(item => item.actionId === "action");
    assert.equal(row.approvalOutcome, undefined);
    const html = renderToStaticMarkup(React.createElement(ConversationTimelineCommandRenderer, { item: row, depth: 0 }));
    assert.doesNotMatch(html, /conversation-timeline-activity-status">(?:Denied|Expired)</);
  }
  for (const status of ["failed", "blocked"]) {
    const row = project("normal", status, { actionType: "permission_request" }).items.find(item => item.actionId === "action");
    assert.equal(row.decision, undefined, "a failed approval operation is not proof of a user denial");
  }
});

test("standalone supplemental approvals preserve expiry rather than turning it into denial", () => {
  for (const status of ["denied", "expired"]) {
    const projection = projectCanonicalConversationTimeline({ scope: { surface: "normal", workspaceId: "workspace", threadId: "thread", depth: 0 },
      sourceSequence: 1, sourceRevision: "standalone-3", actions: [], turnRuns: [],
      items: [{ id: "request", workspaceId: "workspace", threadId: "thread", turnId: "turn", sequence: 1,
        kind: "approval_request", status: "committed", actorType: "system", revision: 1, payload: {} }],
      approvals: [{ id: "approval", revision: 3, workspaceId: "workspace", threadId: "thread", runId: "run", attemptId: "attempt",
        participantId: "engineer", anchorItemId: "request", title: "Permission", status, sourceRefs: [] }] });
    const row = projection.items.find(item => item.kind === "approval");
    assert.equal(row.approvalOutcome, status);
    assert.equal(row.decision, status);
    assert.deepEqual(projection.terminalEvidence, [], "a decision alone is never completion evidence");
  }
});
