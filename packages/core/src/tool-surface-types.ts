import type { ToolDefaultApproval, ToolSideEffectLevel } from "@ling-stack/plugin-sdk";
import {
  defaultApprovalToolDecisions,
  readOnlyRunTools,
  riskyRunTools,
  type ApprovalPolicy,
  type RunTool,
} from "./approval-policy.js";
import type { McpServer, McpTool } from "./mcp-types.js";
import type { SkillDefinition } from "./skill-types.js";

export type LingToolNamespaceKind = "core" | "mcp";

export type LingToolDescriptorSourceKind = "core_tool" | "mcp_tool";

export type LingToolDisabledReasonCode =
  | "policy_deny"
  | "server_disabled"
  | "tool_disabled"
  | "server_enabled_tools_excludes"
  | "server_disabled_tools_includes"
  | "runner_unsupported";

export interface LingToolDisabledReason {
  readonly code: LingToolDisabledReasonCode;
  readonly message: string;
}

export interface LingToolRunnerSnapshot {
  readonly id: string;
  readonly displayName?: string;
  readonly status: "enabled" | "disabled";
  readonly supportedTools?: readonly string[];
}

export interface LingToolDescriptor {
  readonly id: string;
  readonly namespaceId: string;
  readonly sourceKind: LingToolDescriptorSourceKind;
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly sideEffectLevel: ToolSideEffectLevel;
  readonly defaultApproval: ToolDefaultApproval;
  readonly executionApproval: ToolDefaultApproval;
  readonly schemaAvailable: boolean;
  readonly enabled: boolean;
  readonly disabledReasons: readonly LingToolDisabledReason[];
  readonly requiredBySkillIds: readonly string[];
  readonly supportedByRunnerIds: readonly string[];
}

export interface LingToolNamespace {
  readonly id: string;
  readonly kind: LingToolNamespaceKind;
  readonly displayName: string;
  readonly ownerId?: string;
  readonly tools: readonly LingToolDescriptor[];
}

export interface LingToolNamespaceCatalog {
  readonly schemaVersion: 1;
  readonly namespaces: readonly LingToolNamespace[];
  readonly generatedAt?: string;
}

export interface BuildLingToolNamespaceCatalogInput {
  readonly approvalPolicy?: Pick<ApprovalPolicy, "toolDecisions">;
  readonly coreTools?: readonly RunTool[];
  readonly mcpServers?: readonly McpServer[];
  readonly mcpTools?: readonly McpTool[];
  readonly skills?: readonly Pick<SkillDefinition, "id" | "requiredTools">[];
  readonly runners?: readonly LingToolRunnerSnapshot[];
  readonly generatedAt?: string;
}

const allCoreTools = [...readOnlyRunTools, ...riskyRunTools] as const satisfies readonly RunTool[];

export function buildLingToolNamespaceCatalog(input: BuildLingToolNamespaceCatalogInput = {}): LingToolNamespaceCatalog {
  const coreTools = input.coreTools ?? allCoreTools;
  const skillRequirements = buildSkillRequirements(input.skills ?? []);
  const runnerSupport = buildRunnerSupport(input.runners);
  const namespaces: LingToolNamespace[] = [
    {
      id: "core",
      kind: "core",
      displayName: "Core tools",
      tools: coreTools.map((tool) => buildCoreToolDescriptor(tool, input.approvalPolicy, skillRequirements, runnerSupport)),
    },
  ];

  const mcpToolsByServer = groupMcpToolsByServer(input.mcpTools ?? []);
  for (const server of input.mcpServers ?? []) {
    const tools = (mcpToolsByServer.get(server.id) ?? []).map((tool) => buildMcpToolDescriptor(server, tool));
    namespaces.push({
      id: `mcp:${server.id}`,
      kind: "mcp",
      displayName: server.displayName,
      ownerId: server.id,
      tools,
    });
  }

  return {
    schemaVersion: 1,
    namespaces,
    generatedAt: input.generatedAt,
  };
}

function buildCoreToolDescriptor(
  tool: RunTool,
  approvalPolicy: Pick<ApprovalPolicy, "toolDecisions"> | undefined,
  skillRequirements: ReadonlyMap<RunTool, readonly string[]>,
  runnerSupport: ReadonlyMap<RunTool, readonly string[]> | undefined,
): LingToolDescriptor {
  const executionApproval = toToolDefaultApproval(approvalPolicy?.toolDecisions[tool] ?? defaultApprovalToolDecisions[tool]);
  const supportedByRunnerIds = runnerSupport?.get(tool) ?? [];
  const disabledReasons: LingToolDisabledReason[] = [];
  if (executionApproval === "deny") {
    disabledReasons.push({
      code: "policy_deny",
      message: `Workspace approval policy denies ${tool}.`,
    });
  }
  if (runnerSupport && supportedByRunnerIds.length === 0) {
    disabledReasons.push({
      code: "runner_unsupported",
      message: `No enabled runner in this catalog supports ${tool}.`,
    });
  }

  return {
    id: `core:${tool}`,
    namespaceId: "core",
    sourceKind: "core_tool",
    name: tool,
    displayName: coreToolDisplayName(tool),
    sideEffectLevel: coreToolSideEffectLevel(tool),
    defaultApproval: toToolDefaultApproval(defaultApprovalToolDecisions[tool]),
    executionApproval,
    schemaAvailable: true,
    enabled: disabledReasons.length === 0,
    disabledReasons,
    requiredBySkillIds: skillRequirements.get(tool) ?? [],
    supportedByRunnerIds,
  };
}

function buildMcpToolDescriptor(server: McpServer, tool: McpTool): LingToolDescriptor {
  const disabledReasons = disabledReasonsForMcpTool(server, tool);
  return {
    id: `mcp:${server.id}:${tool.rawName}`,
    namespaceId: `mcp:${server.id}`,
    sourceKind: "mcp_tool",
    name: tool.rawName,
    displayName: tool.displayName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    sideEffectLevel: tool.sideEffectLevel,
    defaultApproval: tool.defaultApproval,
    executionApproval: tool.defaultApproval,
    schemaAvailable: true,
    enabled: disabledReasons.length === 0,
    disabledReasons,
    requiredBySkillIds: [],
    supportedByRunnerIds: [],
  };
}

function disabledReasonsForMcpTool(server: McpServer, tool: McpTool): LingToolDisabledReason[] {
  const reasons: LingToolDisabledReason[] = [];
  if (!server.enabled) {
    reasons.push({
      code: "server_disabled",
      message: `MCP server ${server.displayName} is disabled.`,
    });
  }
  if (!tool.enabled) {
    reasons.push({
      code: "tool_disabled",
      message: `MCP tool ${tool.rawName} is disabled.`,
    });
  }
  if (server.enabledTools && !server.enabledTools.includes(tool.rawName)) {
    reasons.push({
      code: "server_enabled_tools_excludes",
      message: `MCP server ${server.displayName} does not include ${tool.rawName} in enabledTools.`,
    });
  }
  if (server.disabledTools.includes(tool.rawName)) {
    reasons.push({
      code: "server_disabled_tools_includes",
      message: `MCP server ${server.displayName} lists ${tool.rawName} in disabledTools.`,
    });
  }
  if (tool.defaultApproval === "deny") {
    reasons.push({
      code: "policy_deny",
      message: `MCP tool ${tool.rawName} defaults to deny.`,
    });
  }
  return reasons;
}

function buildSkillRequirements(skills: readonly Pick<SkillDefinition, "id" | "requiredTools">[]): ReadonlyMap<RunTool, readonly string[]> {
  const byTool = new Map<RunTool, string[]>();
  for (const skill of skills) {
    for (const tool of skill.requiredTools) {
      const ids = byTool.get(tool) ?? [];
      ids.push(skill.id);
      byTool.set(tool, ids);
    }
  }
  return byTool;
}

function buildRunnerSupport(runners: readonly LingToolRunnerSnapshot[] | undefined): ReadonlyMap<RunTool, readonly string[]> | undefined {
  if (!runners) {
    return undefined;
  }
  const support = new Map<RunTool, string[]>();
  const enabledRunners = runners.filter((runner) => runner.status === "enabled");
  for (const tool of allCoreTools) {
    support.set(tool, enabledRunners
      .filter((runner) => !runner.supportedTools || runner.supportedTools.includes(tool))
      .map((runner) => runner.id));
  }
  return support;
}

function groupMcpToolsByServer(tools: readonly McpTool[]): ReadonlyMap<string, readonly McpTool[]> {
  const byServer = new Map<string, McpTool[]>();
  for (const tool of tools) {
    const serverTools = byServer.get(tool.serverId) ?? [];
    serverTools.push(tool);
    byServer.set(tool.serverId, serverTools);
  }
  return byServer;
}

function coreToolSideEffectLevel(tool: RunTool): ToolSideEffectLevel {
  if ((readOnlyRunTools as readonly string[]).includes(tool)) {
    return "read";
  }
  if (tool === "bash") {
    return "write-network";
  }
  return "write";
}

function coreToolDisplayName(tool: RunTool): string {
  switch (tool) {
    case "read":
      return "Read";
    case "grep":
      return "Grep";
    case "find":
      return "Find";
    case "ls":
      return "List";
    case "bash":
      return "Bash";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
  }
}

function toToolDefaultApproval(value: ToolDefaultApproval): ToolDefaultApproval {
  return value;
}
