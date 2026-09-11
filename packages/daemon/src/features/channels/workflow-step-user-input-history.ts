import type { ChannelWorkflowStep, ConversationItemV1, RunSession, UserInputTranscriptRunHistoryV1 } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";

type Ports = Pick<RunStore, "getLingThread" | "getLingTurnForRun" | "listConversationItemsForTurn" | "readUserInputTranscript">;

/** Called inside the step projection's read snapshot, after verifying the parent delegation. */
export function readWorkflowStepUserInputHistory(store: Ports, step: ChannelWorkflowStep, run: RunSession,
  parent: ConversationItemV1): UserInputTranscriptRunHistoryV1 | null {
  if (!run.threadId) return null;
  const thread = store.getLingThread(run.threadId), turn = store.getLingTurnForRun(run.id);
  if (!thread || !turn || thread.workspaceId !== step.workspaceId || thread.channelId !== step.channelId
    || thread.kind === "teammate_direct" || turn.threadId !== thread.id || turn.workspaceId !== step.workspaceId
    || turn.channelId !== step.channelId || run.workflowStepId !== step.id || run.teammateId !== step.toParticipantId
    || run.id !== step.runId || run.channelId !== step.channelId || parent.workspaceId !== step.workspaceId
    || parent.channelId !== step.channelId || parent.visibility !== "channel" || parent.status !== "committed") return null;
  const anchors = store.listConversationItemsForTurn({ turnId: turn.id }).filter(item =>
    item.workspaceId === step.workspaceId && item.channelId === step.channelId && item.threadId === thread.id
    && item.turnId === turn.id && item.status === "committed"
    && (item.kind === "user_input_request" || item.kind === "user_input_answer")
    && (item.visibility === "channel" || item.visibility === "thread_participants") && !item.visibilityOwnerId);
  const anchorIds = new Set(anchors.map(item => item.id));
  const userInputs = anchors.flatMap((_, index) => index % 500 === 0
    ? store.readUserInputTranscript({ threadId: thread.id, itemIds: anchors.slice(index, index + 500).map(item => item.id) }) : [])
    .filter(record => anchorIds.has(record.itemId) && record.availability === "available" && record.source.workspaceId === step.workspaceId
      && record.source.threadId === thread.id && record.source.turnId === turn.id && record.source.runId === run.id
      && record.source.participantId === step.toParticipantId && record.source.workflowStepId === step.id);
  const attempts = new Set(userInputs.flatMap(record => record.availability === "available" ? [record.source.attemptId] : []));
  if (attempts.size !== 1) return null;
  const ids = new Set(userInputs.map(record => record.itemId));
  return { workspaceId: step.workspaceId, threadId: thread.id, turnId: turn.id, runId: run.id,
    attemptId: [...attempts][0]!, participantId: step.toParticipantId, workflowStepId: step.id,
    parentItemId: parent.id, parentThreadId: parent.threadId, items: anchors.filter(item => ids.has(item.id)), userInputs };
}
