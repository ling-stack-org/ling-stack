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
