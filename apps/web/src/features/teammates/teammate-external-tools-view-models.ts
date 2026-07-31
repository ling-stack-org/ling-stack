import type { McpServer, McpTool, TeammateMcpBinding } from "../../types.js";
import {
  teammateMcpServerStatusPresentation,
  type TeammateMcpServerStatusPresentation,
} from "./teammate-mcp-status-presentation.js";

export type ExternalToolFilter = "all" | "authorized" | "high-risk";

export interface ExternalToolServiceRow {
  readonly server: McpServer;
  readonly tools: readonly McpTool[];
  readonly selectedToolNames: ReadonlySet<string>;
  readonly authorizedCount: number;
  readonly status: TeammateMcpServerStatusPresentation;
}

export function buildExternalToolServiceRows(input: {
  readonly servers: readonly McpServer[];
  readonly toolsByServerId: ReadonlyMap<string, readonly McpTool[]>;
  readonly bindingByServerId: ReadonlyMap<string, TeammateMcpBinding>;
}): readonly ExternalToolServiceRow[] {
  return input.servers.map((server) => {
    const tools = input.toolsByServerId.get(server.id) ?? [];
    const selectedToolNames = selectedExternalToolNames(input.bindingByServerId.get(server.id), tools);
    return {
      server,
      tools,
      selectedToolNames,
      authorizedCount: selectedToolNames.size,
      status: teammateMcpServerStatusPresentation(server),
    };
  });
}

export function filterExternalTools(
  tools: readonly McpTool[],
  selectedToolNames: ReadonlySet<string>,
  searchQuery: string,
  filter: ExternalToolFilter,
): readonly McpTool[] {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  return tools.filter((tool) => {
    if (filter === "authorized" && !selectedToolNames.has(tool.rawName)) return false;
    if (filter === "high-risk" && !isHighRiskExternalTool(tool)) return false;
    if (!normalizedQuery) return true;
    return [tool.displayName, externalToolDescription(tool) ?? ""]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}

export function selectedExternalToolNames(
  binding: TeammateMcpBinding | undefined,
  tools: readonly McpTool[],
): ReadonlySet<string> {
  if (!binding?.enabled) return new Set();
  if (binding.mode === "all_current_tools") {
    return new Set(tools.filter((tool) => tool.enabled !== false).map((tool) => tool.rawName));
  }
  const availableNames = new Set(tools.map((tool) => tool.rawName));
  return new Set(binding.selectedToolNames.filter((name) => availableNames.has(name)));
}

export function externalToolDisplayName(tool: McpTool, fallback: string): string {
  return tool.displayName.trim() || fallback;
}

export function externalToolDescription(tool: McpTool): string | undefined {
  const description = tool.description?.trim();
  if (!description || containsTechnicalConnectionTerm(description)) return undefined;
  return description;
}

export function externalToolBindingsFingerprint(bindings: readonly TeammateMcpBinding[]): string {
  return JSON.stringify(bindings
    .map((binding) => ({
      serverId: binding.serverId,
      mode: binding.mode,
      selectedToolNames: [...binding.selectedToolNames].sort(),
      approvalOverrides: Object.fromEntries(Object.entries(binding.approvalOverrides).sort(([left], [right]) => left.localeCompare(right))),
      enabled: binding.enabled,
    }))
    .sort((left, right) => left.serverId.localeCompare(right.serverId)));
}

function isHighRiskExternalTool(tool: McpTool): boolean {
  return tool.sideEffectLevel === "write"
    || tool.sideEffectLevel === "write-network"
    || tool.sideEffectLevel === "external"
    || tool.sideEffectLevel === "credential"
    || tool.sideEffectLevel === "deploy";
}

function containsTechnicalConnectionTerm(value: string): boolean {
  return /(?:\bMCP\b|\braw tool\b|\bserver id\b|\bstdio\b|\bstreamable-http\b|\btransport\b)/iu.test(value);
}
