import type { CodeAssessmentStatus, CodeAssessmentPhase, CodeFindingCloseReason, CodeFindingDisposition } from "@ling-stack/contracts";

export const assessmentStatusLabel: Record<CodeAssessmentStatus, string> = {
  queued: "Queued", analyzing: "Analyzing", completed: "Completed", partial: "Partial result",
  failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted",
};
export const assessmentSeverityLabel = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" } as const;
export const assessmentConfidenceLabel = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" } as const;
export const assessmentDispositionLabel: Record<CodeFindingDisposition, string> = { open: "Open", acknowledged: "Acknowledged", resolved: "Resolved", dismissed: "Ignored" };
export const assessmentCloseReasonLabel: Record<CodeFindingCloseReason, string> = { false_positive: "False positive", accepted_risk: "Accepted risk", not_reproducible: "Not reproducible", duplicate: "Duplicate", out_of_scope: "Out of scope" };
export const assessmentPhaseLabel: Record<CodeAssessmentPhase, string> = { preparing: "Preparing", collecting_diff: "Collecting source", threat_model: "Threat model", reviewing_code: "Reviewing code", validating_output: "Checking evidence", validating_candidates: "Validating candidates", synthesizing_findings: "Saving report", completed: "Completed", partial: "Partial result", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };
export const assessmentExclusionLabel = {
  sensitive: "Sensitive file", binary: "Binary file", truncated: "File too large", budget: "Snapshot budget", unsupported: "Unsupported file",
} as const;
export function assessmentTone(status: CodeAssessmentStatus): "success" | "danger" | "warning" | "neutral" {
  return status === "completed" ? "success" : status === "failed" ? "danger"
    : status === "partial" || status === "interrupted" ? "warning" : "neutral";
}
