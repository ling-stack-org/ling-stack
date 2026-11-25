import { createHash } from "node:crypto";
import type { AppendWorkItemCollaborationInput } from "./work-item-collaboration.js";
import type { RunStore } from "./run-types.js";
import type { ChannelWorkflow, ChannelWorkflowStep } from "./workspace-types.js";

export interface WorkItemDeliberationWorkflowBinding {
  readonly workItemId: string;
  readonly roundId: string;
  readonly originWorkflowId: string;
  readonly originStepId: string;
  readonly originStepRevision: string;
  readonly planRevision: string;
  readonly controlGeneration: number;
  readonly deadlineAt: string;
  readonly candidate?: { readonly cwd: string; readonly digest: string };
  readonly providerRevisions: Readonly<Record<string, number>>;
  readonly steps: Readonly<Record<string, string>>;
}

export interface WorkItemDeliberationWorkflowAdmission {
  readonly workItemId: string;
  readonly expectedWorkItemRevision: number;
  readonly roundId: string;
  readonly assertCurrent: () => void;
  readonly compile: () => {
    readonly workflow: ChannelWorkflow;
    readonly binding: WorkItemDeliberationWorkflowBinding;
    readonly round: AppendWorkItemCollaborationInput;
  };
}

export function readWorkItemDeliberationWorkflowBinding(store: Pick<RunStore, "getAppServerState">, workflowId: string) {
  return (store.getAppServerState("work_item_deliberation_workflow", workflowId)?.payload as
    { readonly binding: WorkItemDeliberationWorkflowBinding } | undefined)?.binding;
}

export function checkpointDeliberationResolutionId(roundId: string): string {
  return `work_item_deliberation_${createHash("sha256").update(roundId).digest("hex")}`;
}

export function deliberationWorkflowStepDigest(step: ChannelWorkflowStep): string {
  const metadata = step.metadata;
  return createHash("sha256").update(JSON.stringify([
    step.id, step.workflowId, step.channelId, step.title, step.prompt, step.toParticipantId, step.participantAuthority,
    metadata?.sideEffectClass, metadata?.dependsOnStepIds, metadata?.requiredTools, metadata?.requestedRunnerId,
    metadata?.providerPresetId, metadata?.policy, metadata?.skillId, metadata?.gates, metadata?.parallelPolicy,
    metadata?.providerBinding, metadata?.approvalGate, metadata?.executionPlan, metadata?.executionOperationIds,
    metadata?.dependencyMode, metadata?.templateStepId,
  ])).digest("hex");
}
