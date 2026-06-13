import type { ApprovalRequest, ChannelWorkflow, ChannelWorkflowStep, RunSession } from "../types.js";
import type { Translate } from "../i18n.js";
import { truncatePreview } from "./data.js";

export type CollaborationTaskCardMode =
  | "ready_for_confirmation"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type CollaborationExecutionMode = "serial" | "parallel" | "mixed";
export type CollaborationTaskStepState = "queued" | "active" | "waiting" | "blocked" | "done" | "failed" | "cancelled";

export interface CollaborationTaskCardStep {
  readonly id: string;
  readonly title: string;
  readonly ownerLabel: string;
  readonly state: CollaborationTaskStepState;
  readonly summary?: string;
  readonly updatedAt: string;
}

export interface CollaborationTaskCardModel {
  readonly id: string;
  readonly workflowId: string;
  readonly title: string;
  readonly objective: string;
  readonly mode: CollaborationTaskCardMode;
  readonly executionMode: CollaborationExecutionMode;
  readonly currentOwnerLabel?: string;
  readonly blocker?: string;
  readonly nextAction?: string;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly pendingApprovalCount: number;
  readonly steps: readonly CollaborationTaskCardStep[];
  readonly updatedAt: string;
}

export interface BuildCollaborationTaskCardInput {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly t: Translate;
}

export function buildCollaborationTaskCardModel(input: BuildCollaborationTaskCardInput): CollaborationTaskCardModel | undefined {
  const orderedSteps = [...input.steps].sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
  if (orderedSteps.length === 0) {
    return undefined;
  }

  const stepRunIds = new Set(orderedSteps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)));
  const stepIds = new Set(orderedSteps.map((step) => step.id));
  const workflowRuns = input.runs.filter((run) => (run.workflowStepId ? stepIds.has(run.workflowStepId) : false) || stepRunIds.has(run.id));
  const workflowApprovals = input.approvals.filter((approval) =>
    (approval.workflowStepId ? stepIds.has(approval.workflowStepId) : false) ||
    (approval.runId ? workflowRuns.some((run) => run.id === approval.runId) : false),
  );
  const pendingApprovals = workflowApprovals.filter((approval) => approval.status === "pending");
  const blockedStep = orderedSteps.find((step) => step.status === "blocked");
  const failedStep = orderedSteps.find((step) => step.status === "failed");
  const waitingStep = orderedSteps.find((step) => step.status === "waiting_for_approval");
  const activeStep = orderedSteps.find((step) => step.status === "running" || step.status === "claimed");
  const queuedStep = orderedSteps.find((step) => step.status === "queued");
  const focusStep = blockedStep ?? failedStep ?? waitingStep ?? activeStep ?? queuedStep;
  const completedStepCount = orderedSteps.filter((step) => step.status === "succeeded" || step.status === "skipped").length;

  return {
    id: `collaboration-task-card:${input.workflow.id}`,
    workflowId: input.workflow.id,
    title: input.workflow.title,
    objective: input.workflow.objective,
    mode: collaborationTaskCardMode(input.workflow, orderedSteps, pendingApprovals),
    executionMode: collaborationExecutionMode(orderedSteps),
    currentOwnerLabel: focusStep?.toParticipantLabel,
    blocker: blockedStep?.blocker ?? failedStep?.blocker,
    nextAction: collaborationNextAction({ t: input.t, workflow: input.workflow, focusStep, pendingApprovalCount: pendingApprovals.length }),
    completedStepCount,
    totalStepCount: orderedSteps.length,
    pendingApprovalCount: pendingApprovals.length,
    steps: orderedSteps.map((step) => ({
      id: step.id,
      title: step.title,
      ownerLabel: step.toParticipantLabel,
      state: collaborationStepState(step),
      summary: step.resultSummary ?? step.blocker ?? (step.status === "succeeded" || step.status === "skipped" ? undefined : truncatePreview(step.prompt, 120)),
      updatedAt: step.updatedAt,
    })),
    updatedAt: input.workflow.updatedAt,
  };
}

function collaborationTaskCardMode(
  workflow: ChannelWorkflow,
  steps: readonly ChannelWorkflowStep[],
  pendingApprovals: readonly ApprovalRequest[],
): CollaborationTaskCardMode {
  if (workflow.status === "cancelled") {
    return "cancelled";
  }
  if (workflow.status === "succeeded") {
    return "completed";
  }
  if (workflow.status === "failed" || steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (workflow.status === "blocked" || steps.some((step) => step.status === "blocked")) {
    return "blocked";
  }
  if (workflow.status === "waiting_for_approval" || pendingApprovals.length > 0 || steps.some((step) => step.status === "waiting_for_approval")) {
    return "waiting";
  }
  if (workflow.status === "draft" || workflow.status === "ready") {
    return "ready_for_confirmation";
  }
  return "running";
}

function collaborationExecutionMode(steps: readonly ChannelWorkflowStep[]): CollaborationExecutionMode {
  const hasParallelMetadata = steps.some((step) => step.metadata?.branchGroupId || step.metadata?.joinGroupId || step.metadata?.maxParallelSiblings);
  const runningCount = steps.filter((step) => step.status === "running" || step.status === "claimed").length;
  const hasDependencies = steps.some((step) => (step.metadata?.dependsOnStepIds?.length ?? 0) > 0);
  if (hasParallelMetadata && hasDependencies) {
    return "mixed";
  }
  if (hasParallelMetadata || runningCount > 1) {
    return "parallel";
  }
  return "serial";
}

function collaborationStepState(step: ChannelWorkflowStep): CollaborationTaskStepState {
  if (step.status === "succeeded" || step.status === "skipped") {
    return "done";
  }
  if (step.status === "running" || step.status === "claimed") {
    return "active";
  }
  if (step.status === "waiting_for_approval") {
    return "waiting";
  }
  if (step.status === "blocked") {
    return "blocked";
  }
  if (step.status === "failed") {
    return "failed";
  }
  if (step.status === "cancelled") {
    return "cancelled";
  }
  return "queued";
}

function collaborationNextAction(input: {
  readonly t: Translate;
  readonly workflow: ChannelWorkflow;
  readonly focusStep?: ChannelWorkflowStep;
  readonly pendingApprovalCount: number;
}): string | undefined {
  if (input.pendingApprovalCount > 0) {
    return input.t("Review approval request");
  }
  if (!input.focusStep) {
    return undefined;
  }
  if (input.focusStep.status === "blocked") {
    return input.t("Resolve blocker");
  }
  if (input.focusStep.status === "failed") {
    return input.t("Review failed step");
  }
  if (input.focusStep.status === "queued" && (input.workflow.status === "draft" || input.workflow.status === "ready")) {
    return input.t("Start task");
  }
  if (input.focusStep.status === "running" || input.focusStep.status === "claimed") {
    return input.t("Waiting for agent result");
  }
  return undefined;
}
