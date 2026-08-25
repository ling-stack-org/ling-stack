import type { ApprovalRequest } from "./approvals.js";
import type { RunArtifact } from "./artifacts.js";
import type { MediaExecutionMode, MediaExecutionSource, MediaSceneExecutionMode } from "./media-workflows.js";

export type MediaJobStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export type MediaOperation = "image_generate" | "image_edit" | "video_generate";

export type ConversationMediaFailureCode =
  | "generation_target_unavailable"
  | "generation_configuration_required"
  | "generation_content_policy_blocked"
  | "generation_authorization_required"
  | "generation_timed_out"
  | "generation_result_unavailable"
  | "generation_failed";

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

export interface ConversationGeneratedMedia {
  readonly mediaJobId: string;
  readonly runId: string;
  readonly messageId?: string;
  readonly operation: Extract<MediaOperation, "image_generate" | "video_generate">;
  readonly target: {
    readonly kind: "provider" | "workflow";
    readonly id: string;
    readonly displayName: string;
  };
  readonly prompt: string;
  readonly status: MediaJobStatus;
  readonly artifacts: readonly RunArtifact[];
  readonly failureCode?: ConversationMediaFailureCode;
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

export type VideoGenerationInputMode = "text" | "first_frame" | "reference_image";

export interface VideoGenerationCapabilities {
  readonly inputModes: readonly VideoGenerationInputMode[];
  readonly maxReferenceImages?: number;
  readonly aspectRatios?: readonly string[];
  readonly durationsSeconds?: readonly number[];
}

export type MediaProjectAssetContentType = "image/jpeg" | "image/png" | "image/webp";

export interface MediaProjectAsset {
  readonly id: string;
  readonly projectId: string;
  readonly fileName: string;
  readonly contentType: MediaProjectAssetContentType;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly checksum: string;
  readonly sourceArtifactId?: string;
  readonly createdAt: string;
}

export type MediaSceneVideoImageRole = "first_frame" | "reference_image";

export interface MediaSceneVideoImageInput {
  readonly assetId: string;
  readonly role: MediaSceneVideoImageRole;
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
  readonly videoImageInputs: readonly MediaSceneVideoImageInput[];
  readonly canvasPosition: MediaCanvasPosition;
  readonly selectedMediaSceneRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface CreateMediaProjectRequest {
  readonly name: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultExecutionMode?: MediaExecutionMode;
  readonly defaultWorkflowDefinitionId?: string;
  readonly canvasViewport?: MediaCanvasViewport;
}

export interface UpdateMediaProjectRequest {
  readonly name?: string;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultExecutionMode?: MediaExecutionMode;
  readonly defaultWorkflowDefinitionId?: string | null;
  readonly canvasViewport?: MediaCanvasViewport;
}

export interface CreateMediaSceneRequest {
  readonly title: string;
  readonly prompt: string;
  readonly providerPresetId?: string;
  readonly executionMode?: MediaSceneExecutionMode;
  readonly workflowDefinitionId?: string;
  readonly workflowInputValues?: Record<string, unknown>;
  readonly ratio?: string;
  readonly durationSeconds?: number;
  readonly referenceArtifactIds?: readonly string[];
  readonly videoImageInputs?: readonly MediaSceneVideoImageInput[];
  readonly canvasPosition?: MediaCanvasPosition;
}

export interface UpdateMediaSceneRequest {
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
  readonly videoImageInputs?: readonly MediaSceneVideoImageInput[];
  readonly canvasPosition?: MediaCanvasPosition;
  readonly selectedMediaSceneRunId?: string | null;
}

export interface MediaProductionProjectResponse {
  readonly mediaProject: MediaProject;
  readonly assets: readonly MediaProjectAsset[];
  readonly scenes: readonly MediaScene[];
  readonly sceneRuns: readonly MediaSceneRun[];
}

export interface MediaProductionProjectListResponse {
  readonly cwd: string;
  readonly mediaProjects: readonly MediaProject[];
}

export interface MediaProductionSceneRunResponse {
  readonly mediaJob: MediaJob;
  readonly mediaSceneRun: MediaSceneRun;
  readonly approval?: ApprovalRequest;
}

export interface MediaProductionProjectRunResponse {
  readonly mediaProject: MediaProject;
  readonly mediaSceneRuns: readonly MediaSceneRun[];
  readonly mediaJobs: readonly MediaJob[];
  readonly approvals?: readonly ApprovalRequest[];
}

export interface RunMediaProjectRequest {
  /**
   * The reviewed scenes to submit. Omitting this keeps the legacy "all scenes"
   * behaviour, while the server still validates the complete set before it creates
   * any durable run records.
   */
  readonly sceneIds?: readonly string[];
}

export interface MediaProjectMutationResponse extends MediaProductionProjectResponse {}

export type CreateMediaProjectAssetRequest =
  | {
      readonly kind: "upload";
      readonly fileName: string;
      readonly contentType: string;
      readonly contentBase64: string;
    }
  | {
      readonly kind: "artifact";
      readonly artifactId: string;
    };

export interface MediaProjectAssetListResponse {
  readonly mediaProjectId: string;
  readonly assets: readonly MediaProjectAsset[];
}

export interface MediaProjectAssetMutationResponse {
  readonly asset: MediaProjectAsset;
}

export interface MediaSceneMutationResponse {
  readonly mediaScene: MediaScene;
  readonly mediaSceneRun?: MediaSceneRun;
}

export interface MediaSceneDetailResponse {
  readonly mediaScene: MediaScene;
  readonly mediaSceneRuns: readonly MediaSceneRun[];
}

export interface MediaSceneReorderResponse {
  readonly mediaProjectId: string;
  readonly scenes: readonly MediaScene[];
}

export interface MediaProductionDeleteResponse {
  readonly deleted: boolean;
  readonly mediaProjectId?: string;
  readonly mediaProjectAssetId?: string;
  readonly mediaSceneId?: string;
}
