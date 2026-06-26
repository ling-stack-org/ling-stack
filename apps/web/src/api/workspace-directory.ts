import type { WorkspaceDirectorySelectResponse } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function selectWorkspaceDirectory(cwd: string): Promise<WorkspaceDirectorySelectResponse> {
  return daemonClient.selectWorkspaceDirectory(cwd);
}
