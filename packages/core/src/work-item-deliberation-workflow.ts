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
  readonly decisionTarget?: WorkItemDeliberationTarget;
  readonly ballot?: { readonly options: readonly string[]; readonly evidenceIds: readonly string[]; readonly quorum: number };
  readonly steps: Readonly<Record<string, string>>;
}

export type WorkItemDeliberationBallotBasis = {
  readonly challengeArtifacts: readonly { readonly id: string; readonly digest: string }[];
} & (
  | { readonly status: "voting"; readonly key: string }
  | { readonly status: "consensus"; readonly recommendation: string }
  | { readonly status: "verify_required" | "insufficient_evidence" }
);

export interface WorkItemDeliberationTarget {
  readonly stepId: string;
  readonly stepDigest: string;
  readonly options: Readonly<Record<string, string>>;
}

export interface WorkItemDeliberationApplication {
  readonly workItemId: string;
  readonly workflowId: string;
  readonly planRevision: string;
  readonly stepId: string;
  readonly stepDigest: string;
  readonly controlGeneration: number;
  readonly candidate: NonNullable<WorkItemDeliberationWorkflowBinding["candidate"]>;
  readonly roundId: string;
  readonly resolutionId: string;
  readonly option: string;
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

export function readWorkItemDeliberationApplication(store: Pick<RunStore, "getAppServerState">, stepId: string) {
  return store.getAppServerState("work_item_deliberation_application", stepId)?.payload as WorkItemDeliberationApplication | undefined;
}

export function readWorkItemDeliberationBallotBasis(store: Pick<RunStore, "getAppServerState">, workflowId: string) {
  return store.getAppServerState("work_item_deliberation_ballot", workflowId)?.payload as WorkItemDeliberationBallotBasis | undefined;
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
    metadata?.dependencyMode, metadata?.templateStepId, metadata?.planStageId, metadata?.requiredPlanDecision, metadata?.planBallotKey,
  ])).digest("hex");
}
