import { randomUUID } from "node:crypto";
import type { MediaExecutionMode, MediaExecutionSource, MediaSceneExecutionMode } from "./media-workflow-types.js";

export type MediaJobStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export type MediaOperation = "image_generate" | "image_edit" | "video_generate";

export interface MediaJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerPresetId?: string;
  readonly workflowVersionId?: string;
  readonly executionSource: MediaExecutionSource;
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
  readonly providerPresetId?: string;
  readonly workflowVersionId?: string;
  readonly executionSource?: MediaExecutionSource;
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

export type VideoGenerationInputMode = "text" | "image_reference";

export interface VideoGenerationCapabilities {
  readonly inputModes: readonly VideoGenerationInputMode[];
  readonly aspectRatios?: readonly string[];
  readonly durationsSeconds?: readonly number[];
}

export interface MediaCanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface MediaCanvasPosition {
  readonly x: number;
  readonly y: number;
}

export interface MediaProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultExecutionMode: MediaExecutionMode;
  readonly defaultWorkflowDefinitionId?: string;
  readonly canvasViewport: MediaCanvasViewport;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMediaProjectInput {
  readonly name: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultExecutionMode?: MediaExecutionMode;
  readonly defaultWorkflowDefinitionId?: string;
  readonly canvasViewport?: MediaCanvasViewport;
}

export interface UpdateMediaProjectInput {
  readonly name?: string;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultExecutionMode?: MediaExecutionMode;
  readonly defaultWorkflowDefinitionId?: string | null;
  readonly canvasViewport?: MediaCanvasViewport;
}

export interface MediaScene {
  readonly id: string;
  readonly projectId: string;
  readonly sortOrder: number;
  readonly title: string;
  readonly prompt: string;
  readonly providerPresetId?: string;
  readonly executionMode: MediaSceneExecutionMode;
  readonly workflowDefinitionId?: string;
  readonly workflowInputValues: Record<string, unknown>;
  readonly ratio: string;
  readonly durationSeconds: number;
  readonly referenceArtifactIds: readonly string[];
  readonly canvasPosition: MediaCanvasPosition;
  readonly selectedMediaSceneRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMediaSceneInput {
  readonly projectId: string;
  readonly sortOrder?: number;
  readonly title: string;
  readonly prompt: string;
  readonly providerPresetId?: string;
  readonly executionMode?: MediaSceneExecutionMode;
  readonly workflowDefinitionId?: string;
  readonly workflowInputValues?: Record<string, unknown>;
  readonly ratio?: string;
  readonly durationSeconds?: number;
  readonly referenceArtifactIds?: readonly string[];
  readonly canvasPosition?: MediaCanvasPosition;
}

export interface UpdateMediaSceneInput {
  readonly sortOrder?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly providerPresetId?: string | null;
  readonly executionMode?: MediaSceneExecutionMode;
  readonly workflowDefinitionId?: string | null;
  readonly workflowInputValues?: Record<string, unknown>;
  readonly ratio?: string;
  readonly durationSeconds?: number;
  readonly referenceArtifactIds?: readonly string[];
  readonly canvasPosition?: MediaCanvasPosition;
  readonly selectedMediaSceneRunId?: string | null;
}

export interface MediaSceneRun {
  readonly id: string;
  readonly projectId: string;
  readonly sceneId: string;
  readonly mediaJobId: string;
  readonly providerSnapshot: Record<string, unknown>;
  readonly executionSnapshot: Record<string, unknown>;
  readonly inputSnapshot: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMediaSceneRunInput {
  readonly projectId: string;
  readonly sceneId: string;
  readonly mediaJobId: string;
  readonly providerSnapshot: Record<string, unknown>;
  readonly executionSnapshot?: Record<string, unknown>;
  readonly inputSnapshot: Record<string, unknown>;
}

export interface MediaJobExecutionHandle {
  readonly mediaJobId: string;
  readonly adapterKind: string;
  readonly externalOperationId: string;
  readonly recovery: Record<string, unknown>;
  readonly nextPollAt?: string;
  readonly pollAttempts: number;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertMediaJobExecutionHandleInput {
  readonly mediaJobId: string;
  readonly adapterKind: string;
  readonly externalOperationId: string;
  readonly recovery: Record<string, unknown>;
  readonly nextPollAt?: string | null;
  readonly pollAttempts?: number;
  readonly workUnitId?: string | null;
  readonly attemptId?: string | null;
}

export const mediaJobStatuses: readonly MediaJobStatus[] = ["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"];

export const mediaOperations: readonly MediaOperation[] = ["image_generate", "image_edit", "video_generate"];

export function createMediaJobId(): string {
  return `media_job_${randomUUID()}`;
}

export function createMediaProjectId(): string {
  return `media_project_${randomUUID()}`;
}

export function createMediaSceneId(): string {
  return `media_scene_${randomUUID()}`;
}

export function createMediaSceneRunId(): string {
  return `media_scene_run_${randomUUID()}`;
}
