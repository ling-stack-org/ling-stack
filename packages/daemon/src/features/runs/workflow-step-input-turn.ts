import type { LingThread, LingTurn, LingTurnKind, RunStore } from "@ling-stack/core";
import type { RunRequest } from "./schemas.js";

/**
 * Persist the Host-dispatched canonical input owned by one workflow-step
 * Thread. The root channel item remains delegation authority through domain
 * refs and is never reused as this child Turn's direct source.
 */
export function ensureWorkflowStepInputTurn(
  store: RunStore,
  thread: LingThread,
  runRequest: RunRequest,
  turnKind: LingTurnKind,
  now: string,
): LingTurn {
  const stepId = runRequest.workflowStepId!;
  const step = store.getChannelWorkflowStep(stepId);
  const workflow = step ? store.getChannelWorkflow(step.workflowId) : undefined;
  const parentItemId = step?.metadata?.sourceMessageId ?? workflow?.metadata?.sourceMessageId;
  const parentItem = parentItemId ? store.getConversationItem(parentItemId) : undefined;
  const parentTurn = parentItem?.turnId ? store.getLingTurn(parentItem.turnId) : undefined;
  const parentThread = parentItem ? store.getLingThread(parentItem.threadId) : undefined;
  if (!step || !workflow || !runRequest.workflowStartOwner
    || thread.kind !== "workflow_step" || thread.status === "archived" || thread.status === "cancelled" || Boolean(thread.archivedAt)
    || step.workspaceId !== thread.workspaceId || workflow.workspaceId !== thread.workspaceId
    || workflow.id !== step.workflowId || workflow.channelId !== step.channelId
    || thread.workflowId !== workflow.id || thread.workflowStepId !== step.id
    || thread.channelId !== step.channelId || parentItemId !== runRequest.sourceMessageId
    || step.taskId !== runRequest.task.id || step.toParticipantId !== runRequest.teammateId
    || thread.teammateId !== step.toParticipantId || runRequest.task.channelId !== step.channelId) {
    throw new Error(`Workflow step source lineage is invalid: ${stepId}`);
  }
  if (parentItemId) {
    if (!parentItem || !parentTurn || !parentThread
      || parentThread.status === "archived" || parentThread.status === "cancelled" || Boolean(parentThread.archivedAt)
      || parentTurn.status === "cancelled" || parentTurn.status === "superseded"
      || parentItem.workspaceId !== thread.workspaceId || parentTurn.workspaceId !== thread.workspaceId
      || parentThread.workspaceId !== thread.workspaceId
      || parentItem.status !== "committed" || parentItem.kind !== "user_message"
      || parentItem.visibility !== "channel" || parentItem.channelId !== step.channelId
      || parentTurn.id !== parentItem.turnId || parentTurn.threadId !== parentItem.threadId
      || parentTurn.sourceItemId !== parentItem.id || parentTurn.channelId !== step.channelId
      || parentThread.id !== parentItem.threadId || parentThread.channelId !== step.channelId
      || (step.metadata?.sourceMessageId !== undefined && step.metadata.sourceMessageId !== parentItem.id)
      || (workflow.metadata?.sourceMessageId !== undefined && workflow.metadata.sourceMessageId !== parentItem.id)
      || (workflow.metadata?.sourceTurnId !== undefined && workflow.metadata.sourceTurnId !== parentTurn.id)) {
      throw new Error(`Workflow step source lineage is invalid: ${stepId}`);
    }
  } else if (workflow.metadata?.sourceTurnId !== undefined) {
    throw new Error(`Workflow step source lineage is invalid: ${stepId}`);
  }
  const previousTurn = runRequest.parentRunId ? store.getLingTurnForRun(runRequest.parentRunId) : undefined;
  if (runRequest.parentRunId && (!previousTurn || previousTurn.threadId !== thread.id)) {
    throw new Error(`Workflow step parent Run has no matching canonical Turn: ${runRequest.parentRunId}`);
  }
  const accepted = store.appendConversationUserTurn({
    channelId: step.channelId,
    threadId: thread.id,
    teammateId: step.toParticipantId,
    turnKind,
    title: runRequest.task.title,
    userInstruction: runRequest.task.prompt,
    actorId: "workflow-dispatch",
    actorType: "system",
    workflowStepStart: {
      workflowId: workflow.id,
      workflowStepId: step.id,
      taskId: runRequest.task.id,
      owner: runRequest.workflowStartOwner,
      ...(runRequest.parentRunId ? { parentRunId: runRequest.parentRunId } : {}),
    },
    payload: {
      body: runRequest.task.prompt,
      format: "markdown",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    domainRefs: [
      ...(parentItem && parentTurn && parentThread ? [
        { type: "conversation_item" as const, id: parentItem.id },
        { type: "turn" as const, id: parentTurn.id },
        { type: "thread" as const, id: parentThread.id },
      ] : []),
      { type: "workflow", id: workflow.id },
      { type: "workflow_step", id: step.id },
      { type: "task", id: runRequest.task.id },
    ],
    ...(previousTurn ? { sourceTurnId: previousTurn.id } : {}),
    idempotencyKey: `workflow-step-input:${step.id}:${runRequest.idempotencyKey ?? runRequest.parentRunId ?? runRequest.task.id}`,
  }, now);
  const turn = store.getLingTurn(accepted.turnId);
  const segment = store.getContextSegment(accepted.contextSegmentId);
  if (!turn || turn.threadId !== thread.id || turn.sourceItemId !== accepted.item.id
    || turn.workspaceId !== thread.workspaceId || accepted.item.workspaceId !== thread.workspaceId
    || turn.kind !== turnKind || turn.title !== runRequest.task.title
    || turn.userInstruction !== runRequest.task.prompt || accepted.item.kind !== "user_message"
    || accepted.item.payload.body !== runRequest.task.prompt
    || turn.channelId !== step.channelId || turn.taskId !== runRequest.task.id
    || turn.teammateId !== step.toParticipantId || turn.workflowStepId !== step.id
    || turn.sourceTurnId !== previousTurn?.id || turn.createdByActor !== "system"
    || accepted.item.actorType !== "system" || accepted.item.actorId !== "workflow-dispatch"
    || accepted.item.threadId !== thread.id || accepted.item.turnId !== turn.id
    || !segment || segment.threadId !== thread.id) {
    throw new Error(`Workflow step canonical input was not persisted: ${step.id}`);
  }
  return turn;
}
