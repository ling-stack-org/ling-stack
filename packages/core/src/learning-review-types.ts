import type { LearningEvidenceBundle, LearningReviewJob, LearningReviewPolicy, LearningReviewPolicyUpdateRequest,
  RuntimeAttemptFenceV1 } from "@ling-stack/contracts";
export type { LearningEvidenceBundle, LearningEvidenceItem, LearningReviewJob, LearningReviewPolicy } from "@ling-stack/contracts";
export interface EnqueueLearningReviewInput {
  readonly mode: "explicit" | "automatic";
  readonly evidence: LearningEvidenceBundle;
  readonly providerPresetId: string;
}
export interface LearningReviewStore {
  getLearningReviewPolicy(): LearningReviewPolicy;
  updateLearningReviewPolicy(input: LearningReviewPolicyUpdateRequest, now: string): LearningReviewPolicy;
  enqueueLearningReview(input: EnqueueLearningReviewInput, now: string): LearningReviewJob;
  getLearningReviewJob(id: string): LearningReviewJob | undefined;
  listLearningReviewJobs(status?: LearningReviewJob["status"], limit?: number, runId?: string): LearningReviewJob[];
  claimLearningReviewJob(id: string, fence: RuntimeAttemptFenceV1, now: string): LearningReviewJob | undefined;
  reserveLearningReviewModelRequest(id: string, fence: RuntimeAttemptFenceV1, inputTokens: number, now: string): LearningReviewJob;
  finishLearningReviewJob(id: string, fence: RuntimeAttemptFenceV1, status: "succeeded" | "failed" | "cancelled",
    candidateIds: readonly string[], reason: string | undefined, now: string): LearningReviewJob;
  cancelLearningReviewJob(id: string, reason: string, now: string): LearningReviewJob | undefined;
}
