import type {
  WorkspaceDirectorySelectResponse,
  WorkspaceTerminalCommandRequest,
  WorkspaceTerminalCommandResponse,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function selectWorkspaceDirectory(cwd: string): Promise<WorkspaceDirectorySelectResponse> {
  return daemonClient.selectWorkspaceDirectory(cwd);
}

export async function runWorkspaceTerminalCommand(
  cwd: string,
  input: WorkspaceTerminalCommandRequest,
): Promise<WorkspaceTerminalCommandResponse> {
  return daemonClient.runWorkspaceTerminalCommand(cwd, input);
}
