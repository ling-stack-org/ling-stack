import assert from "node:assert/strict";
import test from "node:test";
import { batchCanonicalTranscriptItems } from "@ling-stack/conversation-ui-core";
import { projectConversationDetailTimeline, resolveConversationContextSnapshots } from "../src/domains/conversations/canonical-transcript-snapshot.ts";
import { mergeConversationDetailSnapshots } from "../src/domains/conversations/conversation-detail-merge.ts";

test("detail adapter feeds the canonical projector from full Continuity history", () => {
  const detail = detailFixture({ kind: "conversation" });
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.items[0].kind, "userMessage");
  assert.equal(projection.items[1].kind, "commandExecution");
  assert.equal(projection.items[2].kind, "agentMessage");
  assert.equal(projection.items[1].runId, "run-1");
  assert.equal(projection.items[1].turnId, "turn-1");
  assert.equal(projection.items[1].attemptNumber, 1);
  assert.equal(projection.items[1].turnRunRole, "primary");
  assert.equal(projection.items[1].sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === "tool-1"), true);
});

test("detail adapter supplies immutable context segments to display batching", () => {
  const detail = detailFixture({ kind: "conversation" });
  detail.conversationItems = [
    item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
    ...[2, 3, 4, 5, 6].map((sequence) => item(`tool-${sequence}`, sequence, "tool_call", { toolCallId: `call-${sequence}`, toolName: "read" })),
  ];
  detail.executionActions = [2, 3, 4, 5, 6].map((sequence) => actionFixture(`read-${sequence}`, `tool-${sequence}`, {
    actionType: "read",
    toolCallId: `call-${sequence}`,
    sourceRefs: [{ kind: "conversation_item", id: `tool-${sequence}` }],
    targetRefs: [{ type: "file", id: `src/file-${sequence}.ts`, path: `src/file-${sequence}.ts` }],
  }));
  detail.contextSnapshots = [
    { id: "snapshot-a", threadId: detail.thread.id, segmentId: "segment-a", projectionVersion: "v1", throughItemSequence: 4, summaryIds: [], sourceRefs: [2, 3, 4].map((sequence) => ({ type: "conversation_item", id: `tool-${sequence}` })), policyVersion: "v1", createdAt: "2026-08-29T00:00:01.000Z" },
    { id: "snapshot-b", threadId: detail.thread.id, segmentId: "segment-b", projectionVersion: "v1", throughItemSequence: 6, summaryIds: [], sourceRefs: [5, 6].map((sequence) => ({ type: "conversation_item", id: `tool-${sequence}` })), policyVersion: "v1", createdAt: "2026-08-29T00:00:02.000Z" },
  ];
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.contextSegmentIdByItemId?.get("tool-2"), "segment-a");
  assert.equal(projection.contextSegmentIdByItemId?.get("tool-5"), "segment-b");
  const display = batchCanonicalTranscriptItems(projection.items, {
    contextSegmentIdByItemId: projection.contextSegmentIdByItemId ?? new Map(),
  });
  assert.deepEqual(display.filter((entry) => entry.kind === "explorationBatch").map((entry) => entry.childActionIds), [["read-2", "read-3", "read-4"]]);
  assert.deepEqual(display.filter((entry) => entry.kind === "exploration").map((entry) => entry.actionId), ["read-5", "read-6"]);
});

test("context snapshot resolver derives only explicit committed source items", () => {
  const items = [
    item("source-1", 1, "user_message", { body: "one", format: "plain_text" }),
    item("source-2", 2, "user_message", { body: "two", format: "plain_text" }),
    { ...item("pending", 3, "user_message", { body: "pending", format: "plain_text" }), status: "pending", committedAt: undefined },
  ];
  const snapshots = [{
    id: "snapshot-explicit",
    threadId: "thread-1",
    segmentId: "segment-a",
    projectionVersion: "v1",
    throughItemSequence: 2,
    summaryIds: [],
    sourceRefs: [
      { type: "conversation_item", id: "source-2" },
      { type: "conversation_item", id: "missing" },
      { type: "conversation_item", id: "pending" },
      { type: "conversation_item", id: "source-1" },
    ],
    policyVersion: "v1",
    createdAt: "2026-08-29T00:00:01.000Z",
  }];
  const result = resolveConversationContextSnapshots({ threadId: "thread-1", workspaceId: "workspace-1", items, snapshots });
  assert.deepEqual(result.snapshots[0].sourceItemIds, ["source-1", "source-2"]);
  assert.equal(result.snapshots[0].omittedItemCount, 2);
  assert.equal(result.diagnostics.length, 2);
});

test("context snapshot resolver rejects empty refs and cross-thread or invisible sources", () => {
  const visible = item("visible", 1, "user_message", { body: "visible", format: "plain_text" });
  const foreign = { ...visible, id: "foreign", threadId: "other-thread" };
  const snapshot = {
    id: "snapshot-invalid",
    threadId: "thread-1",
    segmentId: "segment-a",
    projectionVersion: "v1",
    throughItemSequence: 2,
    summaryIds: [],
    sourceRefs: [
      { type: "conversation_item", id: "foreign" },
      { type: "conversation_item", id: "visible" },
    ],
    policyVersion: "v1",
    createdAt: "2026-08-29T00:00:01.000Z",
  };
  const result = resolveConversationContextSnapshots({
    threadId: "thread-1",
    workspaceId: "workspace-1",
    items: [visible, foreign],
    snapshots: [snapshot],
    isVisible: (candidate) => candidate.id !== "visible",
  });
  assert.deepEqual(result.snapshots[0].sourceItemIds, []);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics.every((diagnostic) => diagnostic.code === "missing_context_source"), true);
});

test("detail adapter derives the shared surface policy from LingThread topology", () => {
  assert.equal(projectConversationDetailTimeline(detailFixture({ kind: "teammate_direct" })).items[0].kind, "userMessage");
  assert.equal(projectConversationDetailTimeline(detailFixture({ kind: "channel_discussion" })).diagnostics.length, 0);
  assert.equal(projectConversationDetailTimeline(detailFixture({ kind: "channel_discussion", parentThreadId: "root" })).diagnostics.length, 0);
  assert.equal(projectConversationDetailTimeline(detailFixture({ kind: "channel_discussion", parentThreadId: "root", forkedFromRunId: "run-1" })).diagnostics.length, 0);
});

test("normal, private, channel, topic, and branch keep one typed item grammar", () => {
  const topologies = [
    { kind: "conversation" },
    { kind: "teammate_direct" },
    { kind: "channel_discussion" },
    { kind: "channel_discussion", parentThreadId: "root" },
    { kind: "channel_discussion", parentThreadId: "root", forkedFromRunId: "run-1" },
  ];
  const signatures = topologies.map((thread) => projectConversationDetailTimeline(detailFixture(thread)).items.map((entry) => [entry.kind, entry.id, entry.threadSequence, entry.partIndex, entry.runId ?? ""].join(":")));
  assert.equal(new Set(signatures.map((entries) => entries.join("|"))).size, 1);
});

test("detail adapter joins approvals and artifacts by exact durable identity, never arbitrary run order", () => {
  const detail = detailFixture({ kind: "conversation" });
  detail.conversationItems = [
    item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
    item("tool-unrelated", 2, "tool_call", { toolCallId: "call-unrelated", toolName: "bash" }),
    item("approval-item", 3, "approval_request", { approvalRequestId: "approval-1" }),
    item("artifact-item", 4, "artifact_ref", { artifactId: "image-1" }),
    item("agent-1", 5, "assistant_message", { body: "Done", format: "markdown", streaming: false, deliveryStatus: "ready" }),
  ];
  detail.executionActions = [
    actionFixture("unrelated", "tool-unrelated", { toolCallId: "call-unrelated" }),
    actionFixture("approval-owner", "approval-item", { actionType: "approval", approvalId: "approval-1", status: "waiting_for_approval" }),
    actionFixture("artifact-owner", "artifact-item", { actionType: "read", resultArtifactIds: ["image-1"], sourceRefs: [{ kind: "conversation_item", id: "artifact-item" }, { kind: "run_event", id: "event-image" }] }),
  ];
  detail.approvals = [{
    id: "approval-1", runId: "run-1", actionType: "bash", risk: "medium", title: "Allow command", description: "Run the command", payload: {}, status: "pending", createdAt: detail.thread.createdAt,
  }];
  detail.artifacts = [{ id: "image-1", runId: "run-1", type: "image", path: "artifacts/result.png", title: "Result", contentType: "image/png", createdAt: detail.thread.createdAt }];

  const projection = projectConversationDetailTimeline(detail);
  const approval = projection.items.find((entry) => entry.kind === "approval");
  const image = projection.items.find((entry) => entry.kind === "imageView");
  assert.equal(approval?.actionId, "approval-owner");
  assert.equal(image?.actionId, "artifact-owner");
  assert.equal(image?.itemId, "artifact-item");
  assert.equal(projection.diagnostics.some((entry) => entry.code === "missing_anchor" || entry.code === "owner_conflict"), false);
});

test("detail adapter projects durable plan, compaction lineage, and a child Agent into the shared timeline", () => {
  const detail = detailFixture({ kind: "channel_discussion" });
  detail.conversationItems = [
    { ...detail.conversationItems[0], turnId: "turn-1" },
    detail.conversationItems[1],
    { ...item("child-tool", 3, "tool_call", { toolCallId: "child-call", toolName: "bash" }), turnId: "turn-2" },
    { ...item("child-agent", 4, "assistant_message", { body: "I checked the fixture.", format: "markdown", streaming: false, deliveryStatus: "ready" }), turnId: "turn-2" },
  ];
  detail.runLinks = [
    ...detail.runLinks,
    { runId: "run-child", turnId: "turn-2", attemptNumber: 1, role: "primary", createdAt: detail.thread.createdAt },
  ];
  detail.runs = [
    ...detail.runs,
    { id: "run-child", parentRunId: "run-1", teammateId: "qa", threadId: detail.thread.id, taskId: "task-child", status: "succeeded", cwd: detail.cwd, providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: "/tmp/child.log", createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt },
  ];
  detail.executionActions = [
    ...detail.executionActions,
    { ...actionFixture("delegate-1", "tool-1", { actionType: "delegate_agent", status: "succeeded", title: "Delegate QA", summary: "Run QA", sourceRefs: [{ kind: "conversation_item", id: "tool-1" }, { kind: "run", id: "run-child" }] }) },
    { ...actionFixture("child-action", "child-tool", { runId: "run-child", attemptId: "child-attempt", participantId: "qa", toolCallId: "child-call", sourceRefs: [{ kind: "conversation_item", id: "child-tool" }], title: "Run child check" }) },
  ];
  detail.plans = [{ id: "plan-1", workspaceId: detail.thread.workspaceId, threadId: detail.thread.id, sourceMessageId: "user-1", title: "Ship", bodyMarkdown: "- [x] Inspect\n- [ ] Verify", status: "accepted", createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt }];
  detail.compactionCheckpoints = [{ id: "compact-1", workspaceId: detail.thread.workspaceId, threadId: detail.thread.id, sourceTurnId: "turn-1", contextViewId: "snapshot-1", coveredItemSeqFrom: 1, coveredItemSeqTo: 2, coveredTurnIds: ["turn-1"], summaryIds: ["summary-1"], sourceRefs: [{ type: "conversation_item", id: "user-1" }], workspaceProvenanceWatermark: "w1", compactionPolicyVersion: "v1", createdAt: detail.thread.updatedAt }];
  detail.contextSnapshots = [{ id: "snapshot-1", threadId: detail.thread.id, segmentId: "segment-1", projectionVersion: "v1", throughItemSequence: 2, summaryIds: ["summary-1"], sourceRefs: [{ type: "context_summary", id: "summary-1" }, { type: "conversation_item", id: "user-1" }, { type: "conversation_item", id: "tool-1" }], policyVersion: "v1", createdAt: detail.thread.updatedAt }];
  detail.contextSummaries = [{ id: "summary-1", threadId: detail.thread.id, segmentId: "segment-1", scope: "segment", status: "active", version: 1, coveredFromSequence: 1, coveredThroughSequence: 2, objective: "Keep the parser stable", decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [], sourceRefs: [{ type: "conversation_item", id: "user-1" }, { type: "conversation_item", id: "tool-1" }], policyVersion: "v1", createdAt: detail.thread.updatedAt }];

  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.diagnostics.length, 0);
  assert.equal(projection.items.some((entry) => entry.kind === "plan"), true);
  assert.equal(projection.items.some((entry) => entry.kind === "contextCompaction"), true);
  assert.equal(projection.items.find((entry) => entry.kind === "contextCompaction")?.summary, "Keep the parser stable");
  const child = projection.items.find((entry) => entry.kind === "subAgentActivity");
  assert.equal(child?.participantId, "qa");
  assert.equal(child?.childItems.some((entry) => entry.kind === "commandExecution"), true);
  assert.equal(child?.childItems.some((entry) => entry.kind === "agentMessage"), true);
  assert.equal(child?.childItems.some((entry) => entry.kind === "diagnostic"), false);
  assert.equal(child?.childItems.some((entry) => entry.itemId === "tool-1"), false);
});

test("detail adapter fails closed when a plan or delegated run has no explicit anchor", () => {
  const detail = detailFixture({ kind: "conversation" });
  detail.plans = [{ id: "plan-unanchored", workspaceId: detail.thread.workspaceId, threadId: detail.thread.id, title: "Unanchored", bodyMarkdown: "- Verify", status: "draft", createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt }];
  detail.runs = [...detail.runs, { id: "run-child", parentRunId: "run-1", teammateId: "qa", threadId: detail.thread.id, taskId: "task-child", status: "running", cwd: detail.cwd, providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: "/tmp/child.log", createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt }];
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.items.some((entry) => entry.kind === "plan"), false);
  assert.equal(projection.items.some((entry) => entry.kind === "subAgentActivity"), false);
  assert.equal(projection.diagnostics.some((entry) => entry.code === "missing_anchor"), true);
});

test("detail reconnect merge keeps newer actions and durable records from both snapshots", () => {
  const current = detailFixture({ kind: "conversation" });
  current.executionActions = [actionFixture("action-1", "tool-1", { revision: 8, summary: "newer output" })];
  current.conversationItems = [
    item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
    item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    item("tool-2", 3, "tool_call", { toolCallId: "call-2", toolName: "bash" }),
  ];
  current.executionActions = [
    actionFixture("action-1", "tool-1", { revision: 8, summary: "newer output" }),
    actionFixture("action-2", "tool-2", { revision: 1, toolCallId: "call-2" }),
  ];
  current.plans = [{ id: "plan-current", workspaceId: current.thread.workspaceId, threadId: current.thread.id, sourceMessageId: "user-1", title: "Current", bodyMarkdown: "- Verify", status: "draft", createdAt: current.thread.createdAt, updatedAt: "2026-08-29T00:00:02.000Z" }];

  const reconnect = detailFixture({ kind: "conversation", updatedAt: "2026-08-29T00:00:03.000Z" });
  reconnect.conversationItems = [
    item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text" }),
    item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
    item("agent-1", 4, "assistant_message", { body: "Done", format: "markdown", streaming: false, deliveryStatus: "ready" }),
  ];
  reconnect.executionActions = [actionFixture("action-1", "tool-1", { revision: 7, summary: "stale reconnect output" })];
  reconnect.plans = [{ id: "plan-reconnect", workspaceId: reconnect.thread.workspaceId, threadId: reconnect.thread.id, sourceMessageId: "user-1", title: "Reconnect", bodyMarkdown: "- Rebuild", status: "accepted", createdAt: reconnect.thread.createdAt, updatedAt: reconnect.thread.updatedAt }];

  const merged = mergeConversationDetailSnapshots(current, reconnect);
  assert.equal(merged.executionActions.find((action) => action.id === "action-1")?.revision, 8);
  assert.equal(merged.executionActions.some((action) => action.id === "action-2"), true);
  assert.equal(merged.conversationItems.some((item) => item.id === "agent-1"), true);
  assert.deepEqual(merged.plans?.map((plan) => plan.id), ["plan-current", "plan-reconnect"]);
  const projection = projectConversationDetailTimeline(merged);
  assert.equal(projection.items.find((entry) => entry.actionId === "action-1")?.revision, 8);
});

test("detail reconnect merge is deterministic when snapshots arrive in either order", () => {
  const first = detailFixture({ kind: "conversation" });
  first.executionActions = [actionFixture("action-1", "tool-1", { revision: 2, summary: "first" })];
  const second = detailFixture({ kind: "conversation", updatedAt: "2026-08-29T00:00:02.000Z" });
  second.executionActions = [actionFixture("action-1", "tool-1", { revision: 3, summary: "second" })];
  const forward = projectConversationDetailTimeline(mergeConversationDetailSnapshots(first, second));
  const reverse = projectConversationDetailTimeline(mergeConversationDetailSnapshots(second, first));
  assert.deepEqual(forward.items, reverse.items);
  assert.deepEqual(forward.auditItems, reverse.auditItems);
  assert.deepEqual(forward.terminalEvidence, reverse.terminalEvidence);
});

test("detail adapter reports omitted durable collections instead of silently projecting an incomplete snapshot", () => {
  const detail = detailFixture({ kind: "conversation" });
  delete detail.plans;
  delete detail.compactionCheckpoints;
  delete detail.contextSnapshots;
  delete detail.contextSummaries;
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.diagnostics.filter((entry) => entry.code === "missing_lineage").length, 4);
});

test("detail adapter does not guess an action anchor from a lone generic item", () => {
  const detail = detailFixture({ kind: "conversation" });
  detail.executionActions = [actionFixture("unanchored", "tool-1", { sourceRefs: [], toolCallId: undefined })];
  const projection = projectConversationDetailTimeline(detail);
  assert.equal(projection.items.some((entry) => entry.actionId === "unanchored"), false);
  assert.equal(projection.diagnostics.some((entry) => entry.code === "missing_anchor"), true);
});
function detailFixture(threadOverrides = {}) {
  const now = "2026-08-29T00:00:00.000Z";
  return {
    cwd: "/tmp/workspace",
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      kind: "conversation",
      title: "Test",
      objective: "Test",
      status: "open",
      conversationMode: { mode: "default" },
      createdAt: now,
      updatedAt: now,
      ...threadOverrides,
    },
    turns: [{ id: "turn-1", threadId: "thread-1", workspaceId: "workspace-1", kind: "initial_request", status: "succeeded", title: "Test", userInstruction: "Inspect", createdByActor: "local-user", createdAt: now, updatedAt: now }],
    runLinks: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary", createdAt: now }],
    runs: [{ id: "run-1", threadId: "thread-1", taskId: "task-1", status: "succeeded", cwd: "/tmp/workspace", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: "/tmp/run.log", createdAt: now, updatedAt: now }],
    conversationItems: [
      item("user-1", 1, "user_message", { body: "Inspect", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] }),
      item("tool-1", 2, "tool_call", { toolCallId: "call-1", toolName: "bash" }),
      item("agent-1", 3, "assistant_message", { body: "Done", format: "markdown", streaming: false, deliveryStatus: "ready" }),
    ],
    executionActions: [{
      id: "action-1", revision: 7, workspaceId: "workspace-1", threadId: "thread-1", runId: "run-1", attemptId: "attempt-1", participantId: "ling", actionType: "bash", risk: "low", status: "succeeded", title: "Run command", summary: "ok", toolCallId: "call-1", targetRefs: [], previewArtifactIds: [], resultArtifactIds: [], sourceRefs: [], commandEvidence: { command: "node -v", latestEventSeq: 7, outputTail: [], outputByteCount: 0, outputTruncated: false }, createdAt: now,
    }],
    approvals: [], interventions: [], terminalReports: [], artifacts: [], plans: [], compactionCheckpoints: [], contextSnapshots: [], contextSummaries: [], messages: [], generatedMedia: [], defaults: {},
  };
}

function item(id, sequence, kind, payload) {
  return { schemaVersion: 1, id, workspaceId: "workspace-1", threadId: "thread-1", sequence, kind, status: "committed", actorType: kind === "user_message" ? "local_user" : "ling_agent", visibility: "channel", payload, domainRefs: [], revision: 1, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", committedAt: "2026-08-29T00:00:00.000Z" };
}

function actionFixture(id, anchorItemId, overrides = {}) {
  const now = "2026-08-29T00:00:00.000Z";
  return {
    id,
    revision: id === "unrelated" ? 1 : id === "approval-owner" ? 2 : 3,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    participantId: "ling",
    actionType: "bash",
    risk: "low",
    status: "succeeded",
    title: id,
    summary: id,
    targetRefs: [],
    previewArtifactIds: [],
    resultArtifactIds: [],
    sourceRefs: [{ kind: "conversation_item", id: anchorItemId }],
    commandEvidence: { command: "node -v", latestEventSeq: 1, outputTail: [], outputByteCount: 0, outputTruncated: false },
    createdAt: now,
    ...overrides,
  };
}
