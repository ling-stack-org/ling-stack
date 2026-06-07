import type { SecretStatus } from "./shared.js";

export type McpServerTransportType = "stdio" | "streamable-http";

export interface McpStdioTransport {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd?: string;
  readonly secretEnvRefs: Record<string, string>;
  readonly secretEnvNames?: readonly string[];
}

export interface McpStreamableHttpTransport {
  readonly type: "streamable-http";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly secretHeaderRefs: Record<string, string>;
  readonly bearerTokenRef?: string;
  readonly bearerTokenEnvVar?: string;
  readonly envHeaders?: Record<string, string>;
  readonly secretHeaderNames?: readonly string[];
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

export type McpRuntimeStatusKind = "unknown" | "ready" | "failed" | "disabled" | "expired" | "migration_required";

export type McpAuthStatusKind =
  | "not_required"
  | "configured"
  | "missing"
  | "access_denied"
  | "store_unavailable"
  | "invalid_ref"
  | "migration_required";

export interface McpAuthStatus {
  readonly kind: McpAuthStatusKind;
  readonly refs: readonly string[];
  readonly missingRefs: readonly string[];
  readonly message?: string;
}

export interface McpRuntimeStatusSnapshot {
  readonly serverId: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly status: McpRuntimeStatusKind;
  readonly serverInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly protocolVersion?: string;
  readonly toolCount?: number;
  readonly missingSecretRefs: readonly string[];
  readonly authStatus: McpAuthStatus;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly message?: string;
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
  readonly secretConfigured: Readonly<Record<string, boolean>>;
  readonly secretStatuses: readonly SecretStatus[];
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly legacySecretMigrationRequired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type McpToolSideEffectLevel = "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";

export type McpToolDefaultApproval = "allow" | "ask" | "deny";

export interface McpTool {
  readonly serverId: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly callableNamespace: string;
  readonly callableName: string;
  readonly sideEffectLevel: McpToolSideEffectLevel;
  readonly defaultApproval: McpToolDefaultApproval;
  readonly enabled: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly updatedAt: string;
}

export interface McpServerListResponse {
  readonly cwd: string;
  readonly servers: readonly McpServer[];
}

export interface McpServerMutationRequest {
  readonly id?: string;
  readonly displayName?: string;
  readonly transport?: McpServerTransport;
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly startupTimeoutSec?: number | null;
  readonly toolTimeoutSec?: number | null;
  readonly enabledTools?: readonly string[] | null;
  readonly disabledTools?: readonly string[];
}

export interface McpServerMutationResponse {
  readonly server: McpServer;
}

export interface McpServerCheckResponse {
  readonly server: McpServer;
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
}

export interface McpServerStatusResponse {
  readonly server: McpServer;
  readonly statusSnapshot: McpRuntimeStatusSnapshot | null;
}

export interface McpToolListResponse {
  readonly cwd: string;
  readonly tools: readonly McpTool[];
}

export interface McpServerToolSyncResponse {
  readonly server: McpServer;
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
}
