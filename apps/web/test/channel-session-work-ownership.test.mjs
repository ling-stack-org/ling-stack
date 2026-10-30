import assert from "node:assert/strict";
import test from "node:test";
import { channelSessionWorkOwnership } from "../src/features/workspace/channel-session-work-ownership.ts";

const base = { channelId: "channel", threadId: "A", items: [], messages: [], workflows: [], steps: [] };
test("durable direct-session runs retain historical approvals without borrowing another session or channel", () => {
  const ownership = channelSessionWorkOwnership({ ...base, runs: [
    { id: "history", channelId: "channel", threadId: "A", status: "succeeded" },
    { id: "other", channelId: "channel", threadId: "B" },
    { id: "foreign", channelId: "foreign", threadId: "A" },
  ] });
  assert.equal(ownership.ownsApproval({ id: "expired", channelId: "channel", runId: "history" }), true);
  assert.equal(ownership.ownsApproval({ id: "pending", runId: "other" }), false);
  assert.equal(ownership.ownsApproval({ id: "foreign", runId: "foreign" }), false);
  assert.equal(ownership.ownsApproval({ id: "unowned", channelId: "channel" }), false);
});
test("server activity IDs keep independent work threads and preflight approvals in their source session even when history is not loaded", () => {
  const ownership = channelSessionWorkOwnership({ ...base, session: { id: "A", channelId: "channel", activeRunIds: ["work-run"], pendingApprovalIds: ["preflight"] },
    approvals: [{ id: "preflight", channelId: "channel", workflowStepId: "step-without-run" }],
    steps: [{ id: "step-without-run", channelId: "channel", workflowId: "preflight-workflow" }, { id: "work-step", channelId: "channel", workflowId: "run-workflow", runId: "work-run" }],
  });
  assert.equal(ownership.ownsRun({ id: "work-run", channelId: "channel", threadId: "workflow-work-thread" }), true);
  assert.equal(ownership.ownsApproval({ id: "preflight", channelId: "channel", workflowStepId: "step-without-run" }), true);
  assert.equal(ownership.ownsRun({ id: "B-run", channelId: "channel", threadId: "B" }), false);
  assert.equal(ownership.ownsApproval({ id: "B-approval", channelId: "channel" }), false);
  assert.deepEqual([...ownership.workflowIds], ["preflight-workflow", "run-workflow"]);
  assert.deepEqual([...ownership.stepIds], ["step-without-run", "work-step"]);
});

test("another session cannot borrow the activity summary and another channel cannot borrow its IDs", () => {
  const ownership = channelSessionWorkOwnership({ ...base, session: { id: "B", channelId: "channel", activeRunIds: ["B-run"], pendingApprovalIds: ["B-approval"] } });
  assert.equal(ownership.ownsRun({ id: "B-run", channelId: "channel", threadId: "work" }), false);
  assert.equal(ownership.ownsApproval({ id: "B-approval", channelId: "channel" }), false);
  const own = channelSessionWorkOwnership({ ...base, session: { id: "A", channelId: "channel", activeRunIds: ["own-run"], pendingApprovalIds: ["own-approval"] } });
  assert.equal(own.ownsRun({ id: "own-run", channelId: "other", threadId: "A" }), false);
  assert.equal(own.ownsApproval({ id: "own-approval", channelId: "other" }), false);
});

test("canonical item references add historical evidence without discovering unlinked channel work", () => {
  const ownership = channelSessionWorkOwnership({ ...base, items: [
    { id: "message", turnId: "turn", threadId: "A", channelId: "channel", domainRefs: [{ type: "run", id: "history-run" }, { type: "approval", id: "referenced-approval" }] },
    { id: "other-message", turnId: "other-turn", threadId: "B", channelId: "channel", domainRefs: [{ type: "run", id: "B-run" }] },
  ], workflows: [
    { id: "workflow", channelId: "channel", metadata: { sourceTurnId: "turn" } },
    { id: "B-workflow", channelId: "channel", metadata: { sourceTurnId: "other-turn" } },
  ], steps: [{ id: "step", channelId: "channel", workflowId: "workflow", runId: "step-run" }] });
  assert.equal(ownership.ownsRun({ id: "history-run", channelId: "channel", threadId: "work" }), true);
  assert.equal(ownership.ownsRun({ id: "step-run", channelId: "channel", threadId: "work" }), true);
  assert.equal(ownership.ownsRun({ id: "B-run", channelId: "channel", threadId: "B" }), false);
  assert.equal(ownership.ownsApproval({ id: "referenced-approval", channelId: "channel" }), true);
  assert.deepEqual([...ownership.workflowIds], ["workflow"]);
});

test("a durable Run workflowStepId links execution evidence even when the step has no runId", () => {
  const ownership = channelSessionWorkOwnership({ ...base,
    items: [{ id: "source", threadId: "A", channelId: "channel", domainRefs: [] }],
    workflows: [{ id: "workflow", channelId: "channel", metadata: { sourceMessageId: "source" } }],
    steps: [{ id: "step", channelId: "channel", workflowId: "workflow" }],
    runs: [
      { id: "run", channelId: "channel", threadId: "execution", workflowStepId: "step" },
      { id: "other", channelId: "channel", threadId: "B", workflowStepId: "other-step" },
      { id: "foreign", channelId: "foreign", threadId: "execution", workflowStepId: "step" },
    ],
  });
  assert.equal(ownership.ownsRun({ id: "run", channelId: "channel", threadId: "execution" }), true);
  assert.equal(ownership.ownsApproval({ id: "approval", runId: "run" }), true);
  assert.equal(ownership.ownsRun({ id: "other", channelId: "channel", threadId: "B" }), false);
  assert.equal(ownership.ownsApproval({ id: "foreign-approval", runId: "foreign" }), false);
});
