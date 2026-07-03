import type {
  WorkspaceDirectorySelectResponse,
  WorkspaceTerminalCommandRequest,
  WorkspaceTerminalCommandResponse,
  WorkspaceTerminalProfileResponse,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function selectWorkspaceDirectory(cwd: string): Promise<WorkspaceDirectorySelectResponse> {
  return daemonClient.selectWorkspaceDirectory(cwd);
}

export async function getWorkspaceTerminalProfile(cwd: string): Promise<WorkspaceTerminalProfileResponse> {
  return daemonClient.getWorkspaceTerminalProfile(cwd);
}

export async function runWorkspaceTerminalCommand(
  cwd: string,
  input: WorkspaceTerminalCommandRequest,
): Promise<WorkspaceTerminalCommandResponse> {
  return daemonClient.runWorkspaceTerminalCommand(cwd, input);
}
