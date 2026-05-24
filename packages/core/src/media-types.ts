import { randomUUID } from "node:crypto";

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

export interface CreateMediaJobInput {
  readonly providerPresetId: string;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly input?: Record<string, unknown>;
}

export interface ListMediaJobsOptions {
  readonly providerPresetId?: string;
  readonly status?: MediaJobStatus;
  readonly limit?: number;
}

export interface UpdateMediaJobStatusInput {
  readonly status: MediaJobStatus;
  readonly artifactIds?: readonly string[];
  readonly errorMessage?: string | null;
}

export const mediaJobStatuses: readonly MediaJobStatus[] = ["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"];

export const mediaOperations: readonly MediaOperation[] = ["image_generate", "image_edit", "video_generate"];

export function createMediaJobId(): string {
  return `media_job_${randomUUID()}`;
}
