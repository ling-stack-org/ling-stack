import { randomUUID } from "node:crypto";
import type {
  ApprovalActionType,
  ApprovalPayload,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalStatus,
} from "./approval-types.js";

export type LingApprovalCheckpointStatus =
  | ApprovalStatus
  | "resume_pending"
  | "resumed"
  | "resume_failed";

export interface RunnerResumeHandle {
  readonly kind: "ling_continuation" | "runner_native";
  readonly runnerId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly handleRef?: string;
  readonly payload?: Record<string, unknown>;
  readonly verified?: boolean;
}

export interface LingApprovalCheckpoint {
  readonly id: string;
  readonly approvalId: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
  readonly workflowStepId?: string;
  readonly channelId?: string;
  readonly toolCallId?: string;
  readonly actionType: ApprovalActionType;
  readonly risk: ApprovalRisk;
  readonly title: string;
  readonly description: string;
  readonly status: LingApprovalCheckpointStatus;
  readonly sideEffect: ApprovalPayload;
  readonly previewArtifactIds: readonly string[];
  readonly resultArtifactIds: readonly string[];
  readonly runnerResumeHandle?: RunnerResumeHandle;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
  readonly resumedAt?: string;
  readonly resumeFailureReason?: string;
}

export interface CreateApprovalCheckpointInput {
  readonly approval: ApprovalRequest;
  readonly status?: LingApprovalCheckpointStatus;
  readonly previewArtifactIds?: readonly string[];
  readonly resultArtifactIds?: readonly string[];
  readonly runnerResumeHandle?: RunnerResumeHandle;
}

export interface UpdateApprovalCheckpointStatusInput {
  readonly status: LingApprovalCheckpointStatus;
  readonly resolvedAt?: string;
  readonly resumedAt?: string;
  readonly resumeFailureReason?: string | null;
  readonly previewArtifactIds?: readonly string[];
  readonly resultArtifactIds?: readonly string[];
  readonly runnerResumeHandle?: RunnerResumeHandle | null;
}

export interface ListApprovalCheckpointsOptions {
  readonly status?: LingApprovalCheckpointStatus;
  readonly approvalId?: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
  readonly workflowStepId?: string;
  readonly limit?: number;
}

export const approvalCheckpointStatuses: readonly LingApprovalCheckpointStatus[] = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
  "resume_pending",
  "resumed",
  "resume_failed",
];

export function createApprovalCheckpointId(): string {
  return `approval_checkpoint_${randomUUID()}`;
}
