import type {
  RunWorkspaceChangesResponse,
  WorkspaceChangesResponse,
  WorkspaceFileOpenOptionsResponse,
  WorkspaceFileOpenRequest,
  WorkspaceFileOpenResponse,
} from "../types.js";
import { daemonClient } from "./client.js";

export function getWorkspaceChanges(cwd: string): Promise<WorkspaceChangesResponse> {
  return daemonClient.getWorkspaceChanges(cwd);
}

export function getRunWorkspaceChanges(cwd: string, runId: string): Promise<RunWorkspaceChangesResponse> {
  return daemonClient.getRunWorkspaceChanges(runId, cwd);
}

export function undoRunWorkspaceChanges(cwd: string, runId: string): Promise<RunWorkspaceChangesResponse> {
  return daemonClient.undoRunWorkspaceChanges(runId, cwd);
}

export function reapplyRunWorkspaceChanges(cwd: string, runId: string): Promise<RunWorkspaceChangesResponse> {
  return daemonClient.reapplyRunWorkspaceChanges(runId, cwd);
}

export function getWorkspaceFileOpenOptions(cwd: string, path: string): Promise<WorkspaceFileOpenOptionsResponse> {
  return daemonClient.getWorkspaceFileOpenOptions(cwd, path);
}

export function openWorkspaceFile(cwd: string, path: string, input: WorkspaceFileOpenRequest): Promise<WorkspaceFileOpenResponse> {
  return daemonClient.openWorkspaceFile(cwd, path, input);
}

export function workspaceFileContentUrl(cwd: string, path: string, download = false): string {
  return daemonClient.workspaceFileContentUrl(cwd, path, download);
}
