import type {
  WorkspaceDirectorySelectResponse,
  RegisteredWorkspacesResponse,
  WorkspaceTerminalCommandRequest,
  WorkspaceTerminalCommandResponse,
  WorkspaceTerminalProfileResponse,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function selectWorkspaceDirectory(cwd: string, register = false): Promise<WorkspaceDirectorySelectResponse> {
  return daemonClient.selectWorkspaceDirectory(cwd, register);
}

export function listRegisteredWorkspaces(): Promise<RegisteredWorkspacesResponse> {
  return daemonClient.listRegisteredWorkspaces();
}

export function activateRegisteredWorkspace(cwd: string): Promise<{ readonly cwd: string }> {
  return daemonClient.activateRegisteredWorkspace(cwd);
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
