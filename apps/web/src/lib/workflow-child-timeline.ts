import {
  batchCanonicalTranscriptItems, mergeConversationRunNarration, parseUnverifiedBlockedNarration,
  projectConversationRunNarration, projectConversationTimelineItems,
  type ConversationTimelineItem, type ConversationTimelineMessageItem, type ConversationWorkCellRow,
} from "@ling-stack/conversation-ui-core";
import { isDelegatedOutcomeV1 } from "@ling-stack/contracts";
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
    const blockedOutcome = matchingBlockedOutcome(step, narration, attemptId, input.parentItemId);
    const messageStatus = step.status === "succeeded" || step.status === "skipped" ? "succeeded"
      : step.status === "failed" ? "failed" : step.status === "cancelled" ? "cancelled"
      : step.status === "blocked" ? "blocked" : "running";
    const message: ConversationTimelineMessageItem = {
      id: `workflow-narration:${step.id}:${narration.runId}`, kind: "agentMessage",
      revision: narration.segments.at(-1)?.endEventSequence ?? 0,
      threadSequence: stepIndex, partIndex: 0,
      // Completion comes from the validated Host step, never narrative text.
      // The narration projector leaves earlier segments as commentary and
      // assigns this phase only to the final segment of the settled child.
      status: messageStatus,
      phase: messageStatus === "running" ? "commentary" : "final", markdown: "", itemId: narration.sourceItemId,
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
      .map((row, index): ConversationTimelineItem => {
        const scoped = {
          ...row, attemptId, participantId: narration.participantId, workflowStepId: step.id,
          sourceRefs: [
            ...row.sourceRefs.filter(ref => ref.kind !== "attempt" && ref.kind !== "participant"),
            { kind: "participant", id: narration.participantId }, ...(attemptId ? [{ kind: "attempt", id: attemptId }] : []),
          ],
        };
        const segment = narration.segments[index]!;
        const source = segment.source;
        const ownSegment = !source || source.workspaceId === step.workspaceId && source.threadId === narration.threadId
          && source.turnId === narration.turnId && source.runId === narration.runId
          && source.attemptId === attemptId && source.participantId === narration.participantId
          && typeof source.workUnitId === "string" && source.workUnitId.trim().length > 0;
        const explanation = blockedOutcome && ownSegment && segment.completed && row.phase === "final"
          ? parseUnverifiedBlockedNarration(row.markdown) : undefined;
        if (!explanation || !blockedOutcome) return scoped;
        const { markdown: _markdown, phase: _phase, logicalMessageId: _logical, waitingPlaceholder: _waiting, ...base } = scoped;
        return { ...base, kind: "protocolEvent", protocolKind: "workflow-step", title: "Task blocked",
          blockedExplanation: { ...explanation, hostCode: "required_operation_evidence_missing", hostReason: blockedOutcome.reason } };
      });
    const scopedAtomic = atomic.map(item => item.runId === narration.runId && item.attemptId === attemptId
      && item.participantId === narration.participantId ? { ...item, turnId: narration.turnId } : item);
    const merged = interleaveWorkflowChildUserInputs({ step, participantId: input.participantId,
      parentItemId: input.parentItemId, items: mergeConversationRunNarration(scopedAtomic, messages) });
    // Event sequences are local to a run. Dense positions preserve step order
    // without comparing sequence 1 in a retry/teammate with another run's 100.
    return positionAndBatch(merged, stepIndex, input.contextSegmentIdByItemId);
  });
}

function matchingBlockedOutcome(
  step: ChannelWorkflowStep,
  narration: NonNullable<ChannelWorkflowStep["runNarration"]>,
  attemptId: string | undefined,
  parentItemId: string | undefined,
) {
  const outcome = step.metadata?.delegatedOutcome;
  const sourceItemId = parentItemId ?? step.metadata?.sourceMessageId;
  if (step.status !== "blocked" || !isDelegatedOutcomeV1(outcome) || outcome.kind !== "blocked"
    || outcome.code !== "required_operation_evidence_missing"
    || outcome.workflowId !== step.workflowId || outcome.workflowStepId !== step.id
    || outcome.participantId !== step.toParticipantId || outcome.participantId !== narration.participantId
    || outcome.lineage.runId !== step.runId || outcome.lineage.runId !== narration.runId
    || !attemptId?.trim() || outcome.lineage.attemptId !== attemptId || narration.attemptId !== attemptId
    || !sourceItemId?.trim() || sourceItemId !== narration.sourceItemId
    || (step.metadata?.sourceMessageId && step.metadata.sourceMessageId !== sourceItemId)) return undefined;
  const expectedRefs: Readonly<Record<string, string>> = {
    workflow: step.workflowId, workflow_step: step.id, run: narration.runId, attempt: attemptId,
    conversation_item: sourceItemId,
  };
  // The contract validates required refs and uniqueness. Reject additional refs
  // to another owning run/attempt/source as well, rather than guessing lineage.
  if (outcome.lineage.sourceRefs.some(ref => Object.hasOwn(expectedRefs, ref.type) && expectedRefs[ref.type] !== ref.id)) return undefined;
  return outcome;
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
