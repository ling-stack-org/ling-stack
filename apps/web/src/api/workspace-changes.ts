import type {
  RunWorkspaceChangesResponse,
  TurnWorkspaceChangesResponse,
  WorkflowWorkspaceChangesResponse,
  WorkspaceChangesResponse,
  WorkspaceFileOpenOptionsResponse,
  WorkspaceFileOpenRequest,
  WorkspaceFileOpenResponse,
  WorkspaceFileOpenTarget,
} from "../types.js";
import { daemonClient } from "./client.js";
import { channelWorkCellDemoWorkflowRecovery } from "../lib/work-cell-demo-fixture.js";

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

export function getTurnWorkspaceChanges(cwd: string, turnId: string): Promise<TurnWorkspaceChangesResponse> {
  return daemonClient.getTurnWorkspaceChanges(turnId, cwd);
}

export function undoTurnWorkspaceChanges(cwd: string, turnId: string, idempotencyKey: string): Promise<TurnWorkspaceChangesResponse> {
  return daemonClient.undoTurnWorkspaceChanges(turnId, idempotencyKey, cwd);
}

export function reapplyTurnWorkspaceChanges(cwd: string, turnId: string, idempotencyKey: string): Promise<TurnWorkspaceChangesResponse> {
  return daemonClient.reapplyTurnWorkspaceChanges(turnId, idempotencyKey, cwd);
}

export function getWorkflowWorkspaceChanges(cwd: string, workflowId: string): Promise<WorkflowWorkspaceChangesResponse> {
  const demo = channelWorkCellDemoWorkflowRecovery({ cwd, workflowId });
  if (demo) {
    return Promise.resolve(demo);
  }
  return daemonClient.getWorkflowWorkspaceChanges(cwd, workflowId);
}

export function undoWorkflowWorkspaceChanges(cwd: string, workflowId: string): Promise<WorkflowWorkspaceChangesResponse> {
  const demo = channelWorkCellDemoWorkflowRecovery({ cwd, workflowId, action: "undo" });
  if (demo) {
    return Promise.resolve(demo);
  }
  return daemonClient.undoWorkflowWorkspaceChanges(cwd, workflowId);
}

export function reapplyWorkflowWorkspaceChanges(cwd: string, workflowId: string): Promise<WorkflowWorkspaceChangesResponse> {
  const demo = channelWorkCellDemoWorkflowRecovery({ cwd, workflowId, action: "reapply" });
  if (demo) {
    return Promise.resolve(demo);
  }
  return daemonClient.reapplyWorkflowWorkspaceChanges(cwd, workflowId);
}

export function getWorkspaceFileOpenOptions(cwd: string, path: string): Promise<WorkspaceFileOpenOptionsResponse> {
  return daemonClient.getWorkspaceFileOpenOptions(cwd, path);
}

export function openWorkspaceFile(cwd: string, path: string, input: WorkspaceFileOpenRequest): Promise<WorkspaceFileOpenResponse> {
  return daemonClient.openWorkspaceFile(cwd, path, input);
}

export function workspaceFileOpenIconUrl(cwd: string, target: WorkspaceFileOpenTarget): string {
  return daemonClient.workspaceFileOpenIconUrl(cwd, target);
}

export function workspaceFileContentUrl(cwd: string, path: string, download = false): string {
  return daemonClient.workspaceFileContentUrl(cwd, path, download);
}
