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
const { ConversationTimelineTerminalReportRenderer } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/ConversationTimelineTerminalReportRenderer.tsx");

const artifacts = Array.from({ length: 53 }, (_, index) => ({
  id: `artifact-${index}`, kind: "other", title: `Supplement ${index}`,
  path: `evidence/result-${index}.md`, sourceRefs: [],
}));
function report(overrides = {}) {
  return { id: "terminal-report:report", kind: "terminalReport", reportId: "report", resultItemId: "result",
    turnId: "turn", revision: 1, generation: 1, threadSequence: 3, partIndex: 0,
    status: "succeeded", outcomeStatus: "succeeded", title: "Completed", summary: "Final result remains visible",
    sourceRefs: [{ kind: "workflow", id: "workflow" }], outcomeSourceRefs: [],
    corrections: [], changes: [], verification: [], participants: [], artifacts, risks: [], references: [], ...overrides };
}
function render(item, hasNarration = false, depth = 0) {
  return renderToStaticMarkup(React.createElement(ConversationTimelineTerminalReportRenderer,
    { item, hasNarration, depth }));
}
function assertRoutineOmitted(html) {
  assert.doesNotMatch(html, /aria-expanded|conversation-timeline-activity-detail|Supplement \d|>Details</u);
}
function assertOpen(html) {
  assert.match(html, /aria-expanded="true"/u);
  assert.match(html, /conversation-timeline-activity-detail/u);
}

for (const [name, refs] of Object.entries({
  canonical: { sourceRefs: [{ kind: "workflow", id: "workflow" }] },
  channel: { sourceRefs: [{ kind: "channel_workflow", id: "workflow" }] },
  "channel outcome": { sourceRefs: [{ kind: "terminal_report", id: "report" }],
    outcomeSourceRefs: [{ kind: "workflow", id: "workflow", visibility: "conversation" }] },
})) {
  test(`${name}: successful workflows keep the result without supplemental disclosures`, () => {
    const item = Object.freeze(report(refs));
    const before = JSON.stringify(item);
    for (const hasNarration of [false, true]) {
      for (const depth of [0, 1]) {
        const html = render(item, hasNarration, depth);
        assertRoutineOmitted(html);
        assert.doesNotMatch(html, /The task completed\./u, "the result does not acquire a duplicate completion row");
        if (hasNarration) assert.equal(html, "");
        else {
          assert.match(html, /data-conversation-timeline-status="succeeded"/u);
          assert.match(html, new RegExp(`data-conversation-timeline-depth="${depth}"`));
        }
        assert.equal(html.includes(item.summary), !hasNarration, "final narration remains the sole prose owner");
      }
    }
    assert.equal(JSON.stringify(item), before, "all 53 durable artifacts and source identities stay intact");
  });
}

test("the canonical report projector carries the exact workflow source into presentation", () => {
  const result = projectCanonicalConversationTimeline({
    scope: { surface: "channel", workspaceId: "workspace", threadId: "thread", depth: 0 },
    sourceSequence: 1, sourceRevision: "report", actions: [], turnRuns: [],
    items: [{ id: "result", workspaceId: "workspace", threadId: "thread", turnId: "turn",
      sequence: 1, revision: 1, kind: "terminal_report", status: "committed", actorType: "system",
      payload: { reportId: "report", generation: 1, sourceKind: "workflow", sourceId: "workflow",
        evidenceFingerprint: "fingerprint", outcomeStatus: "succeeded" }, domainRefs: [] }],
    terminalReports: [{ generation: 1, resultItemId: "result", report: {
      id: "report", workspaceId: "workspace", threadId: "thread", turnId: "turn",
      source: { kind: "workflow", id: "workflow" }, status: "committed", evidenceFingerprint: "fingerprint",
      outcome: { status: "succeeded", title: "Completed", summary: "Final result remains visible", corrections: [], sourceRefs: [] },
      changes: [], verification: [], participants: [], artifacts, risks: [], references: [],
    } }],
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].sourceRefs.some(ref => ref.kind === "workflow" && ref.id === "workflow"));
  assertRoutineOmitted(render(result.items[0]));
});

test("non-workflow reports retain their expanded supplements regardless of prose, step ids or artifact count", () => {
  for (const sourceRefs of [[], [{ kind: "run", id: "run" }], [{ kind: "turn", id: "turn" }],
    [{ kind: "terminal_report", id: "report" }]]) {
    const html = render(report({ sourceRefs, title: "Workflow completed", summary: "Workflow completed",
      workflowStepId: "step", references: [{ kind: "workflow", id: "unrelated-reference" }] }));
    assertOpen(html);
    assert.match(html, /Supplement 52/u);
  }
});

test("explicit run or turn lineage is not reclassified by workflow evidence in the outcome", () => {
  for (const kind of ["run", "turn"]) {
    const html = render(report({ sourceRefs: [{ kind, id: "owner" }],
      outcomeSourceRefs: [{ kind: "workflow", id: "referenced-workflow" }] }));
    assertOpen(html);
    assert.match(html, /Supplement 52/u);
  }
});

test("status-only workflow endings do not gain an empty disclosure or duplicate narration", () => {
  const item = report({ artifacts: [] });
  assert.match(render(item), /Final result remains visible/u);
  assert.doesNotMatch(render(item), /aria-expanded|conversation-timeline-activity-detail/u);
  assert.equal(render(item, true), "");
  const blank = render({ ...item, summary: "" });
  assert.match(blank, /The task completed\./u);
  assert.doesNotMatch(blank, /aria-expanded/u);
});

test("a routine workflow without final prose retains its authoritative status without supplements", () => {
  const item = report({ summary: "" });
  const html = render(item);
  assertRoutineOmitted(html);
  assert.match(html, /The task completed\./u);
  assert.match(html, /data-conversation-timeline-status="succeeded"/u);
  assert.equal(render(item, true), "");
});

test("non-success or missing authoritative states never fold workflow limitations behind optimistic prose", () => {
  for (const status of [undefined, "pending", "running", "waiting", "failed", "blocked", "cancelled", "partially_succeeded"]) {
    assertOpen(render(report({ status, summary: "Everything completed" }), true));
  }
  for (const outcomeStatus of [undefined, "failed", "blocked", "cancelled", "partially_succeeded"]) {
    assertOpen(render(report({ outcomeStatus }), true));
  }
});

test("required skipped, unrun, failed or uncertain checks remain visible while informational non-execution stays quiet", () => {
  for (const status of ["failed", "blocked", "cancelled", "skipped", "not_run", "unknown"]) {
    const html = render(report({ verification: [{ id: "check", title: "Required check", status,
      summary: "Required evidence is missing", sourceRefs: [] }] }), true);
    assertOpen(html);
    assert.match(html, /Required check/u);
    assert.match(html, /Required evidence is missing/u);
    assert.match(html, /Open Issues/u);
  }
  for (const status of ["skipped", "not_run"]) {
    assertRoutineOmitted(render(report({ verification: [{ id: "check", title: "Informational check", status,
      expectation: "informational", sourceRefs: [] }] }), true));
  }
});

test("risks, failure reasons, next actions and approval attention remain expanded even on a successful workflow", () => {
  const risk = { id: "risk", severity: "critical", status: "unverified", summary: "Effects remain unknown",
    nextAction: "Inspect before retry", sourceRefs: [] };
  for (const status of ["unresolved", "unverified"]) {
    const html = render(report({ risks: [{ ...risk, status }] }), true);
    assertOpen(html);
    assert.match(html, /Effects remain unknown/u);
    assert.match(html, /Inspect before retry/u);
  }
  for (const approvalDecision of ["pending", "denied", "expired", "cancelled"]) {
    const html = render(report({ risks: [{ ...risk, status: "accepted", approvalDecision }] }), true);
    assertOpen(html);
    assert.match(html, /Effects remain unknown/u);
    assert.match(html, /Inspect before retry/u);
  }
});

test("incomplete participants and corrections are not treated as routine success details", () => {
  for (const status of ["failed", "blocked", "cancelled"]) {
    const html = render(report({ participants: [{ agentId: "qa", displayName: "Required QA", status,
      contribution: "QA did not finish", sourceRefs: [] }] }), true);
    assertOpen(html);
    assert.match(html, /QA did not finish/u);
  }
  const html = render(report({ corrections: [{ id: "correction", originalAssumption: "Expected MySQL",
    correctedFact: "Uses SQLite", confidence: "high", sourceRefs: [] }] }), true);
  assertOpen(html);
  assert.match(html, /Uses SQLite/u);
  assert.match(html, /Expected MySQL/u);
});

test("privacy projection precedes disclosure and cannot expose restricted attention or evidence", () => {
  const sourceRefs = [{ kind: "file", id: "hidden", visibility: "developer_only" }];
  const html = render(report({ verification: [{ id: "private-check", title: "PRIVATE_CHECK", status: "failed", sourceRefs }],
    corrections: [{ id: "private-correction", correctedFact: "PRIVATE_CORRECTION", sourceRefs }],
    risks: [{ id: "private-risk", severity: "critical", status: "unresolved", summary: "PRIVATE_RISK", sourceRefs }] }), true);
  assertRoutineOmitted(html);
  assert.doesNotMatch(html, /PRIVATE_CHECK|PRIVATE_CORRECTION|PRIVATE_RISK/u);
});
