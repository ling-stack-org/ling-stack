import type {
  RunWorkspaceChangesResponse,
  TurnWorkspaceChangesResponse,
  WorkflowWorkspaceChangesResponse,
  WorkspaceChangesResponse,
  WorkspaceFileOpenOptionsResponse,
  WorkspaceFileOpenRequest,
  WorkspaceFileOpenResponse,
  WorkspaceFileOpenTarget,
  WorkspaceSnapshotManifest,
  WorkspaceSnapshotPreview,
  SnapshotRestoreConfirmation,
  SnapshotRestoreRequest,
} from "../types.js";
import type {
  WorkspaceFileCapabilityPreviewRequest,
  WorkspaceFileCapabilityRequest,
  WorkspaceFileCapabilityResponse,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";
import { channelWorkCellDemoWorkflowRecovery } from "../lib/work-cell-demo-fixture.js";

export function getWorkspaceChanges(cwd: string): Promise<WorkspaceChangesResponse> {
  return daemonClient.getWorkspaceChanges(cwd);
}

export function listWorkspaceSnapshots(cwd: string): Promise<{ readonly cwd: string; readonly snapshots: readonly WorkspaceSnapshotManifest[]; readonly restoreUiEnabled?: boolean }> {
  return daemonClient.listWorkspaceSnapshots(cwd);
}

export function createWorkspaceSnapshot(cwd: string): Promise<{ readonly manifest: WorkspaceSnapshotManifest }> {
  return daemonClient.createWorkspaceSnapshot(cwd);
}

export function getWorkspaceSnapshot(cwd: string, snapshotId: string): Promise<WorkspaceSnapshotPreview> {
  return daemonClient.getWorkspaceSnapshot(cwd, snapshotId);
}

export function createWorkspaceSnapshotAnchor(cwd: string, snapshotId: string): Promise<import("@ling-stack/contracts").WorkspaceSnapshotRestoreAnchor> {
  return daemonClient.createWorkspaceSnapshotAnchor(cwd, snapshotId);
}

export function createWorkspaceSnapshotConfirmation(cwd: string, snapshotId: string, anchorId: string): Promise<SnapshotRestoreConfirmation> {
  return daemonClient.createWorkspaceSnapshotConfirmation(cwd, snapshotId, { anchorId });
}

export function confirmWorkspaceSnapshotRestore(cwd: string, confirmationId: string): Promise<SnapshotRestoreConfirmation> {
  return daemonClient.confirmWorkspaceSnapshotRestore(cwd, confirmationId);
}

export function restoreWorkspaceSnapshot(cwd: string, snapshotId: string, input: { readonly idempotencyKey: string; readonly anchorId: string; readonly confirmationId: string; readonly expectedWorkspaceFingerprint?: string; readonly expectedProvenanceWatermark?: string }): Promise<SnapshotRestoreRequest> {
  return daemonClient.restoreWorkspaceSnapshot(cwd, snapshotId, input);
}

export function getWorkspaceSnapshotRestore(cwd: string, requestId: string): Promise<SnapshotRestoreRequest> {
  return daemonClient.getWorkspaceSnapshotRestore(cwd, requestId);
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

export function openWorkspaceFileCapability(input: WorkspaceFileOpenRequest): Promise<WorkspaceFileOpenResponse> {
  return daemonClient.openWorkspaceFileCapability(input);
}

export function workspaceFileOpenIconUrl(cwd: string, target: WorkspaceFileOpenTarget): string {
  return daemonClient.workspaceFileOpenIconUrl(cwd, target);
}

export function workspaceFileContentUrl(cwd: string, path: string, download = false): string {
  return daemonClient.workspaceFileContentUrl(cwd, path, download);
}

export function issueWorkspaceFileCapability(input: WorkspaceFileCapabilityRequest): Promise<WorkspaceFileCapabilityResponse> {
  return daemonClient.issueWorkspaceFileCapability(input);
}

export function previewWorkspaceFileCapability(input: WorkspaceFileCapabilityPreviewRequest): Promise<import("@ling-stack/contracts").PreviewContentResponse> {
  return daemonClient.previewWorkspaceFileCapability(input);
}
