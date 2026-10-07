import type { RunStore } from "../../run-types.js";
import { UserInputStoreError, type UserInputRequest } from "../../user-input-store-types.js";
import type { UserInputWait } from "../../user-input-wait-types.js";

export type UserInputWaitingSourcePorts = Pick<RunStore, "getRun" | "getTask" | "getWorkUnit" | "getWorkUnitAttempt"
  | "getLingThread" | "getLingTurnForRun" | "getChannelWorkflowStep">;

/** Validates the original closed execution and still-waiting logical owner without borrowing a new fence. */
export function assertUserInputWaitingSource(ports: UserInputWaitingSourcePorts, request: UserInputRequest, wait: UserInputWait): void {
  const reject = (): never => { throw new UserInputStoreError("source_conflict"); };
  const { source } = request, { fence } = source;
  const run = ports.getRun(source.runId), unit = ports.getWorkUnit(fence.workUnitId);
  const attempt = ports.getWorkUnitAttempt(fence.attemptId);
  const turn = ports.getLingTurnForRun(source.runId), thread = ports.getLingThread(source.threadId);
  const task = ports.getTask(source.taskBinding.taskId);
  if (request.waitMode !== "required" || !["pending", "answered"].includes(request.status)
    || !run || !unit || !attempt || !turn || !thread || thread.status === "archived"
    || run.status !== "yielded" || attempt.status !== "yielded" || unit.status !== "waiting_for_input"
    || unit.activeAttemptId || unit.endedAt || unit.linkedRunId !== run.id || run.workUnitId !== unit.id
    || unit.workspaceId !== source.workspaceId || run.threadId !== source.threadId || turn.id !== source.turnId
    || thread.workspaceId !== source.workspaceId || turn.threadId !== source.threadId || turn.channelId !== source.channelId
    || run.cwd !== source.cwd || run.taskId !== source.taskBinding.taskId || (run.teammateId ?? "ling_agent") !== source.participantId
    || run.channelId !== source.channelId || run.workflowStepId !== source.workflowStepId
    || (unit.teammateId !== undefined && unit.teammateId !== source.participantId)
    || (unit.channelId !== undefined && unit.channelId !== source.channelId)
    || (thread.kind === "teammate_direct" && thread.teammateId !== source.participantId)
    || attempt.workUnitId !== unit.id || attempt.runtimeInstanceId !== fence.runtimeInstanceId || attempt.fencingToken !== fence.fencingToken
    || attempt.endedAt !== wait.checkpoint.quiescence.stoppedAt || run.endedAt !== wait.checkpoint.quiescence.stoppedAt) return reject();
  if (source.taskBinding.kind === "stored_task"
    ? !task || task.status !== "waiting_for_input" || task.currentRunId !== run.id
    : task !== undefined) return reject();
  if (source.workflowStepId) {
    const step = ports.getChannelWorkflowStep(source.workflowStepId);
    if (!step || step.workspaceId !== source.workspaceId || step.status !== "waiting_for_input" || step.runId !== run.id
      || step.toParticipantId !== source.participantId || step.channelId !== source.channelId) return reject();
  }
}
