import type { UpdateWorkspaceSettingsRequest, WorkspaceSettingsResponse } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function getWorkspaceSettings(cwd: string): Promise<WorkspaceSettingsResponse> {
  return daemonClient.getWorkspaceSettings(cwd);
}

export async function updateWorkspaceSettings(cwd: string, input: UpdateWorkspaceSettingsRequest): Promise<WorkspaceSettingsResponse> {
  return daemonClient.updateWorkspaceSettings(cwd, { ...input, schemaVersion: 2 });
}
