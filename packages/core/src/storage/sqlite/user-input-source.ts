import type { RunStore } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import { UserInputStoreError, type CreateUserInputRequest, type UserInputSource } from "../../user-input-store-types.js";

export type UserInputSourcePorts = Pick<RunStore,
  "getRun" | "getTask" | "getConversationItem" | "getLingThread" | "getLingTurnForRun"
  | "getWorkUnit" | "getWorkUnitAttempt" | "getChannelWorkflowStep">;

/** Called inside the writer's transaction using ports backed by that same SQLite connection. */
export function resolveActiveUserInputSource(ports: UserInputSourcePorts, input: CreateUserInputRequest): UserInputSource {
  const reject = (): never => { throw new UserInputStoreError("source_conflict"); };
  const run = ports.getRun(input.sourceRunId);
  const item = ports.getConversationItem(input.sourceItemId);
  const turn = ports.getLingTurnForRun(input.sourceRunId);
  const thread = run?.threadId ? ports.getLingThread(run.threadId) : undefined;
  const unit = run?.workUnitId ? ports.getWorkUnit(run.workUnitId) : undefined;
  const attempt = ports.getWorkUnitAttempt(input.sourceFence.attemptId);
  if (!run || !item || !turn || !thread || !unit || !attempt) return reject();
  if (run.status !== "running" || unit.status !== "running" || attempt.status !== "started"
    || attempt.endedAt || attempt.abortRequestedAt || thread.status === "archived"
    || unit.workspaceId !== DEFAULT_WORKSPACE_ID || thread.workspaceId !== DEFAULT_WORKSPACE_ID
    || turn.workspaceId !== DEFAULT_WORKSPACE_ID || item.workspaceId !== DEFAULT_WORKSPACE_ID
    || unit.linkedRunId !== run.id || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id
    || input.sourceFence.workUnitId !== unit.id || input.sourceFence.runtimeInstanceId !== attempt.runtimeInstanceId
    || input.sourceFence.fencingToken !== attempt.fencingToken
    || item.threadId !== thread.id || turn.threadId !== thread.id || item.turnId !== turn.id
    || item.status !== "committed" || item.channelId !== thread.channelId
    || turn.channelId !== thread.channelId || run.channelId !== thread.channelId) return reject();

  const participantId = run.teammateId ?? "ling_agent";
  if (thread.kind === "teammate_direct" && thread.teammateId !== participantId) return reject();
  if (unit.teammateId !== undefined && unit.teammateId !== participantId) return reject();
  if (unit.channelId !== undefined && unit.channelId !== thread.channelId) return reject();
  if (item.visibility === "agent_private" && item.visibilityOwnerId !== participantId) return reject();
  if (run.workflowStepId) {
    const step = ports.getChannelWorkflowStep(run.workflowStepId);
    if (!step || step.workspaceId !== DEFAULT_WORKSPACE_ID || step.status !== "running"
      || step.runId !== run.id || step.toParticipantId !== participantId || step.channelId !== thread.channelId
      || (thread.workflowStepId !== undefined && thread.workflowStepId !== step.id)
      || (turn.workflowStepId !== undefined && turn.workflowStepId !== step.id)) return reject();
  } else if (thread.kind === "workflow_step" || turn.workflowStepId) return reject();

  return {
    workspaceId: DEFAULT_WORKSPACE_ID, threadId: thread.id, turnId: turn.id,
    runId: run.id, taskBinding: { kind: ports.getTask(run.taskId) ? "stored_task" : "run_snapshot", taskId: run.taskId },
    itemId: item.id, participantId,
    ...(thread.channelId ? { channelId: thread.channelId } : {}),
    ...(run.workflowStepId ? { workflowStepId: run.workflowStepId } : {}),
    fence: toRuntimeAttemptFence(attempt), cwd: run.cwd,
    visibility: item.visibility,
    ...(item.visibilityOwnerId ? { visibilityOwnerId: item.visibilityOwnerId } : {}),
  };
}
