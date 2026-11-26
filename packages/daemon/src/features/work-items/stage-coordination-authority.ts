import type { LingAppServerStageMessageExecution } from "@ling-stack/contracts";
import { stageCoordinationRequestKey as scopeStageCoordinationRequestKey, toRuntimeAttemptFence, type RunStore, type RuntimeAttemptFenceV1 } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import { isRecord } from "../../shared/validation.js";
import { workflowStepParticipantAvailable } from "../channels/workflow-participant-run-profile.js";
import { readStageMessageReceiver } from "./stage-message-target.js";
import { readWorkItemWorkflowBinding } from "./workflow-stages.js";

export interface StageCoordinationBinding {
  readonly workItemId: string;
  readonly planRevision: string;
  readonly controlGeneration: number;
  readonly stepId: string;
  readonly participantId: string;
  readonly runId: string;
  readonly fence: RuntimeAttemptFenceV1;
}

export interface StageCoordinationActor {
  readonly binding: StageCoordinationBinding;
  readonly assertCurrent: () => void;
}

export function readStageCoordinationBinding(store: RunStore, activeRuns: ActiveRunRegistry,
  workItemId: string, execution: LingAppServerStageMessageExecution): StageCoordinationBinding | undefined {
  const item = store.getWorkItem(workItemId);
  const run = store.getRun(execution.runId);
  const step = run?.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  if (!item?.planRevision || !step || step.workflowId !== item.workflowId
    || readWorkItemWorkflowBinding(store, step.workflowId)?.workItemId !== item.id
    || !workflowStepParticipantAvailable(store, step)) return undefined;
  const receiver = readStageMessageReceiver(store, step, activeRuns);
  const attempt = receiver && store.getWorkUnitAttempt(receiver.attemptId);
  if (!attempt || receiver?.runId !== execution.runId || receiver.attemptId !== execution.attemptId) return undefined;
  return { workItemId, planRevision: item.planRevision, controlGeneration: item.control.generation,
    stepId: step.id, participantId: step.toParticipantId, runId: execution.runId, fence: toRuntimeAttemptFence(attempt) };
}

export function stageCoordinationExecution(binding: StageCoordinationBinding): LingAppServerStageMessageExecution {
  return { runId: binding.runId, attemptId: binding.fence.attemptId };
}

export function matchesStageCoordinationExecution(value: unknown, binding: StageCoordinationBinding): boolean {
  return isRecord(value) && value.runId === binding.runId && value.attemptId === binding.fence.attemptId;
}

export function stageCoordinationRequestKey(binding: StageCoordinationBinding, key: string): string {
  return scopeStageCoordinationRequestKey(binding.runId, binding.fence.attemptId, key);
}

export function stageCoordinationSourceRefs(binding: StageCoordinationBinding) {
  return [{ type: "run", id: binding.runId }, { type: "attempt", id: binding.fence.attemptId }];
}

export function stageCoordinationDenied(): HttpError {
  return new HttpError(403, "capability_denied", "The active stage does not authorize this coordination request.");
}
