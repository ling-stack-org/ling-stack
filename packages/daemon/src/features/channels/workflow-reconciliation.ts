import type { ChannelWorkflow, ChannelWorkflowStep, RunStore } from "@ling-stack/core";
import { evaluateWorkflowCompletion } from "./workflow-completion-gate.js";
import {
  finalizeDelegatedWorkflowStepFromCanonicalState,
  type WorkflowReconcileCause,
} from "./workflow-step-finalizer.js";
import { completeWorkflowIfStepsFinished } from "./workflow-completion.js";

export interface WorkflowReconciliationResult {
  readonly workflow?: ChannelWorkflow;
  readonly finalizedStepIds: readonly string[];
  readonly staleStepIds: readonly string[];
  readonly publicationReconciled: boolean;
}

export function reconcileWorkflowFromCanonicalState(input: {
  readonly store: RunStore;
  readonly workflowId: string;
  readonly cause: WorkflowReconcileCause;
  readonly now?: string;
}): WorkflowReconciliationResult {
  const now = input.now ?? new Date().toISOString();
  const initial = input.store.getChannelWorkflow(input.workflowId);
  if (!initial) return { finalizedStepIds: [], staleStepIds: [], publicationReconciled: false };
  if (!initial.metadata?.requiredParticipantManifest) {
    completeWorkflowIfStepsFinished(input.store, initial.id, now);
    return {
      workflow: input.store.getChannelWorkflow(initial.id) ?? initial,
      finalizedStepIds: [],
      staleStepIds: [],
      publicationReconciled: false,
    };
  }
  const finalizedStepIds: string[] = [];
  const staleStepIds: string[] = [];
  for (const step of input.store.listChannelWorkflowSteps({ workflowId: initial.id, complete: true })) {
    if (step.status !== "running" && step.status !== "waiting_for_approval") continue;
    const result = finalizeDelegatedWorkflowStepFromCanonicalState({
      store: input.store,
      workflowStepId: step.id,
      cause: input.cause,
      now,
    });
    if (result.status === "finalized") finalizedStepIds.push(step.id);
    if (result.status === "stale") staleStepIds.push(step.id);
  }
  if (staleStepIds.length > 0) {
    return {
      workflow: input.store.getChannelWorkflow(initial.id) ?? initial,
      finalizedStepIds,
      staleStepIds,
      publicationReconciled: false,
    };
  }
  const beforeCompletion = input.store.getChannelWorkflow(initial.id) ?? initial;
  if (!terminalWorkflow(beforeCompletion) || beforeCompletion.status === "blocked") {
    completeWorkflowIfStepsFinished(input.store, initial.id, now);
  }
  const workflow = input.store.getChannelWorkflow(initial.id) ?? beforeCompletion;
  if (workflow.status === "succeeded") {
    if (input.cause === "pre_publication") {
      assertFreshSuccessfulBasis(input.store, workflow, now);
    }
  }
  const latest = input.store.getChannelWorkflow(initial.id) ?? workflow;
  return {
    workflow: input.store.getChannelWorkflow(initial.id) ?? latest,
    finalizedStepIds,
    staleStepIds,
    publicationReconciled: false,
  };
}

export function reconcileAllContinuityWorkflows(
  store: RunStore,
  input: { readonly cause: WorkflowReconcileCause; readonly now?: string },
): number {
  const now = input.now ?? new Date().toISOString();
  let reconciled = 0;
  for (const channel of store.listChannels({ limit: 500 })) {
    for (const workflow of store.listChannelWorkflows({ channelId: channel.id, limit: 500 })) {
      if (!workflow.metadata?.requiredParticipantManifest) continue;
      const before = workflow.updatedAt;
      const result = reconcileWorkflowFromCanonicalState({ store, workflowId: workflow.id, cause: input.cause, now });
      if (result.workflow?.updatedAt !== before || result.finalizedStepIds.length > 0) reconciled += 1;
    }
  }
  return reconciled;
}

function assertFreshSuccessfulBasis(store: RunStore, workflow: ChannelWorkflow, now: string): void {
  const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
  const evaluation = evaluateWorkflowCompletion({ store, workflow, steps, now });
  if (evaluation?.gate.status !== "verified"
    || evaluation.gate.basisFingerprint !== workflow.metadata?.completionGate?.basisFingerprint) {
    throw new Error(`Workflow completion gate is stale or unverified: ${workflow.id}`);
  }
}

function terminalWorkflow(workflow: ChannelWorkflow): boolean {
  return workflow.status === "succeeded" || workflow.status === "blocked"
    || workflow.status === "failed" || workflow.status === "cancelled";
}
