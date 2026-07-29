import type {
  MediaProject,
  MediaScene,
  MediaSceneRun,
  ProviderPreset,
  RunArtifact,
  UpdateMediaProjectRequest,
  UpdateMediaSceneRequest,
  VideoGenerationCapabilities,
} from "../../types.js";
import type { ReactNode } from "react";
import type { MediaJobDisplayContextMap, MediaJobHostActions } from "../media/media-job-display-context.js";

export type MediaProductionView = "studio" | "jobs";

export type MediaProductionResourcePhase = "initial" | "loading" | "ready" | "refreshing" | "error";

export type MediaProductionFailureOwner =
  | "project-list"
  | "project-detail"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "scene-create"
  | "scene-update"
  | "scene-duplicate"
  | "scene-reorder"
  | "scene-move"
  | "scene-delete"
  | "scene-run"
  | "project-run"
  | "run-cancel"
  | "run-select"
  | "workflow-list"
  | "workflow-connection"
  | "workflow-import"
  | "workflow-test"
  | "workflow-activate"
  | "workflow-archive"
  | "preview-content";

export type MediaProductionRetryIntent =
  | { readonly kind: "project-list" }
  | { readonly kind: "project-detail"; readonly projectId: string }
  | { readonly kind: "project-create" }
  | { readonly kind: "project-update"; readonly projectId: string; readonly patch: UpdateMediaProjectRequest }
  | { readonly kind: "project-delete"; readonly projectId: string }
  | { readonly kind: "scene-create"; readonly projectId: string }
  | { readonly kind: "scene-update"; readonly sceneId: string; readonly patch: UpdateMediaSceneRequest }
  | { readonly kind: "scene-duplicate"; readonly sceneId: string }
  | { readonly kind: "scene-reorder"; readonly projectId: string; readonly sceneIds: readonly string[] }
  | { readonly kind: "scene-delete"; readonly sceneId: string }
  | { readonly kind: "scene-run"; readonly sceneId: string }
  | { readonly kind: "project-run"; readonly projectId: string; readonly sceneIds: readonly string[] }
  | { readonly kind: "run-cancel"; readonly sceneRunId: string }
  | { readonly kind: "run-select"; readonly sceneId: string; readonly sceneRunId: string }
  | { readonly kind: "workflow-list" }
  | { readonly kind: "workflow-connection"; readonly subjectId?: string }
  | { readonly kind: "workflow-import" }
  | { readonly kind: "workflow-test"; readonly workflowId: string }
  | { readonly kind: "workflow-activate"; readonly workflowId: string }
  | { readonly kind: "workflow-archive"; readonly workflowId: string }
  | { readonly kind: "preview-content"; readonly sceneId: string; readonly artifactId: string };

export interface MediaProductionFailure {
  readonly owner: MediaProductionFailureOwner;
  readonly subjectId?: string;
  readonly productMessageKey: string;
  readonly technicalMessage?: string;
  readonly retryIntent: MediaProductionRetryIntent;
}

export type MediaProductionMutationOutcome<T = undefined> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: MediaProductionFailure };

export interface MediaProductionBusyState {
  readonly projectList: boolean;
  readonly projectCreate: boolean;
  readonly projectUpdateId: string;
  readonly projectDeleteId: string;
  readonly sceneCreateProjectId: string;
  readonly sceneUpdateIds: readonly string[];
  readonly sceneDuplicateIds: readonly string[];
  readonly sceneMoveIds: readonly string[];
  readonly sceneReorderProjectId: string;
  readonly sceneDeleteIds: readonly string[];
  readonly sceneRunIds: readonly string[];
  readonly projectRunId: string;
  readonly cancelRunIds: readonly string[];
  readonly selectRunIds: readonly string[];
}

export interface MediaProductionWorkflowDangerTarget {
  readonly kind: "connection" | "workflow";
  readonly id: string;
}

export type MediaProductionOverlay =
  | { readonly kind: "none" }
  | { readonly kind: "delete-project"; readonly projectId: string; readonly trigger: HTMLElement | null }
  | { readonly kind: "delete-scene"; readonly sceneId: string; readonly trigger: HTMLElement | null }
  | { readonly kind: "run-project"; readonly projectId: string; readonly trigger: HTMLElement | null }
  | { readonly kind: "preview"; readonly sceneId: string; readonly artifactId: string; readonly trigger: HTMLElement | null }
  | { readonly kind: "workflow"; readonly tab: "workflows" | "connections"; readonly trigger: HTMLElement | null }
  | { readonly kind: "workflow-danger"; readonly target: MediaProductionWorkflowDangerTarget; readonly trigger: HTMLElement | null };

export interface MediaProductionToastIntent {
  readonly messageKey: string;
  readonly scope: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface StoryboardFocusRequest {
  readonly sceneId: string;
  readonly sequence: number;
}

export interface MediaProductionProjectDetail {
  readonly mediaProject: MediaProject;
  readonly scenes: readonly MediaScene[];
  readonly sceneRuns: readonly MediaSceneRun[];
}

export interface MediaProductionState {
  readonly workspaceEpoch: number;
  readonly listPhase: MediaProductionResourcePhase;
  readonly detailPhase: MediaProductionResourcePhase;
  readonly projects: readonly MediaProject[];
  readonly project?: MediaProductionProjectDetail;
  readonly selectedProjectId: string;
  readonly pendingProjectId: string;
  readonly selectedSceneId: string;
  readonly failures: readonly MediaProductionFailure[];
  readonly busy: MediaProductionBusyState;
}

export interface MediaProductionActions {
  readonly selectProject: (projectId: string) => void;
  readonly selectScene: (sceneId: string) => void;
  readonly refresh: () => Promise<MediaProductionMutationOutcome>;
  readonly refreshCurrentProject: () => Promise<MediaProductionMutationOutcome>;
  readonly retryFailure: (failure: MediaProductionFailure) => Promise<MediaProductionMutationOutcome>;
  readonly clearFailure: (owner: MediaProductionFailureOwner, subjectId?: string) => void;
  readonly createProject: () => Promise<MediaProductionMutationOutcome>;
  readonly updateProject: (patch: UpdateMediaProjectRequest) => Promise<MediaProductionMutationOutcome>;
  readonly deleteProject: (projectId: string) => Promise<MediaProductionMutationOutcome>;
  readonly createScene: () => Promise<MediaProductionMutationOutcome>;
  readonly updateScene: (sceneId: string, patch: MediaScenePatch) => Promise<MediaProductionMutationOutcome>;
  readonly reorderScenes: (sceneIds: readonly string[]) => Promise<MediaProductionMutationOutcome>;
  readonly duplicateScene: (sceneId: string) => Promise<MediaProductionMutationOutcome>;
  readonly deleteScene: (sceneId: string) => Promise<MediaProductionMutationOutcome>;
  readonly runScene: (sceneId: string) => Promise<MediaProductionMutationOutcome>;
  readonly runProject: (sceneIds: readonly string[]) => Promise<MediaProductionMutationOutcome>;
  readonly selectSceneRun: (sceneId: string, sceneRunId: string) => Promise<MediaProductionMutationOutcome>;
  readonly cancelSceneRun: (sceneRunId: string) => Promise<MediaProductionMutationOutcome>;
}

export type MediaScenePatch = UpdateMediaSceneRequest;

export interface MediaProductionPageProps {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly mediaJobs: readonly import("../../types.js").MediaJob[];
  readonly mediaArtifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly onJobsChanged: () => void;
  readonly onOpenMediaJob: (jobId: string) => void;
  readonly onConfigureVideoModel: () => void;
  readonly jobsPanel: (input: {
    readonly jobContext: MediaJobDisplayContextMap;
    readonly hostActions: MediaJobHostActions;
  }) => ReactNode;
}

export interface SceneCapabilityContext {
  readonly provider?: ProviderPreset;
  readonly videoGeneration?: VideoGenerationCapabilities;
}
