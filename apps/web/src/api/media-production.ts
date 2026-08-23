import type {
  CreateMediaProjectRequest,
  CreateMediaProjectAssetRequest,
  CreateMediaSceneRequest,
  CreateMediaWorkflowConnectionRequest,
  ImportMediaWorkflowRequest,
  MediaProductionDeleteResponse,
  MediaProductionProjectListResponse,
  MediaProductionProjectResponse,
  MediaProductionProjectRunResponse,
  MediaProductionSceneRunResponse,
  MediaProjectMutationResponse,
  MediaProjectAssetMutationResponse,
  MediaSceneDetailResponse,
  MediaSceneMutationResponse,
  MediaSceneReorderResponse,
  MediaWorkflowAnalysis,
  MediaWorkflowConnectionListResponse,
  MediaWorkflowConnectionResponse,
  MediaWorkflowDefinitionListResponse,
  MediaWorkflowDefinitionResponse,
  MediaWorkflowDeleteResponse,
  MediaWorkflowImportResponse,
  MediaWorkflowTestResponse,
  RunMediaProjectRequest,
  UpdateMediaProjectRequest,
  UpdateMediaSceneRequest,
  UpdateMediaWorkflowConnectionRequest,
} from "../types.js";
import { daemonClient } from "./client.js";

export function listMediaProjects(cwd: string): Promise<MediaProductionProjectListResponse> {
  return daemonClient.listMediaProjects(cwd);
}

export function createMediaProject(cwd: string, input: CreateMediaProjectRequest): Promise<MediaProductionProjectResponse> {
  return daemonClient.createMediaProject(cwd, input);
}

export function getMediaProject(cwd: string, mediaProjectId: string): Promise<MediaProductionProjectResponse> {
  return daemonClient.getMediaProject(cwd, mediaProjectId);
}

export function updateMediaProject(cwd: string, mediaProjectId: string, input: UpdateMediaProjectRequest): Promise<MediaProjectMutationResponse> {
  return daemonClient.updateMediaProject(cwd, mediaProjectId, input);
}

export function deleteMediaProject(cwd: string, mediaProjectId: string): Promise<MediaProductionDeleteResponse> {
  return daemonClient.deleteMediaProject(cwd, mediaProjectId);
}

export function createMediaProjectAsset(
  cwd: string,
  mediaProjectId: string,
  input: CreateMediaProjectAssetRequest,
): Promise<MediaProjectAssetMutationResponse> {
  return daemonClient.createMediaProjectAsset(cwd, mediaProjectId, input);
}

export function deleteMediaProjectAsset(cwd: string, mediaProjectAssetId: string): Promise<MediaProductionDeleteResponse> {
  return daemonClient.deleteMediaProjectAsset(cwd, mediaProjectAssetId);
}

export function mediaProjectAssetContentUrl(cwd: string, mediaProjectAssetId: string): string {
  return daemonClient.mediaProjectAssetContentUrl(cwd, mediaProjectAssetId);
}

export function createMediaScene(cwd: string, mediaProjectId: string, input: CreateMediaSceneRequest): Promise<MediaSceneMutationResponse> {
  return daemonClient.createMediaScene(cwd, mediaProjectId, input);
}

export function updateMediaScene(cwd: string, mediaSceneId: string, input: UpdateMediaSceneRequest): Promise<MediaSceneMutationResponse> {
  return daemonClient.updateMediaScene(cwd, mediaSceneId, input);
}

export function deleteMediaScene(cwd: string, mediaSceneId: string): Promise<MediaProductionDeleteResponse> {
  return daemonClient.deleteMediaScene(cwd, mediaSceneId);
}

export function duplicateMediaScene(cwd: string, mediaSceneId: string): Promise<MediaSceneMutationResponse> {
  return daemonClient.duplicateMediaScene(cwd, mediaSceneId);
}

export function reorderMediaScenes(cwd: string, mediaProjectId: string, sceneIds: readonly string[]): Promise<MediaSceneReorderResponse> {
  return daemonClient.reorderMediaScenes(cwd, mediaProjectId, sceneIds);
}

export function runMediaProject(
  cwd: string,
  mediaProjectId: string,
  input: RunMediaProjectRequest = {},
): Promise<MediaProductionProjectRunResponse> {
  return daemonClient.runMediaProject(cwd, mediaProjectId, input);
}

export function getMediaScene(cwd: string, mediaSceneId: string): Promise<MediaSceneDetailResponse> {
  return daemonClient.getMediaScene(cwd, mediaSceneId);
}

export function runMediaScene(cwd: string, mediaSceneId: string): Promise<MediaProductionSceneRunResponse> {
  return daemonClient.runMediaScene(cwd, mediaSceneId);
}

export function selectMediaSceneRun(cwd: string, mediaSceneId: string, mediaSceneRunId: string): Promise<MediaSceneMutationResponse> {
  return daemonClient.selectMediaSceneRun(cwd, mediaSceneId, mediaSceneRunId);
}

export function cancelMediaSceneRun(cwd: string, mediaSceneRunId: string): Promise<MediaProductionSceneRunResponse> {
  return daemonClient.cancelMediaSceneRun(cwd, mediaSceneRunId);
}

export function listMediaWorkflowConnections(cwd: string): Promise<MediaWorkflowConnectionListResponse> {
  return daemonClient.listMediaWorkflowConnections(cwd);
}

export function createMediaWorkflowConnection(cwd: string, input: CreateMediaWorkflowConnectionRequest): Promise<MediaWorkflowConnectionResponse> {
  return daemonClient.createMediaWorkflowConnection(cwd, input);
}

export function updateMediaWorkflowConnection(cwd: string, connectionId: string, input: UpdateMediaWorkflowConnectionRequest): Promise<MediaWorkflowConnectionResponse> {
  return daemonClient.updateMediaWorkflowConnection(cwd, connectionId, input);
}

export function checkMediaWorkflowConnection(cwd: string, connectionId: string): Promise<MediaWorkflowConnectionResponse> {
  return daemonClient.checkMediaWorkflowConnection(cwd, connectionId);
}

export function deleteMediaWorkflowConnection(cwd: string, connectionId: string): Promise<MediaWorkflowDeleteResponse> {
  return daemonClient.deleteMediaWorkflowConnection(cwd, connectionId);
}

export function listMediaWorkflows(cwd: string): Promise<MediaWorkflowDefinitionListResponse> {
  return daemonClient.listMediaWorkflows(cwd);
}

export function analyzeMediaWorkflow(cwd: string, input: Pick<ImportMediaWorkflowRequest, "connectionId" | "graph">): Promise<MediaWorkflowAnalysis> {
  return daemonClient.analyzeMediaWorkflow(cwd, input);
}

export function importMediaWorkflow(cwd: string, input: ImportMediaWorkflowRequest): Promise<MediaWorkflowImportResponse> {
  return daemonClient.importMediaWorkflow(cwd, input);
}

export function getMediaWorkflow(cwd: string, workflowDefinitionId: string): Promise<MediaWorkflowDefinitionResponse> {
  return daemonClient.getMediaWorkflow(cwd, workflowDefinitionId);
}

export function testMediaWorkflow(cwd: string, workflowDefinitionId: string, input: { readonly versionId?: string; readonly inputValues: Record<string, unknown> }): Promise<MediaWorkflowTestResponse> {
  return daemonClient.testMediaWorkflow(cwd, workflowDefinitionId, input);
}

export function activateMediaWorkflow(cwd: string, workflowDefinitionId: string, versionId: string): Promise<MediaWorkflowDefinitionResponse> {
  return daemonClient.activateMediaWorkflow(cwd, workflowDefinitionId, versionId);
}

export function archiveMediaWorkflow(cwd: string, workflowDefinitionId: string): Promise<MediaWorkflowDefinitionResponse> {
  return daemonClient.archiveMediaWorkflow(cwd, workflowDefinitionId);
}

export function deleteMediaWorkflow(cwd: string, workflowDefinitionId: string): Promise<MediaWorkflowDeleteResponse> {
  return daemonClient.deleteMediaWorkflow(cwd, workflowDefinitionId);
}
