import type { ChannelWorkflow, ChannelWorkflowStep } from "../types.js";

/** A request affordance only. Host enforcement and complete inventory validation remain authoritative. */
export function canRequestWorkflowIsolation(workflow: ChannelWorkflow, steps: readonly ChannelWorkflowStep[]): boolean {
  return workflow.status === "ready"
    && Boolean(workflow.metadata?.workflowGraphFingerprint)
    && (workflow.metadata?.maxParallelSteps ?? 2) >= 2
    && steps.length >= 2
    && steps.length <= 128
    && steps.every(step => step.workflowId === workflow.id
      && step.status === "queued"
      && !step.taskId && !step.runId
      && !step.metadata?.preStepApprovalId && !step.metadata?.postStepApprovalId
      && step.metadata?.autoStart !== false
      && (!step.metadata?.requestedRunnerId || step.metadata.requestedRunnerId === "pi")
      && step.metadata?.sideEffectClass === "workspace_write"
      && step.metadata.parallelPolicy?.autoParallel === true
      && (step.metadata.parallelPolicy.maxParallelSiblings ?? 1) >= 2
      && (step.metadata.maxParallelSiblings ?? 2) >= 2);
}
