import type { LingAppServerStageMessageExecution } from "@ling-stack/contracts";
import { toRuntimeAttemptFence, type ChannelWorkflowStep, type RunStore } from "@ling-stack/core";

export function readStageMessageReceiver(store: RunStore, step: ChannelWorkflowStep): LingAppServerStageMessageExecution | undefined {
  if (step.status !== "running" || !step.runId || !step.metadata?.planStageId || step.metadata.planBallotKey
    || store.getWorkItemWorkflowAdmissionBlocker(step.workflowId, step)) return undefined;
  const run = store.getRun(step.runId);
  if (!run?.workUnitId || run.status !== "running" || run.workflowStepId !== step.id || run.teammateId !== step.toParticipantId) return undefined;
  const unit = store.getWorkUnit(run.workUnitId);
  const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
  if (!attempt || attempt.effectiveRunnerId !== "pi" || !store.isCurrentRunExecutionOwner(run.id, toRuntimeAttemptFence(attempt))) return undefined;
  return { runId: run.id, attemptId: attempt.id };
}
