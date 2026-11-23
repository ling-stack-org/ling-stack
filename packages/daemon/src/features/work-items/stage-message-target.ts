import type { LingAppServerStageMessageExecution } from "@ling-stack/contracts";
import { toRuntimeAttemptFence, type ChannelWorkflowStep, type RunStore } from "@ling-stack/core";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";

export function readStageMessageReceiver(store: RunStore, step: ChannelWorkflowStep,
  activeRuns?: ActiveRunRegistry): LingAppServerStageMessageExecution | undefined {
  if (step.status !== "running" || !step.runId || !step.metadata?.planStageId || step.metadata.planBallotKey
    || store.getWorkItemWorkflowAdmissionBlocker(step.workflowId, step)) return undefined;
  const run = store.getRun(step.runId);
  if (!run?.workUnitId || run.status !== "running" || run.workflowStepId !== step.id || run.teammateId !== step.toParticipantId) return undefined;
  const unit = store.getWorkUnit(run.workUnitId);
  const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
  if (!attempt || attempt.effectiveRunnerId !== "pi" || !store.isCurrentRunExecutionOwner(run.id, toRuntimeAttemptFence(attempt))) return undefined;
  const running = activeRuns?.get(run.id);
  if (activeRuns && (!running?.acceptsStageMessages || running.workUnitId !== attempt.workUnitId || running.attemptId !== attempt.id
    || running.runtimeInstanceId !== attempt.runtimeInstanceId || running.fencingToken !== attempt.fencingToken
    || running.abortController.signal.aborted || running.stopIntent)) return undefined;
  return { runId: run.id, attemptId: attempt.id };
}
