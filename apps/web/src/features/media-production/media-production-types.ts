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
import type { MediaJobDisplayContextMap } from "../media/media-job-display-context.js";

export type MediaProductionView = "studio" | "jobs";

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
  readonly projects: readonly MediaProject[];
  readonly project?: MediaProductionProjectDetail;
  readonly selectedProjectId: string;
  readonly selectedSceneId: string;
  readonly isLoading: boolean;
  readonly busyAction: string;
  readonly errorMessage: string;
  readonly noticeMessage: string;
}

export interface MediaProductionActions {
  readonly selectProject: (projectId: string) => void;
  readonly selectScene: (sceneId: string) => void;
  readonly refresh: () => Promise<void>;
  readonly refreshCurrentProject: () => Promise<void>;
  readonly createProject: () => Promise<void>;
  readonly updateProject: (patch: UpdateMediaProjectRequest) => Promise<void>;
  readonly createScene: () => Promise<void>;
  readonly updateScene: (sceneId: string, patch: MediaScenePatch) => Promise<void>;
  readonly reorderScenes: (sceneIds: readonly string[]) => Promise<void>;
  readonly duplicateScene: (sceneId: string) => Promise<void>;
  readonly deleteScene: (sceneId: string) => Promise<void>;
  readonly runScene: (sceneId: string) => Promise<void>;
  readonly runProject: (sceneIds: readonly string[]) => Promise<void>;
  readonly selectSceneRun: (sceneId: string, sceneRunId: string) => Promise<void>;
  readonly cancelSceneRun: (sceneRunId: string) => Promise<void>;
}

export type MediaScenePatch = UpdateMediaSceneRequest;

export interface MediaProductionPageProps {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly mediaJobs: readonly import("../../types.js").MediaJob[];
  readonly mediaArtifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly onJobsChanged: () => void;
  readonly onConfigureVideoModel: () => void;
  readonly jobsPanel: (context: MediaJobDisplayContextMap) => ReactNode;
}

export interface SceneCapabilityContext {
  readonly provider?: ProviderPreset;
  readonly videoGeneration?: VideoGenerationCapabilities;
}
