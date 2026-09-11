import {
  batchCanonicalTranscriptItems, mergeConversationRunNarration, projectConversationRunNarration, projectConversationTimelineItems,
  type ConversationTimelineItem, type ConversationTimelineMessageItem, type ConversationWorkCellRow,
} from "@ling-stack/conversation-ui-core";
import type { ChannelWorkflowStep, ExecutionAction } from "../types.js";
import { interleaveWorkflowChildUserInputs } from "./workflow-child-user-input.js";

/** Adapt Host-owned child messages and atomic actions, never the workflow plan skeleton. */
export function projectWorkflowChildTimeline(input: {
  readonly steps: readonly ChannelWorkflowStep[];
  readonly rows: readonly ConversationWorkCellRow[];
  readonly actions: readonly ExecutionAction[];
  readonly participantId: string;
  readonly parentItemId?: string;
  readonly contextSegmentIdByItemId?: ReadonlyMap<string, string>;
}): readonly ConversationTimelineItem[] | undefined {
  const actionsById = new Map(input.actions.map(action => [action.id, action]));
  return input.steps.flatMap((step, stepIndex) => {
    const rows = input.rows.filter(row => {
      const action = row.operationExecution ? actionsById.get(row.operationExecution.actionId) : undefined;
      return row.operationExecution?.workflowStepId === step.id && action
        && row.operationExecution.runId === action.runId
        && (!action.workflowStepId || action.workflowStepId === step.id)
        && (!row.operationExecution.participantId || row.operationExecution.participantId === input.participantId)
        && (!action.participantId || action.participantId === input.participantId);
    });
    const atomic = projectConversationTimelineItems(rows, { participantScope: input.participantId }).map(item => {
      const action = item.actionId ? actionsById.get(item.actionId) : undefined;
      return { ...item, sourceEventSequence: action?.sourceEventSequence };
    });
    const narration = step.runNarration;
    const ownActions = input.actions.filter(action => action.runId === step.runId);
    const attempts = new Set(ownActions.flatMap(action => action.attemptId ? [action.attemptId] : []));
    const ownsNarration = narration && narration.runId === step.runId && narration.workflowStepId === step.id
      && narration.participantId === input.participantId && narration.participantId === step.toParticipantId
      && narration.sourceItemId.trim() && narration.threadId.trim() && narration.turnId.trim()
      && attempts.size <= 1 && (!narration.attemptId || attempts.size === 0 || attempts.has(narration.attemptId));
    if (!ownsNarration) return positionAndBatch(atomic, stepIndex, input.contextSegmentIdByItemId);
    const attemptId = narration.attemptId ?? [...attempts][0];
    const message: ConversationTimelineMessageItem = {
      id: `workflow-narration:${step.id}:${narration.runId}`, kind: "agentMessage",
      revision: narration.segments.at(-1)?.endEventSequence ?? 0,
      threadSequence: stepIndex, partIndex: 0,
      status: step.status === "succeeded" || step.status === "skipped" ? "succeeded" : step.status === "failed" ? "failed" : step.status === "cancelled" ? "cancelled" : "running",
      phase: "commentary", markdown: "", itemId: narration.sourceItemId,
      turnId: narration.turnId, runId: narration.runId, participantId: narration.participantId, attemptId, workflowStepId: step.id,
      sourceRefs: [
        { kind: "conversation_item", id: narration.sourceItemId },
        { kind: "run", id: narration.runId }, { kind: "participant", id: narration.participantId },
        { kind: "workflow_step", id: step.id }, ...(attemptId ? [{ kind: "attempt", id: attemptId }] : []),
      ],
    };
    // Child ownership was validated above from the Host's enclosing step/run
    // envelope. Normal/private per-segment ownership is a different source.
    const messages = projectConversationRunNarration({ message, segments: narration.segments, runId: narration.runId, anchor: message })
      .map(row => ({
        ...row, attemptId, participantId: narration.participantId, workflowStepId: step.id,
        sourceRefs: [
          ...row.sourceRefs.filter(ref => ref.kind !== "attempt" && ref.kind !== "participant"),
          { kind: "participant", id: narration.participantId }, ...(attemptId ? [{ kind: "attempt", id: attemptId }] : []),
        ],
      }));
    const merged = interleaveWorkflowChildUserInputs({ step, participantId: input.participantId,
      parentItemId: input.parentItemId, items: mergeConversationRunNarration(atomic, messages) });
    // Event sequences are local to a run. Dense positions preserve step order
    // without comparing sequence 1 in a retry/teammate with another run's 100.
    return positionAndBatch(merged, stepIndex, input.contextSegmentIdByItemId);
  });
}

function positionAndBatch(
  items: readonly ConversationTimelineItem[],
  threadSequence: number,
  contextSegmentIdByItemId: ReadonlyMap<string, string> | undefined,
): readonly ConversationTimelineItem[] {
  const positioned = items.map((item, partIndex) => ({ ...item, threadSequence, partIndex }));
  return contextSegmentIdByItemId
    ? batchCanonicalTranscriptItems(positioned, { contextSegmentIdByItemId })
    : positioned;
}
