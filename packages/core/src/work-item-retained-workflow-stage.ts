import type { LingAppServerRetainedWorkflowStageExecution, LingAppServerRetainedWorkflowStageResult,
  LingAppServerWorkflowStageResultSource } from "@ling-stack/contracts";
import type { RunStore } from "./run-types.js";
import type { ChannelWorkflowStep } from "./workspace-types.js";

type StagePorts = Pick<RunStore, "getChannelWorkflowStep" | "getRun" | "getArtifact">;

export function readRetainedWorkflowStageResult(store: StagePorts, sourceWorkflowId: string, input: LingAppServerWorkflowStageResultSource):
  LingAppServerRetainedWorkflowStageResult | undefined {
  const source = store.getChannelWorkflowStep(input.sourceStepId);
  const sourceStageId = source?.metadata?.planStageId;
  const sourceRunId = source?.runId;
  const sourceArtifactId = source?.metadata?.outputArtifactId;
  if (!source || source.workflowId !== sourceWorkflowId || source.updatedAt !== input.expectedSourceRevision
    || source.status !== "succeeded" || !sourceStageId || !sourceRunId || !sourceArtifactId) return undefined;
  const run = store.getRun(sourceRunId);
  const artifact = store.getArtifact(sourceArtifactId);
  const packet = artifact?.sealedPayload as { readonly workflowId?: string; readonly workflowStepId?: string; readonly runId?: string } | undefined;
  if (run?.status !== "succeeded" || run.workflowStepId !== source.id || artifact?.runId !== run.id
    || packet?.workflowId !== sourceWorkflowId || packet.workflowStepId !== source.id || packet.runId !== run.id) return undefined;
  return { ...input, sourceWorkflowId, sourceStageId, sourceRunId, sourceArtifactId };
}

export function ownsRetainableWorkflowStageExecution(store: Pick<StagePorts, "getRun">, step: ChannelWorkflowStep, sourceRunId: string): boolean {
  const run = store.getRun(sourceRunId);
  return Boolean(run && step.runId === sourceRunId && step.metadata?.startOwner?.phase === "linked"
    && step.metadata.startOwner.taskId === step.taskId && run.taskId === step.taskId
    && run.workflowStepId === step.id && run.channelId === step.channelId && run.workUnitId
    && ["running", "waiting_for_approval", "yielded"].includes(run.status)
    && ["running", "waiting_for_approval", "waiting_for_input"].includes(step.status));
}

export function readRetainedWorkflowStageExecution(store: StagePorts, execution: LingAppServerRetainedWorkflowStageExecution):
  { readonly status: "available"; readonly result: LingAppServerRetainedWorkflowStageResult }
  | { readonly status: "pending" | "unavailable" } {
  const { sourceStepId, targetStepId, sourceWorkflowId, sourceStageId, sourceRunId } = execution;
  const source = store.getChannelWorkflowStep(sourceStepId);
  if (source?.workflowId !== sourceWorkflowId || source.metadata?.planStageId !== sourceStageId || source.runId !== sourceRunId) {
    return { status: "unavailable" };
  }
  if (ownsRetainableWorkflowStageExecution(store, source, sourceRunId)) return { status: "pending" };
  const result = readRetainedWorkflowStageResult(store, sourceWorkflowId, {
    sourceStepId, targetStepId, expectedSourceRevision: source.updatedAt,
  });
  return result ? { status: "available", result } : { status: "unavailable" };
}
