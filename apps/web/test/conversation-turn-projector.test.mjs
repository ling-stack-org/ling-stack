import assert from "node:assert/strict";
import test from "node:test";
import {
  projectMessageItem,
  projectMessageItems,
} from "../src/lib/channel-conversation-items.ts";
import { buildConversationTurnProjection } from "../src/lib/conversation-turn-projector.ts";

const thread = {
  id: "thread-1",
  workspaceId: "workspace_default",
  kind: "channel_discussion",
  status: "open",
  title: "Channel",
  objective: "Conversation",
  channelId: "channel-1",
  surfaceKind: "channel_root",
  relationKind: "root",
  nextItemSequence: 6,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:01:00.000Z",
};

const turn = {
  id: "turn-1",
  workspaceId: "workspace_default",
  threadId: thread.id,
  kind: "initial_request",
  status: "succeeded",
  title: "Request",
  userInstruction: "Inspect the workspace",
  channelId: "channel-1",
  sourceItemId: "item-user",
  createdByActor: "local-user",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:01:00.000Z",
};

const userItem = {
  schemaVersion: 1,
  id: "item-user",
  workspaceId: "workspace_default",
  channelId: "channel-1",
  threadId: thread.id,
  turnId: turn.id,
  sequence: 1,
  kind: "user_message",
  status: "committed",
  actorType: "local_user",
  visibility: "channel",
  payload: { body: "Inspect the workspace", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  domainRefs: [],
  revision: 1,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const assistantItem = {
  schemaVersion: 1,
  id: "item-assistant",
  workspaceId: "workspace_default",
  channelId: "channel-1",
  threadId: thread.id,
  turnId: turn.id,
  sequence: 2,
  kind: "assistant_message",
  status: "committed",
  actorType: "ling_agent",
  actorId: "ling-agent",
  visibility: "channel",
  payload: { body: "I will inspect it.", format: "markdown", streaming: false, deliveryStatus: "ready" },
  domainRefs: [],
  revision: 1,
  createdAt: "2026-08-10T00:00:01.000Z",
  updatedAt: "2026-08-10T00:00:01.000Z",
};

const toolCall = {
  schemaVersion: 1,
  id: "item-tool-call",
  workspaceId: "workspace_default",
  channelId: "channel-1",
  threadId: thread.id,
  turnId: turn.id,
  sequence: 3,
  kind: "tool_call",
  status: "committed",
  actorType: "ling_agent",
  actorId: "ling-agent",
  visibility: "channel",
  payload: { toolCallId: "tool-1", toolName: "read_file", title: "Read workspace file", inputSummary: "README.md" },
  domainRefs: [],
  revision: 1,
  createdAt: "2026-08-10T00:00:02.000Z",
  updatedAt: "2026-08-10T00:00:02.000Z",
};

const approvalRequest = {
  schemaVersion: 1,
  id: "item-approval",
  workspaceId: "workspace_default",
  channelId: "channel-1",
  threadId: thread.id,
  turnId: turn.id,
  sequence: 4,
  kind: "approval_request",
  status: "pending",
  actorType: "ling_agent",
  actorId: "ling-agent",
  visibility: "channel",
  payload: { approvalRequestId: "approval-1", title: "Allow workspace read", summary: "The agent needs read access." },
  domainRefs: [],
  revision: 1,
  createdAt: "2026-08-10T00:00:03.000Z",
  updatedAt: "2026-08-10T00:00:03.000Z",
};

const additionalItems = [
  {
    ...toolCall,
    id: "item-tool-result",
    sequence: 5,
    kind: "tool_result",
    payload: { toolCallId: "tool-1", status: "succeeded", outputSummary: "Read 1 file." },
  },
  {
    ...approvalRequest,
    id: "item-approval-decision",
    sequence: 6,
    kind: "approval_decision",
    status: "committed",
    payload: { approvalRequestId: "approval-1", decision: "approved", reason: "Approved for this turn." },
  },
  {
    ...toolCall,
    id: "item-handoff",
    sequence: 7,
    kind: "handoff",
    payload: { handoffId: "handoff-1", targetTeammateId: "designer", summary: "Design review requested." },
  },
  {
    ...toolCall,
    id: "item-operation-state",
    sequence: 8,
    kind: "operation_state",
    payload: { operationId: "operation-1", state: "running", title: "Inspect workspace", summary: "Inspection is running." },
  },
  {
    ...toolCall,
    id: "item-artifact",
    sequence: 9,
    kind: "artifact_ref",
    payload: { artifactId: "artifact-1", title: "README.md", artifactKind: "file" },
  },
  {
    ...toolCall,
    id: "item-system-event",
    sequence: 10,
    kind: "system_event",
    payload: { eventType: "context_compacted", summary: "Context was compacted." },
  },
].map((item) => ({
  ...item,
  createdAt: `2026-08-10T00:00:${String(item.sequence).padStart(2, "0")}.000Z`,
  updatedAt: `2026-08-10T00:00:${String(item.sequence).padStart(2, "0")}.000Z`,
}));

function projectionInput(overrides = {}) {
  return {
    channelId: "channel-1",
    messages: [projectMessageItem(userItem, [], thread), ...projectMessageItems([assistantItem], [], thread)],
    conversationItems: [userItem, assistantItem, toolCall, approvalRequest],
    proposals: [],
    intentDecisions: [],
    workflows: [],
    workflowSteps: [],
    runs: [],
    usedMemoryEvents: [],
    operationCellByWorkflowId: new Map(),
    operationCellByThreadId: new Map(),
    lingAgentAuthorId: "ling-agent",
    ...overrides,
  };
}

test("turn projection keeps execution items out of ordinary assistant prose", () => {
  const projection = buildConversationTurnProjection(projectionInput());
  const turnView = projection.turns[0];
  assert.ok(turnView);
  assert.deepEqual(turnView.blocks.map((block) => block.kind), [
    "coordinator_message",
    "conversation_item",
    "conversation_item",
  ]);
  assert.equal(turnView.blocks[1].item.kind, "tool_call");
  assert.equal(turnView.blocks[2].item.kind, "approval_request");
  assert.equal(turnView.blocks[2].status, "waiting_for_approval");
});

test("turn projection does not duplicate items already represented by a work cell", () => {
  const operationCell = {
    id: "work-cell:turn:turn-1",
    sourceKind: "run_thread",
    threadId: thread.id,
    turnId: turn.id,
    anchorRunId: "run-1",
    runIds: ["run-1"],
    mode: "completed",
    status: "succeeded",
    title: "Inspect workspace",
    summary: "Finished",
    stats: [],
    operationRows: [],
    agentSpans: [],
    agentBranches: [],
    terminalReportRows: [],
    activeRows: [],
    groups: [],
    evidenceLinks: [],
    artifactStripItems: [],
    updatedAt: "2026-08-10T00:00:05.000Z",
  };
  const workflow = { id: "workflow-1", channelId: "channel-1", updatedAt: "2026-08-10T00:00:04.000Z", metadata: { sourceMessageId: userItem.id } };
  const proposal = { id: "proposal-1", channelId: "channel-1", sourceMessageId: userItem.id, status: "accepted", linkedWorkflowId: workflow.id, updatedAt: "2026-08-10T00:00:04.000Z" };
  const coveredTool = { ...toolCall, domainRefs: [{ type: "run", id: "run-1" }] };
  const projection = buildConversationTurnProjection(projectionInput({
    conversationItems: [userItem, assistantItem, coveredTool],
    proposals: [proposal],
    workflows: [workflow],
    operationCellByWorkflowId: new Map([[workflow.id, operationCell]]),
  }));
  const turnView = projection.turns[0];
  assert.ok(turnView);
  assert.equal(turnView.blocks.some((block) => block.kind === "conversation_item"), false);
  assert.equal(turnView.blocks.some((block) => block.kind === "operation"), true);
});

test("turn projection gives every canonical execution kind a stable structured block", () => {
  const projection = buildConversationTurnProjection(projectionInput({
    conversationItems: [userItem, assistantItem, toolCall, approvalRequest, ...additionalItems],
  }));
  const turnView = projection.turns[0];
  assert.ok(turnView);
  const itemBlocks = turnView.blocks.filter((block) => block.kind === "conversation_item");
  assert.deepEqual(itemBlocks.map((block) => block.item.kind), [
    "tool_call",
    "approval_request",
    "tool_result",
    "approval_decision",
    "handoff",
    "operation_state",
    "artifact_ref",
    "system_event",
  ]);
  assert.deepEqual(itemBlocks.map((block) => block.id), itemBlocks.map((block) => `conversation-item:${block.item.id}`));
  assert.equal(itemBlocks.find((block) => block.item.kind === "approval_request")?.status, "waiting_for_approval");
  assert.equal(itemBlocks.find((block) => block.item.kind === "operation_state")?.status, "running");
  assert.deepEqual(itemBlocks.find((block) => block.item.kind === "artifact_ref")?.previewTargets, [{
    id: "artifact:artifact-1",
    kind: "artifact",
    label: "README.md",
  }]);
  assert.equal(projection.hiddenActivityIds.has("message:item-system-event"), true);
});

test("turn projection fails closed for agent-private canonical items", () => {
  const privateItem = {
    ...toolCall,
    id: "item-private-tool",
    sequence: 11,
    visibility: "agent_private",
    visibilityOwnerId: "ling-agent",
  };
  const projection = buildConversationTurnProjection(projectionInput({
    conversationItems: [userItem, assistantItem, privateItem],
  }));
  assert.equal(projection.turns[0]?.blocks.some((block) => block.kind === "conversation_item" && block.item.id === privateItem.id), false);
});

test("turn projection maps item failure, pending, approval, and operation states", () => {
  const item = (overrides) => ({
    ...toolCall,
    ...overrides,
    turnId: turn.id,
    domainRefs: [],
    payload: { ...toolCall.payload, ...(overrides.payload ?? {}) },
  });
  const statusItems = [
    item({ id: "item-failed", sequence: 20, status: "failed", payload: { outputSummary: "failed" } }),
    item({ id: "item-pending", sequence: 21, status: "pending", payload: { outputSummary: "pending" } }),
    { ...approvalRequest, id: "item-waiting", sequence: 22, status: "pending" },
    { ...toolCall, id: "item-succeeded", sequence: 23, status: "committed" },
    { ...toolCall, id: "item-operation-failed", sequence: 24, kind: "operation_state", payload: { operationId: "op-failed", state: "failed", title: "Failed", summary: "Failed" } },
    { ...toolCall, id: "item-operation-cancelled", sequence: 25, kind: "operation_state", payload: { operationId: "op-cancelled", state: "cancelled", title: "Cancelled", summary: "Cancelled" } },
    { ...toolCall, id: "item-operation-succeeded", sequence: 26, kind: "operation_state", payload: { operationId: "op-succeeded", state: "succeeded", title: "Succeeded", summary: "Succeeded" } },
  ];
  const projection = buildConversationTurnProjection(projectionInput({
    conversationItems: [userItem, assistantItem, ...statusItems],
  }));
  const blocks = projection.turns[0].blocks.filter((block) => block.kind === "conversation_item");
  const statusById = new Map(blocks.map((block) => [block.item.id, block.status]));
  assert.deepEqual(Object.fromEntries(statusById), {
    "item-failed": "failed",
    "item-pending": "running",
    "item-waiting": "waiting_for_approval",
    "item-succeeded": "succeeded",
    "item-operation-failed": "failed",
    "item-operation-cancelled": "cancelled",
    "item-operation-succeeded": "succeeded",
  });
});

test("thread-scoped legacy items do not leak between multiple root messages", () => {
  const secondRoot = {
    ...projectMessageItem(userItem, [], thread),
    id: "item-user-2",
    body: "Second request",
    threadId: thread.id,
    turnId: "turn-2",
  };
  const secondTurnItem = {
    ...toolCall,
    id: "item-second-tool",
    turnId: undefined,
    sequence: 31,
    domainRefs: [{ type: "conversation_item", id: secondRoot.id }],
  };
  const projection = buildConversationTurnProjection(projectionInput({
    messages: [projectMessageItem(userItem, [], thread), secondRoot],
    conversationItems: [userItem, assistantItem, secondTurnItem],
  }));
  const firstBlocks = projection.turns.find((candidate) => candidate.sourceMessageId === userItem.id)?.blocks ?? [];
  assert.equal(firstBlocks.some((block) => block.kind === "conversation_item" && block.item.id === secondTurnItem.id), false);
});

test("operation-covered items are suppressed for workflow, thread, operation, state, and anchor refs", () => {
  const operationCell = {
    id: "work-cell:turn:turn-1",
    sourceKind: "run_thread",
    threadId: thread.id,
    turnId: turn.id,
    anchorRunId: "run-anchor",
    runIds: ["run-covered"],
    mode: "completed",
    status: "succeeded",
    title: "Inspect workspace",
    summary: "Finished",
    stats: [], operationRows: [], agentSpans: [], agentBranches: [], terminalReportRows: [], activeRows: [], groups: [], evidenceLinks: [], artifactStripItems: [],
    updatedAt: "2026-08-10T00:00:05.000Z",
  };
  const workflow = { id: "workflow-covered", channelId: "channel-1", updatedAt: "2026-08-10T00:00:04.000Z", metadata: { sourceMessageId: userItem.id } };
  const refItems = [
    { ...toolCall, id: "covered-workflow", domainRefs: [{ type: "workflow", id: workflow.id }] },
    { ...toolCall, id: "covered-thread", domainRefs: [{ type: "thread", id: thread.id }] },
    { ...toolCall, id: "covered-operation", domainRefs: [{ type: "operation", id: operationCell.id }] },
    { ...toolCall, id: "covered-state", kind: "operation_state", payload: { operationId: operationCell.id, state: "running", title: "Running", summary: "Running" } },
    { ...toolCall, id: "covered-anchor", domainRefs: [{ type: "run", id: operationCell.anchorRunId }] },
  ].map((item, index) => ({ ...item, sequence: 40 + index }));
  const proposal = { id: "proposal-covered", channelId: "channel-1", sourceMessageId: userItem.id, status: "accepted", linkedWorkflowId: workflow.id, updatedAt: "2026-08-10T00:00:04.000Z" };
  const projection = buildConversationTurnProjection(projectionInput({
    conversationItems: [userItem, assistantItem, ...refItems],
    proposals: [proposal],
    workflows: [workflow],
    operationCellByWorkflowId: new Map([[workflow.id, operationCell]]),
  }));
  const remaining = projection.turns[0].blocks.filter((block) => block.kind === "conversation_item");
  assert.deepEqual(remaining.map((block) => block.item.id), ["covered-anchor"]);
  assert.equal(projection.turns[0].blocks.some((block) => block.kind === "operation"), true);

  const runOperation = { ...operationCell, id: "work-cell:run:thread-1", runIds: ["run-covered"], anchorRunId: "run-anchor" };
  const runProposal = { ...proposal, id: "proposal-run-covered", linkedWorkflowId: undefined, linkedRunId: "run-covered" };
  const runProjection = buildConversationTurnProjection(projectionInput({
    conversationItems: [userItem, assistantItem, { ...refItems[4], domainRefs: [{ type: "run", id: runOperation.anchorRunId }] }],
    proposals: [runProposal],
    workflows: [],
    operationCellByWorkflowId: new Map(),
    operationCellByThreadId: new Map([[thread.id, runOperation]]),
    runs: [{ id: "run-covered", threadId: thread.id }],
  }));
  assert.equal(runProjection.turns[0].blocks.some((block) => block.kind === "conversation_item"), false);
});

test("turn projection falls back to thread-scoped items when a legacy item has no turn id", () => {
  const legacyTool = {
    ...toolCall,
    id: "item-legacy-tool",
    turnId: undefined,
    sequence: 12,
    domainRefs: [{ type: "conversation_item", id: userItem.id }],
  };
  const projection = buildConversationTurnProjection(projectionInput({
    conversationItems: [userItem, assistantItem, legacyTool],
  }));
  assert.equal(projection.turns[0]?.blocks.some((block) => block.kind === "conversation_item" && block.item.id === legacyTool.id), true);
});
