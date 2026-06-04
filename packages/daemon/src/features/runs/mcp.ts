import { createHash } from "node:crypto";
import {
  type McpServer,
  type McpTool,
  type RunMcpServerAccessSnapshot,
  type RunMcpToolAccessSnapshot,
  type RunStore,
} from "@ling-stack/core";
import type { PiRunnerMcpToolDefinition, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { McpBroker } from "../../context.js";
import { collectMcpServerSecrets, mcpServerSecretNames } from "../mcp/secrets.js";
import { removeUndefined } from "../../shared/validation.js";
import type { RunRequest } from "./schemas.js";

export function resolveMcpToolAccessForRun(
  store: RunStore,
  runRequest: RunRequest,
  resolveTeammateId: (teammateId: string) => string | undefined,
): RunMcpToolAccessSnapshot {
  if (!runRequest.teammateId) {
    return { servers: [], totalToolCount: 0 };
  }

  const teammateId = resolveTeammateId(runRequest.teammateId) ?? runRequest.teammateId;
  const servers: RunMcpServerAccessSnapshot[] = [];
  let totalToolCount = 0;

  for (const binding of store.listTeammateMcpBindings(teammateId)) {
    if (!binding.enabled) {
      continue;
    }
    const server = store.getMcpServer(binding.serverId);
    if (!server?.enabled) {
      continue;
    }
    const tools = store
      .listMcpTools({ serverId: server.id, enabled: true, limit: 500 })
      .filter((tool) => isMcpToolAuthorizedForRun(server, binding, tool))
      .map((tool) => {
        const approval = binding.approvalOverrides[tool.rawName] ?? tool.defaultApproval;
        return removeUndefined({
          rawName: tool.rawName,
          registeredName: createMcpRunnerToolName(server.id, tool.rawName),
          displayName: tool.displayName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          callableNamespace: tool.callableNamespace,
          callableName: tool.callableName,
          sideEffectLevel: tool.sideEffectLevel,
          approval,
        });
      });
    if (tools.length === 0) {
      continue;
    }

    const configuredSecretNames: string[] = [];
    const missingSecretNames: string[] = [];
    for (const secretName of mcpServerSecretNames(server)) {
      if (store.hasMcpServerSecret(server.id, secretName)) {
        configuredSecretNames.push(secretName);
      } else {
        missingSecretNames.push(secretName);
      }
    }
    totalToolCount += tools.length;
    servers.push({
      serverId: server.id,
      displayName: server.displayName,
      transportType: server.transport.type,
      required: server.required,
      status: server.status,
      configuredSecretNames,
      missingSecretNames,
      tools,
    });
  }

  return {
    teammateId,
    servers,
    totalToolCount,
  };
}

export function createPiRunnerMcpToolDefinitions(access: RunMcpToolAccessSnapshot): PiRunnerMcpToolDefinition[] {
  return access.servers.flatMap((server) =>
    server.tools.map((tool) => ({
      registeredName: tool.registeredName,
      serverId: server.serverId,
      rawName: tool.rawName,
      displayName: tool.displayName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      sideEffectLevel: tool.sideEffectLevel,
      defaultApproval: tool.approval,
    })),
  );
}

export function createMcpToolCallHandler(
  store: RunStore,
  mcpBroker: McpBroker,
  tools: readonly PiRunnerMcpToolDefinition[],
): NonNullable<PiRunnerRunOptions["onMcpToolCall"]> {
  const byRegisteredName = new Map(tools.map((tool) => [tool.registeredName, tool]));
  return async (request) => {
    const tool = byRegisteredName.get(request.registeredName);
    if (!tool) {
      throw new Error(`MCP tool is not authorized for this run: ${request.registeredName}`);
    }
    const server = store.getMcpServer(tool.serverId);
    if (!server?.enabled) {
      throw new Error(`MCP server is disabled or missing: ${tool.serverId}`);
    }
    const cachedTool = store.listMcpTools({ serverId: server.id, enabled: true, limit: 500 }).find((item) => item.rawName === tool.rawName);
    if (!cachedTool || !isMcpToolEnabledForServer(server, cachedTool)) {
      throw new Error(`MCP tool is disabled or missing: ${tool.rawName}`);
    }
    return mcpBroker.callTool(server, collectMcpServerSecrets(store, server), tool.rawName, request.input);
  };
}

export function collectMcpSecretValuesForAccess(store: RunStore, access: RunMcpToolAccessSnapshot): readonly (string | undefined)[] {
  return access.servers.flatMap((serverAccess) => {
    const server = store.getMcpServer(serverAccess.serverId);
    if (!server) {
      return [];
    }
    return Object.values(collectMcpServerSecrets(store, server));
  });
}

function isMcpToolAuthorizedForRun(
  server: McpServer,
  binding: ReturnType<RunStore["listTeammateMcpBindings"]>[number],
  tool: McpTool,
): boolean {
  if (!tool.enabled) {
    return false;
  }
  if (!isMcpToolEnabledForServer(server, tool)) {
    return false;
  }
  if (binding.mode === "all_current_tools") {
    return true;
  }
  return binding.selectedToolNames.includes(tool.rawName);
}

function isMcpToolEnabledForServer(server: McpServer, tool: Pick<McpTool, "rawName" | "enabled">): boolean {
  if (!tool.enabled) {
    return false;
  }
  if (server.enabledTools && !server.enabledTools.includes(tool.rawName)) {
    return false;
  }
  return !server.disabledTools.includes(tool.rawName);
}

function createMcpRunnerToolName(serverId: string, rawName: string): string {
  const stem = `${serverId}_${rawName}`.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 64);
  const hash = createHash("sha1").update(`${serverId}:${rawName}`).digest("hex").slice(0, 8);
  return `mcp_${stem}_${hash}`;
}
