import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationRunHasVisibleWork,
  deriveSilentChannelReplyRunIds,
} from "../src/lib/conversation-runtime-visibility.ts";

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

test("plain channel reply supervision runs stay out of default chat", () => {
  const plainReply = { ...run, id: "run_channel_reply", status: "running", workUnitId: "wu_channel_reply" };
  const failedReply = { ...plainReply, id: "run_channel_reply_failed", status: "failed", workUnitId: "wu_channel_reply_failed" };
  const taskRun = { ...plainReply, id: "run_task", workUnitId: "wu_task" };
  const silent = deriveSilentChannelReplyRunIds({
    runs: [plainReply, failedReply, taskRun],
    workUnits: [
      { id: "wu_channel_reply", kind: "channel_ai_reply" },
      { id: "wu_channel_reply_failed", kind: "channel_ai_reply" },
      { id: "wu_task", kind: "task_run" },
    ],
    approvals: [],
    executionActions: [],
    terminalReports: [],
  });

  assert.deepEqual([...silent], [plainReply.id]);
});

test("run visibility fails closed while work-unit ownership is still loading", () => {
  const unresolvedRun = {
    ...run,
    id: "run_unresolved_work_unit",
    workUnitId: "wu_still_loading",
  };
  const silent = deriveSilentChannelReplyRunIds({
    runs: [unresolvedRun],
    workUnits: [],
    approvals: [],
    executionActions: [],
    terminalReports: [],
  });

  assert.deepEqual([...silent], [unresolvedRun.id]);
});

test("channel reply supervision remains visible when user-actionable evidence exists", () => {
  const replyWithAction = { ...run, id: "run_channel_reply_action", workUnitId: "wu_channel_reply_action" };
  const replyWithApproval = { ...run, id: "run_channel_reply_approval", workUnitId: "wu_channel_reply_approval" };
  const silent = deriveSilentChannelReplyRunIds({
    runs: [replyWithAction, replyWithApproval],
    workUnits: [
      { id: "wu_channel_reply_action", kind: "channel_ai_reply" },
      { id: "wu_channel_reply_approval", kind: "channel_ai_reply" },
    ],
    approvals: [{ id: "approval_reply", runId: replyWithApproval.id, status: "pending" }],
    executionActions: [{ id: "action_reply", runId: replyWithAction.id }],
    terminalReports: [],
  });

  assert.deepEqual([...silent], []);
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
