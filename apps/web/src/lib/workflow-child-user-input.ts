import {
  interleaveUserInputRunTimeline, projectCanonicalUserInputTimeline, reconcileCanonicalUserInputs,
  type ConversationTimelineItem,
} from "@ling-stack/conversation-ui-core";
import type { ChannelWorkflowStep, UserInputTranscriptRunHistoryV1 } from "../types.js";

/** The parent delegation, child thread and selected attempt are separate bindings. */
function ownsHistory(step: ChannelWorkflowStep, history: UserInputTranscriptRunHistoryV1): boolean {
  const narration = step.runNarration;
  return !!narration && history.workspaceId === step.workspaceId && history.runId === step.runId
    && history.workflowStepId === step.id && history.participantId === step.toParticipantId
    && narration.runId === step.runId && narration.workflowStepId === step.id
    && narration.participantId === step.toParticipantId && narration.sourceItemId === history.parentItemId
    && narration.threadId === history.parentThreadId && (!narration.attemptId || narration.attemptId === history.attemptId)
    && [history.threadId, history.turnId, history.attemptId, history.parentItemId, history.parentThreadId]
      .every(value => typeof value === "string" && value.trim().length > 0);
}

/** Read-only insertion before batching. An ordering failure carries no answer body or execution evidence. */
export function interleaveWorkflowChildUserInputs(input: {
  readonly step: ChannelWorkflowStep;
  readonly participantId: string;
  readonly parentItemId?: string;
  readonly items: readonly ConversationTimelineItem[];
}): readonly ConversationTimelineItem[] {
  const { step } = input, history = step.runUserInputHistory;
  if (!history || !ownsHistory(step, history) || history.parentItemId !== input.parentItemId
    || history.participantId !== input.participantId) return input.items;
  const scope = { surface: "child" as const, depth: 1 as const, workspaceId: history.workspaceId,
    threadId: history.threadId, turnId: history.turnId, runId: history.runId, attemptId: history.attemptId,
    participantId: history.participantId, workflowStepId: history.workflowStepId };
  const userInputs = projectCanonicalUserInputTimeline({ scope, items: history.items, userInputs: history.userInputs })
    .filter(row => row.workflowStepId === step.id);
  const merged = interleaveUserInputRunTimeline({ scope, items: input.items, userInputs });
  if (merged.unplaced.length === 0) return merged.items;
  return [...merged.items, {
    id: `user-input-order:${step.id}:${history.runId}`, kind: "diagnostic", code: "user_input_order_unavailable",
    revision: Math.max(...merged.unplaced.map(row => row.revision)), threadSequence: 0, partIndex: 0,
    title: "Activity unavailable", description: "Question history has no verified position in this run.",
    runId: history.runId, attemptId: history.attemptId, participantId: history.participantId,
    workflowStepId: step.id, sourceRefs: merged.unplaced.flatMap(row => row.sourceRefs),
  }];
}

/** Q/A revisions advance independently of narration. Reuse canonical anti-rollback rules. */
export function mergeWorkflowChildUserInputHistory(current: ChannelWorkflowStep, incoming: ChannelWorkflowStep): ChannelWorkflowStep["runUserInputHistory"] {
  const before = current.runUserInputHistory, after = incoming.runUserInputHistory;
  if (after === undefined) return before;
  if (after && !ownsHistory(incoming, after)) return before;
  if (before && after && ["workspaceId", "threadId", "turnId", "runId", "attemptId", "participantId", "workflowStepId", "parentItemId", "parentThreadId"]
    .some(key => before[key as keyof UserInputTranscriptRunHistoryV1] !== after[key as keyof UserInputTranscriptRunHistoryV1])) return before;
  if (!before && !after) return null;
  const binding = after ?? before!;
  const snapshot = reconcileCanonicalUserInputs({ scope: binding, current: before ?? undefined,
    incoming: after ?? { items: [], userInputs: [] }, mode: "full" });
  const merged = { ...binding, ...snapshot };
  return JSON.stringify(merged) === JSON.stringify(before) ? before : merged;
}
