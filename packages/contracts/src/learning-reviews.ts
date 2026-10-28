import type { RuntimeAttemptFenceV1 } from "./runtime.js";

export interface LearningEvidenceItem {
  readonly id: string;
  readonly kind: "task" | "tool_start" | "tool_end" | "run_end" | "correction";
  readonly text: string;
  readonly verified: boolean;
}
export interface LearningEvidenceBundle {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly sourceAttemptId?: string;
  readonly selectedSkillId?: string;
  readonly selectedSkillRevisionId?: string;
  readonly taskUpdatedAt: string;
  readonly runStatus: "succeeded" | "failed" | "cancelled";
  readonly sourceUpdatedAt: string;
  readonly eventCount: number;
  readonly digest: string;
  readonly items: readonly LearningEvidenceItem[];
  readonly missing: readonly string[];
}
export interface LearningReviewPolicy {
  readonly revision: number;
  readonly mode: "off" | "propose";
  readonly providerPresetId?: string;
  readonly updatedAt?: string;
  readonly limits?: LearningReviewLimits;
}
export interface LearningReviewLimits {
  readonly maxRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly perRequestOutputTokens: number;
  readonly timeoutMs: number;
  readonly dailyAutomaticJobs: number;
}
export const LEARNING_REVIEW_MAX_LIMITS: LearningReviewLimits = Object.freeze({
  maxRequests: 2, inputTokens: 16_000, outputTokens: 4_096,
  perRequestOutputTokens: 2_048, timeoutMs: 120_000, dailyAutomaticJobs: 10,
});
export type LearningReviewJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface LearningReviewJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceKey: string;
  readonly mode: "explicit" | "automatic";
  readonly policyRevision: number;
  readonly providerPresetId: string;
  readonly limits: LearningReviewLimits;
  readonly evidence: LearningEvidenceBundle;
  readonly status: LearningReviewJobStatus;
  readonly fence?: RuntimeAttemptFenceV1;
  readonly modelRequests: number;
  /** Conservative byte upper bound, not measured billed token usage. */
  readonly inputTokensReserved: number;
  readonly outputTokensReserved: number;
  readonly candidateIds: readonly string[];
  readonly reason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface LearningReviewCreateRequest {
  readonly runId: string;
  readonly providerPresetId: string;
  readonly correction?: string;
}
export interface LearningReviewPolicyUpdateRequest {
  readonly mode: "off" | "propose";
  readonly providerPresetId?: string;
  readonly expectedRevision: number;
  readonly limits?: Partial<LearningReviewLimits>;
}
export interface LearningReviewJobResponse { readonly cwd: string; readonly job: LearningReviewJob }
export interface LearningReviewListResponse { readonly cwd: string; readonly jobs: readonly LearningReviewJob[] }
export interface LearningReviewPolicyResponse { readonly cwd: string; readonly policy: LearningReviewPolicy }
