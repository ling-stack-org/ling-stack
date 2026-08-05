import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationRunHasVisibleWork } from "../src/lib/conversation-runtime-visibility.ts";

const run = {
  id: "run_chat",
  status: "succeeded",
};

test("plain successful chat runs stay silent even when a generic check summary exists", () => {
  assert.equal(conversationRunHasVisibleWork({
    run,
    approvals: [],
    executionActions: [],
    terminalReport: terminalReport({
      verification: [{
        id: "check_generic",
        title: "Response completed",
        status: "passed",
        summary: "1 check passed",
        sourceRefs: [{ kind: "check", id: "check_generic", visibility: "conversation" }],
      }],
    }),
  }), false);
});

test("tools, approvals, failures, and durable work evidence remain visible", () => {
  assert.equal(conversationRunHasVisibleWork({
    run,
    approvals: [],
    executionActions: [{ id: "action_read", runId: run.id }],
  }), true);
  assert.equal(conversationRunHasVisibleWork({
    run: { ...run, status: "waiting_for_approval" },
    approvals: [],
    executionActions: [],
  }), true);
  assert.equal(conversationRunHasVisibleWork({
    run,
    approvals: [],
    executionActions: [],
    terminalReport: terminalReport({ changes: [{ id: "change", title: "Changed", summary: "Changed", paths: [], sourceRefs: [] }] }),
  }), true);
});

function terminalReport(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "report_chat",
    workspaceId: "workspace_default",
    source: { kind: "run", id: run.id },
    status: "committed",
    language: "en-US",
    outcome: { status: "succeeded", title: "Done", summary: "Done", corrections: [], sourceRefs: [] },
    changes: [],
    verification: [],
    participants: [],
    artifacts: [],
    risks: [],
    references: [],
    evidenceSnapshotId: "snapshot",
    evidenceFingerprint: "fingerprint",
    synthesis: { mode: "deterministic_fallback", promptVersion: "v1", attemptCount: 1, validationCodes: [] },
    createdAt: "2026-08-05T00:00:00.000Z",
    committedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}
