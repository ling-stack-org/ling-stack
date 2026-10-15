import type { ProposedPlanArtifact } from "../../types.js";

/** A displayed snapshot is a reference for an action, never an implicit edit. */
export function proposedPlanActionPayload(plan: ProposedPlanArtifact) {
  return {
    id: plan.id,
    threadId: plan.threadId,
    expectedRevision: plan.revision,
    channelId: plan.channelId ?? null,
    goalId: plan.goalId ?? null,
    sourceAgentId: plan.sourceAgentId ?? null,
    ownerAgentId: plan.ownerAgentId ?? null,
    sourceTurnId: plan.sourceTurnId ?? null,
    sourceMessageId: plan.sourceMessageId ?? null,
    sourceRunId: plan.sourceRunId ?? null,
    parentPlanId: plan.parentPlanId ?? null,
    supersededByPlanId: plan.supersededByPlanId ?? null,
    planGroupId: plan.planGroupId ?? null,
    version: plan.version ?? null,
    title: plan.title,
    bodyMarkdown: plan.bodyMarkdown,
    status: plan.status,
  };
}
