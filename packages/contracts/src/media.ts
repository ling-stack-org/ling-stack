import type { ApprovalRequest } from "./approvals.js";
import type { RunArtifact } from "./artifacts.js";

export type MediaJobStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export type MediaOperation = "image_generate" | "image_edit" | "video_generate";

export interface MediaJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerPresetId: string;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly input: Record<string, unknown>;
  readonly artifactIds: readonly string[];
  readonly status: MediaJobStatus;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MediaJobListResponse {
  readonly cwd: string;
  readonly mediaJobs: readonly MediaJob[];
}

export interface MediaJobMutationResponse {
  readonly mediaJob: MediaJob;
  readonly artifacts?: readonly RunArtifact[];
  readonly approval?: ApprovalRequest;
}

export interface CreateMediaJobRequest {
  readonly providerPresetId: string;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly input?: Record<string, unknown>;
}
