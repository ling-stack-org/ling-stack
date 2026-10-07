import assert from "node:assert/strict";
import test from "node:test";
import { terminalReportGeneration } from "../src/lib/terminal-report-generation.ts";

const scope = { workspaceId: "workspace-1", channelId: "channel-1", threadId: "thread-1", turnId: "turn-1" };
const report = {
  id: "report-retry", workspaceId: scope.workspaceId, channelId: scope.channelId,
  threadId: scope.threadId, turnId: scope.turnId,
  source: { kind: "workflow", id: "workflow-1" },
  outcome: { status: "succeeded" },
  evidenceFingerprint: "d2a8dcb64d41",
};
const anchor = {
  id: "result_terminal_report:report-retry", kind: "terminal_report", status: "committed",
  visibility: "channel", ...scope,
  payload: {
    reportId: report.id, generation: 2, sourceKind: report.source.kind,
    sourceId: report.source.id, evidenceFingerprint: report.evidenceFingerprint,
    outcomeStatus: report.outcome.status,
  },
};

test("retry generation comes from the committed Item, not the fingerprint", () => {
  assert.equal(terminalReportGeneration(report, report.id, [anchor], scope), 2);
});

test("missing or mismatched lineage cannot fabricate first generation", () => {
  assert.equal(terminalReportGeneration(undefined, report.id, [anchor], scope), undefined);
  assert.equal(terminalReportGeneration({ ...report, id: "other" }, report.id, [anchor], scope), undefined);
  assert.equal(terminalReportGeneration(report, report.id, [{ ...anchor, payload: { ...anchor.payload, evidenceFingerprint: "stale" } }], scope), undefined);
  assert.equal(terminalReportGeneration(report, report.id, [anchor], { ...scope, threadId: "foreign" }), undefined);
  assert.equal(terminalReportGeneration(report, report.id, [{ ...anchor, payload: { ...anchor.payload, generation: 0 } }], scope), undefined);
});

test("old blocked generation cannot replace the new successful report", () => {
  const old = { ...anchor, id: "result_terminal_report:old", payload: { ...anchor.payload, reportId: "old", generation: 1, outcomeStatus: "blocked" } };
  assert.equal(terminalReportGeneration(report, report.id, [old, anchor], scope), 2);
});
