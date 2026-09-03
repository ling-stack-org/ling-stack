import type { RunStore } from "@ling-stack/core";
import { evaluateWorkflowCompletion } from "./workflow-completion-gate.js";

export function completeWorkflowIfStepsFinished(store: RunStore, workflowId: string, now: string): void {
  const workflow = store.getChannelWorkflow(workflowId);
  if (!workflow || (workflow.status !== "running" && workflow.status !== "waiting_for_approval"
    && workflow.status !== "blocked")) return;
  const steps = store.listChannelWorkflowSteps({ workflowId, complete: true });
  const evaluation = evaluateWorkflowCompletion({ store, workflow, steps, now });
  if (workflow.metadata?.requiredParticipantManifest && !evaluation) {
    throw new Error(`Manifest-backed workflow has no completion gate: ${workflow.id}`);
  }
  if (!evaluation) {
    if (workflow.status !== "running" || steps.length === 0
      || steps.some((step) => step.status !== "succeeded" && step.status !== "skipped")) return;
    store.transitionChannelWorkflowStatus({
      workflowId,
      expectedStatus: "running",
      event: "all_steps_succeeded",
      actor: "system",
      now,
    });
    return;
  }
  store.commitChannelWorkflowCompletionEvaluation({
    workflowId: workflow.id,
    evaluation,
    now,
  });
}
