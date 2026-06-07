import type {
  McpServerCheckResponse,
  McpServerFormState,
  McpServerListResponse,
  McpServerMutationResponse,
  McpServerStatusResponse,
  McpServerToolSyncResponse,
  McpToolListResponse,
} from "../types.js";
import { daemonClient } from "./client.js";
import { mcpServerFormToPayload } from "./mcp-payloads.js";

export async function listMcpServers(cwd: string): Promise<McpServerListResponse> {
  return daemonClient.listMcpServers(cwd);
}

export async function createMcpServer(cwd: string, form: McpServerFormState): Promise<McpServerMutationResponse> {
  return daemonClient.createMcpServer(cwd, mcpServerFormToPayload(form));
}

export async function updateMcpServer(cwd: string, serverId: string, form: McpServerFormState): Promise<McpServerMutationResponse> {
  return daemonClient.updateMcpServer(cwd, serverId, mcpServerFormToPayload(form));
}

export async function deleteMcpServer(cwd: string, serverId: string): Promise<void> {
  await daemonClient.deleteMcpServer(cwd, serverId);
}

export async function checkMcpServer(cwd: string, serverId: string): Promise<McpServerCheckResponse> {
  return daemonClient.checkMcpServer(cwd, serverId);
}

export async function getMcpServerStatus(cwd: string, serverId: string): Promise<McpServerStatusResponse> {
  return daemonClient.getMcpServerStatus(cwd, serverId);
}

export async function syncMcpServerTools(cwd: string, serverId: string): Promise<McpServerToolSyncResponse> {
  return daemonClient.syncMcpServerTools(cwd, serverId);
}

export async function listMcpTools(cwd: string, serverId?: string): Promise<McpToolListResponse> {
  return daemonClient.listMcpTools(cwd, serverId);
}
