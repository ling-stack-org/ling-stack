import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationOperationCell } from "../dist/index.js";

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
