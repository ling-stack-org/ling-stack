import { randomUUID } from "node:crypto";
import type { ToolDefaultApproval, ToolSideEffectLevel } from "@ling-stack/plugin-sdk";

export const mcpServerTransportTypes = ["stdio", "streamable-http"] as const;
export type McpServerTransportType = (typeof mcpServerTransportTypes)[number];

export interface McpStdioTransport {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly secretEnvNames: readonly string[];
}

export interface McpStreamableHttpTransport {
  readonly type: "streamable-http";
  readonly url: string;
  readonly bearerTokenEnvVar?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly envHeaders: Readonly<Record<string, string>>;
  readonly secretHeaderNames: readonly string[];
  readonly oauthClientId?: string;
  readonly oauthResource?: string;
}

export type McpServerTransport = McpStdioTransport | McpStreamableHttpTransport;

export type McpServerStatusKind = "unknown" | "checking" | "ready" | "failed" | "disabled";

export interface McpServerStatus {
  readonly kind: McpServerStatusKind;
  readonly message?: string;
  readonly checkedAt?: string;
}

export interface McpServer {
  readonly id: string;
  readonly workspaceId: string;
  readonly displayName: string;
  readonly transport: McpServerTransport;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly status: McpServerStatus;
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
  readonly enabledTools?: readonly string[];
  readonly disabledTools: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMcpServerInput {
  readonly id?: string;
  readonly displayName: string;
  readonly transport: McpServerTransport;
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly status?: McpServerStatus;
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
  readonly enabledTools?: readonly string[];
  readonly disabledTools?: readonly string[];
}

export interface UpdateMcpServerInput {
  readonly displayName?: string;
  readonly transport?: McpServerTransport;
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly status?: McpServerStatus;
  readonly startupTimeoutSec?: number | null;
  readonly toolTimeoutSec?: number | null;
  readonly enabledTools?: readonly string[] | null;
  readonly disabledTools?: readonly string[];
}

export interface ListMcpServersOptions {
  readonly enabled?: boolean;
  readonly limit?: number;
}

export interface McpTool {
  readonly serverId: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly callableNamespace: string;
  readonly callableName: string;
  readonly sideEffectLevel: ToolSideEffectLevel;
  readonly defaultApproval: ToolDefaultApproval;
  readonly enabled: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly updatedAt: string;
}

export interface ReplaceMcpServerToolInput {
  readonly rawName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly callableNamespace: string;
  readonly callableName: string;
  readonly sideEffectLevel: ToolSideEffectLevel;
  readonly defaultApproval: ToolDefaultApproval;
  readonly enabled?: boolean;
}

export interface ListMcpToolsOptions {
  readonly serverId?: string;
  readonly enabled?: boolean;
  readonly limit?: number;
}

export type TeammateMcpBindingMode = "selected" | "all_current_tools";

export interface TeammateMcpBinding {
  readonly teammateId: string;
  readonly serverId: string;
  readonly mode: TeammateMcpBindingMode;
  readonly selectedToolNames: readonly string[];
  readonly approvalOverrides: Readonly<Record<string, ToolDefaultApproval>>;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateMcpBindingInput {
  readonly serverId: string;
  readonly mode: TeammateMcpBindingMode;
  readonly selectedToolNames?: readonly string[];
  readonly approvalOverrides?: Readonly<Record<string, ToolDefaultApproval>>;
  readonly enabled?: boolean;
}

export interface RunMcpToolAccessSnapshot {
  readonly teammateId?: string;
  readonly servers: readonly RunMcpServerAccessSnapshot[];
  readonly totalToolCount: number;
}

export interface RunMcpServerAccessSnapshot {
  readonly serverId: string;
  readonly displayName: string;
  readonly transportType: McpServerTransportType;
  readonly required: boolean;
  readonly status: McpServerStatus;
  readonly configuredSecretNames: readonly string[];
  readonly missingSecretNames: readonly string[];
  readonly tools: readonly RunMcpToolAccessItem[];
}

export interface RunMcpToolAccessItem {
  readonly rawName: string;
  readonly registeredName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly callableNamespace: string;
  readonly callableName: string;
  readonly sideEffectLevel: ToolSideEffectLevel;
  readonly approval: ToolDefaultApproval;
}

export function createMcpServerId(): string {
  return `mcp_${randomUUID()}`;
}
