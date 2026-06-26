import {
  formatChannelTeamRiskReviewReason,
  type ApprovalRisk,
  type ApprovalToolDecision,
  type ChannelTeamRiskReviewDecision,
  type CreateApprovalRequestInput,
} from "@ling-stack/core";

export function applyRiskReviewToApprovalInput(
  input: CreateApprovalRequestInput,
  decision: ChannelTeamRiskReviewDecision,
): CreateApprovalRequestInput {
  if (decision.status === "not_required") {
    return input;
  }
  const risk = maxApprovalRisk(input.risk, decision.risk === "critical" ? "critical" : "high");
  return {
    ...input,
    risk,
    title: input.title.startsWith("Risk review required:")
      ? input.title
      : `Risk review required: ${input.title}`,
    description: appendRiskReviewDescription(input.description, decision),
  };
}

export function applyRiskReviewToPolicyDecision(
  policyDecision: { readonly decision: ApprovalToolDecision; readonly reason: string },
  riskReview: ChannelTeamRiskReviewDecision,
): { readonly decision: ApprovalToolDecision; readonly reason: string } {
  if (riskReview.status === "not_required" || policyDecision.decision === "deny") {
    return policyDecision;
  }
  return {
    decision: riskReview.status === "blocked" ? "deny" : "ask",
    reason: formatChannelTeamRiskReviewReason(riskReview),
  };
}

function appendRiskReviewDescription(description: string, decision: ChannelTeamRiskReviewDecision): string {
  const reasons = decision.reasons.length > 0 ? decision.reasons.join(" ") : "High-risk action requires explicit review.";
  return `${description}\n\nRisk review: ${reasons}`;
}

function maxApprovalRisk(left: ApprovalRisk, right: ApprovalRisk): ApprovalRisk {
  const rank: Record<ApprovalRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return rank[left] >= rank[right] ? left : right;
}
