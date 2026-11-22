import { createHash } from "node:crypto";
import type { ProposedPlanStageDecision, ProposedPlanWorkflowStepPreview } from "@ling-stack/contracts";
import type { CreateProposedPlanArtifactInput, ProposedPlanArtifact, UpdateProposedPlanArtifactInput } from "./run-types.js";

export type ProposedPlanArtifactAction = "accept" | "refine" | "save" | "archive" | "convert-workflow";

export type ProposedPlanWorkflowStepPreviewInput = ProposedPlanWorkflowStepPreview;

export interface ApplyProposedPlanArtifactActionInput {
  readonly threadId: string;
  readonly action: ProposedPlanArtifactAction;
  readonly plan?: CreateProposedPlanArtifactInput;
  readonly expectedRevision?: number;
  readonly createdBy?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly workflowTitle?: string;
  readonly workflowSteps?: readonly string[];
  readonly workflowStepPreviews?: readonly ProposedPlanWorkflowStepPreviewInput[];
  readonly refinedDraft?: Pick<CreateProposedPlanArtifactInput, "title" | "bodyMarkdown">;
}

export interface ProposedPlanArtifactActionResult {
  readonly plan: ProposedPlanArtifact;
  readonly taskId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly runId?: string;
}

export class ProposedPlanMutationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message);
    this.name = "ProposedPlanMutationError";
  }
}

export function parseProposedPlanStageDecision(value: unknown): ProposedPlanStageDecision {
  const decision = value as Partial<ProposedPlanStageDecision> | null;
  if (decision && typeof decision.question === "string" && decision.question.trim() && decision.question.length <= 500
    && Array.isArray(decision.options) && decision.options.length >= 2 && decision.options.length <= 12
    && decision.options.every(option => typeof option === "string" && option.trim() === option && option.length > 0 && option.length <= 200)
    && new Set(decision.options).size === decision.options.length) {
    const ballot = decision.ballot;
    if (ballot !== undefined && (!ballot || !Array.isArray(ballot.voterStageIds)
      || ballot.voterStageIds.length < 2 || ballot.voterStageIds.length > 12
      || !ballot.voterStageIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 64)
      || new Set(ballot.voterStageIds).size !== ballot.voterStageIds.length
      || !Number.isInteger(ballot.quorum) || ballot.quorum < 2 || ballot.quorum > ballot.voterStageIds.length)) {
      throw new ProposedPlanMutationError("bad_workflow_stage_ballot", "A ballot needs distinct voter stages and a quorum within the voter roster.", 400);
    }
    if (decision.trigger !== undefined && decision.trigger !== "when_ready") {
      throw new ProposedPlanMutationError("bad_workflow_stage_decision", "Choose when_ready for automatic opening of the decision round.", 400);
    }
    return { question: decision.question, options: decision.options, ...(ballot ? { ballot } : {}),
      ...(decision.trigger ? { trigger: decision.trigger } : {}) };
  }
  throw new ProposedPlanMutationError("bad_workflow_stage_decision", "A required decision needs a question and 2–12 distinct options.", 400);
}

export function planStageBallotKey(planId: string, stageId: string, decision: ProposedPlanStageDecision): string {
  return createHash("sha256").update(JSON.stringify([planId, stageId, decision.question, decision.options,
    decision.ballot?.voterStageIds, decision.ballot?.quorum])).digest("hex");
}

export const proposedPlanContentFields = ["channelId", "goalId", "sourceAgentId", "ownerAgentId", "sourceTurnId",
  "sourceMessageId", "sourceRunId", "parentPlanId", "planGroupId", "version", "title", "bodyMarkdown"] as const;
export const proposedPlanAcceptanceFields = ["acceptedAt", "convertedAt", "acceptedTaskId", "acceptedWorkflowId",
  "acceptedWorkflowStepId", "acceptedRunId"] as const;

export function proposedPlanHasAcceptance(plan: ProposedPlanArtifact): boolean {
  return plan.status === "accepted" || proposedPlanAcceptanceFields.some(field => plan[field] !== undefined);
}

export function assertProposedPlanRevision(expected: number | undefined, actual?: number): void {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) {
    throw new ProposedPlanMutationError("proposed_plan_revision_invalid", "expectedRevision must be a positive safe integer.", 400);
  }
  if (actual !== undefined && expected !== undefined && expected !== actual) {
    throw new ProposedPlanMutationError("proposed_plan_revision_conflict", "The proposed plan changed. Reload its canonical revision before editing.");
  }
}

export function assertNewProposedPlan(input: CreateProposedPlanArtifactInput): void {
  assertProposedPlanRevision(input.expectedRevision);
  if (typeof input.title !== "string" || !input.title.trim() || typeof input.bodyMarkdown !== "string" || !input.bodyMarkdown.trim()) {
    throw new ProposedPlanMutationError("bad_proposed_plan_content", "A new plan requires a nonempty title and bodyMarkdown.", 400);
  }
  if (input.status !== undefined && input.status !== "draft" && input.status !== "archived"
    || input.supersededByPlanId !== undefined || proposedPlanAcceptanceFields.some(field => input[field] !== undefined)) {
    throw new ProposedPlanMutationError("proposed_plan_action_owned", "Acceptance and successor facts can only be created by a proposed-plan action.");
  }
  assertProposedPlanContent(input);
}

export function assertProposedPlanPublicUpdate(plan: ProposedPlanArtifact, input: UpdateProposedPlanArtifactInput): void {
  assertProposedPlanRevision(input.expectedRevision, plan.revision);
  assertProposedPlanContent(input);
  for (const field of [...proposedPlanAcceptanceFields, "supersededByPlanId"] as const) {
    if (input[field] !== undefined && (input[field] ?? undefined) !== plan[field]) {
      throw new ProposedPlanMutationError("proposed_plan_action_owned", "Acceptance and successor facts can only be changed by a proposed-plan action.");
    }
  }
  if (plan.parentPlanId !== undefined && (["channelId", "goalId", "sourceAgentId", "ownerAgentId", "sourceTurnId",
    "sourceMessageId", "sourceRunId", "parentPlanId", "planGroupId", "version"] as const)
    .some(field => input[field] !== undefined && (input[field] ?? undefined) !== plan[field])) {
    throw new ProposedPlanMutationError("proposed_plan_lineage_conflict", "A refined plan's lineage and owning scope are immutable.");
  }
  const changesContent = proposedPlanContentFields.some(field => input[field] !== undefined && (input[field] ?? undefined) !== plan[field]);
  const changesStatus = input.status !== undefined && input.status !== plan.status;
  const sealed = proposedPlanHasAcceptance(plan) || plan.supersededByPlanId !== undefined;
  if (sealed && (changesContent || changesStatus && input.status !== "archived")) {
    throw new ProposedPlanMutationError("accepted_plan_immutable", "Accepted or refined plan history is immutable. Refine its successor instead.");
  }
  if (changesStatus && (input.status === "accepted" || input.status === "superseded")) {
    throw new ProposedPlanMutationError("proposed_plan_action_owned", "Accepted and superseded lifecycle states are action-owned.");
  }
  const changesMetadata = (["savedAt", "archivedAt", "archivedReason"] as const)
    .some(field => input[field] !== undefined && (input[field] ?? undefined) !== plan[field]);
  if ((changesContent || changesStatus || changesMetadata) && input.expectedRevision === undefined) {
    throw new ProposedPlanMutationError("proposed_plan_revision_required", "Editing an existing proposed plan requires expectedRevision.");
  }
}

/** Action snapshots are references, never replacement rows or metadata editors. */
export function assertProposedPlanSnapshot(plan: ProposedPlanArtifact, input: CreateProposedPlanArtifactInput): void {
  assertProposedPlanRevision(input.expectedRevision);
  if (input.id !== undefined && input.id !== plan.id || input.threadId !== plan.threadId) {
    throw new ProposedPlanMutationError("proposed_plan_not_found", "The proposed plan does not belong to this thread.", 404);
  }
  const fields = [...proposedPlanContentFields, ...proposedPlanAcceptanceFields, "supersededByPlanId"] as const;
  if (fields.some(field => input[field] !== undefined && input[field] !== plan[field])) {
    throw new ProposedPlanMutationError("proposed_plan_snapshot_conflict", "The supplied proposed-plan snapshot differs from canonical history.");
  }
}

function assertProposedPlanContent(input: UpdateProposedPlanArtifactInput): void {
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())
    || input.bodyMarkdown !== undefined && (typeof input.bodyMarkdown !== "string" || !input.bodyMarkdown.trim())) {
    throw new ProposedPlanMutationError("bad_proposed_plan_content", "Plan title and bodyMarkdown must be nonempty strings.", 400);
  }
  if (input.version !== undefined && input.version !== null && (!Number.isSafeInteger(input.version) || input.version < 1)) {
    throw new ProposedPlanMutationError("bad_proposed_plan_version", "Plan lineage version must be a positive safe integer.", 400);
  }
  if (input.status !== undefined && !["draft", "accepted", "superseded", "archived"].includes(input.status)) {
    throw new ProposedPlanMutationError("bad_proposed_plan_status", "Unknown proposed-plan lifecycle status.", 400);
  }
}
