import assert from "node:assert/strict";
import test from "node:test";
import { collectConversationTimelineViewRetainKeys } from "../src/shared/conversation/timeline/conversation-timeline-view-retain-keys.ts";

const lineage = {
  revision: 1,
  threadSequence: 1,
  partIndex: 0,
  runId: "run_1",
  attemptId: "attempt_1",
  participantId: "agent_1",
  workflowStepId: "step_1",
  sourceRefs: [],
};

function command(id, actionId) {
  return {
    ...lineage,
    id,
    kind: "commandExecution",
    actionId,
    title: `Run ${id}`,
    command: id,
    risk: "low",
    outputTail: [],
    outputTruncated: false,
  };
}

test("timeline retain keys include batches, hidden children, and nested Agent items", () => {
  const leading = {
    ...lineage,
    id: "reasoning:leading",
    kind: "reasoning",
    title: "Inspect first",
    summary: "Inspect first",
  };
  const batchedCommand = { ...command("command:batched", "action_batched"), leadingItems: [leading] };
  const nestedCommand = command("command:nested", "action_nested");
  const items = [
    {
      ...lineage,
      id: "batch:commands",
      kind: "commandBatch",
      actionId: "action_batched",
      actionIds: ["action_batched"],
      childActionIds: ["action_batched"],
      childItemIds: [batchedCommand.id],
      batch: {
        id: "command-batch-view:1",
        revision: 1,
        revisionKey: "1",
        commandCount: 1,
        defaultExpanded: false,
        actionIds: ["action_batched"],
        childActionIds: ["action_batched"],
        childItemIds: [batchedCommand.id],
        runId: lineage.runId,
        attemptId: lineage.attemptId,
        participantId: lineage.participantId,
        workflowStepId: lineage.workflowStepId,
        sourceRefs: [],
        commands: [batchedCommand],
      },
    },
    {
      revision: 1,
      threadSequence: 2,
      partIndex: 0,
      id: "sub-agent:1",
      kind: "subAgentActivity",
      participantId: "agent_2",
      runId: "run_2",
      attemptId: "attempt_2",
      workflowStepId: null,
      label: "Agent 2",
      lifecycle: "completed",
      sourceRefs: [],
      childItems: [nestedCommand],
    },
  ];

  const keys = collectConversationTimelineViewRetainKeys(items, {
    blockIds: new Set(["legacy:block"]),
    spanIds: new Set(["legacy:span"]),
    actionIds: new Set(["legacy:action"]),
  });

  assert.deepEqual([...keys.blockIds].sort(), [
    "command-batch-view:1",
    "legacy:block",
    "timeline-item:command:batched",
    "timeline-item:command:nested",
    "timeline-item:reasoning:leading",
    "timeline-sub-agent:sub-agent:1",
  ]);
  assert.deepEqual([...keys.spanIds], ["legacy:span"]);
  assert.deepEqual([...keys.actionIds].sort(), ["action_batched", "action_nested", "legacy:action"]);
});
