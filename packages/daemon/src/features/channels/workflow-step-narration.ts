import type { ChannelWorkflowStep } from "@ling-stack/contracts";
import { redactSecrets, type RunStore } from "@ling-stack/core";
import { readRunNarrationSnapshot } from "../conversations/narration-segments.js";
import { readWorkflowStepUserInputHistory } from "./workflow-step-user-input-history.js";

type NarrationStore = Pick<RunStore, "getRun" | "getChannelWorkflow" | "getConversationItem" | "listEvents"
  | "getChannelWorkflowStep" | "readSnapshot" | "getLingThread" | "getLingTurnForRun" | "listConversationItemsForTurn" | "readUserInputTranscript">;

/**
 * Read the selected child run's durable messages. Step/run/participant and the
 * parent canonical anchor must agree before any text crosses the API boundary.
 * No history writes, execution authorization, or completion inference occur here.
 */
export function projectWorkflowStepNarration(store: NarrationStore, step: ChannelWorkflowStep): ChannelWorkflowStep {
  return store.readSnapshot(() => {
    const current = store.getChannelWorkflowStep(step.id);
    return current ? projectWithinSnapshot(store, current) : { ...step, runNarration: null, runUserInputHistory: null };
  });
}

function projectWithinSnapshot(store: NarrationStore, step: ChannelWorkflowStep): ChannelWorkflowStep {
  const empty = { ...step, runNarration: null, runUserInputHistory: null };
  if (!step.runId) return empty;
  const run = store.getRun(step.runId);
  const workflow = store.getChannelWorkflow(step.workflowId);
  const sourceId = workflow?.metadata?.sourceMessageId;
  const source = sourceId ? store.getConversationItem(sourceId) : undefined;
  if (!run || !workflow || !source || run.id !== step.runId || workflow.id !== step.workflowId
    || run.workflowStepId !== step.id || run.teammateId !== step.toParticipantId
    || run.channelId !== step.channelId || workflow.channelId !== step.channelId
    || workflow.workspaceId !== step.workspaceId || source.workspaceId !== step.workspaceId
    || source.channelId !== step.channelId || source.visibility !== "channel" || source.kind !== "user_message"
    || source.status !== "committed" || !source.turnId
    || (workflow.metadata?.sourceTurnId && source.turnId !== workflow.metadata.sourceTurnId)) return empty;
  const attempts = new Set<string>();
  const snapshot = readRunNarrationSnapshot({ listEvents(runId, options) {
    const events = store.listEvents(runId, options);
    for (const event of events) {
      if (event.runId !== runId) continue;
      if ("attemptId" in event.data && typeof event.data.attemptId === "string" && event.data.attemptId.trim()) attempts.add(event.data.attemptId);
    }
    return events;
  } }, run.id);
  // A run spanning conflicting attempts cannot assign narrative ownership safely.
  if (attempts.size > 1) return empty;
  return { ...step, runUserInputHistory: readWorkflowStepUserInputHistory(store, step, run, source), runNarration: {
    runId: run.id, participantId: step.toParticipantId, workflowStepId: step.id,
    threadId: source.threadId, turnId: source.turnId, sourceItemId: source.id, sourceItemSequence: source.sequence,
    attemptId: [...attempts][0],
    segments: snapshot.narrationSegments.map(segment => ({ ...segment, content: String(redactSecrets(segment.content)) })),
  } };
}
