import type { SQLOutputValue } from "node:sqlite";
import {
  type McpRuntimeStatusSnapshot,
  type McpServer,
  type McpServerStatus,
  type McpServerTransport,
  type McpTool,
  type TeammateMcpBinding,
} from "../../mcp-types.js";
import { parseSecretRef } from "../../secrets.js";
import {
  isRecord,
  omitUndefined,
  parseJson,
  parseJsonObject,
  parseJsonStringArray,
  parseNullableJsonStringArray,
  readBoolean,
  readNullableNumber,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapMcpServer(row: Record<string, SQLOutputValue>): McpServer {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    displayName: readString(row, "display_name"),
    transport: parseMcpServerTransport(readString(row, "transport_json")),
    enabled: readBoolean(row, "enabled"),
    required: readBoolean(row, "required"),
    status: parseMcpServerStatus(readString(row, "status_json")),
    startupTimeoutSec: readNullableNumber(row, "startup_timeout_sec"),
    toolTimeoutSec: readNullableNumber(row, "tool_timeout_sec"),
    enabledTools: parseNullableJsonStringArray(readNullableString(row, "enabled_tools_json")),
    disabledTools: parseJsonStringArray(readString(row, "disabled_tools_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapMcpTool(row: Record<string, SQLOutputValue>): McpTool {
  return omitUndefined({
    serverId: readString(row, "server_id"),
    rawName: readString(row, "raw_name"),
    displayName: readString(row, "display_name"),
    description: readNullableString(row, "description"),
    inputSchema: parseJson(readString(row, "input_schema_json")),
    callableNamespace: readString(row, "callable_namespace"),
    callableName: readString(row, "callable_name"),
    sideEffectLevel: readString(row, "side_effect_level") as McpTool["sideEffectLevel"],
    defaultApproval: readString(row, "default_approval") as McpTool["defaultApproval"],
    enabled: readBoolean(row, "enabled"),
    firstSeenAt: readString(row, "first_seen_at"),
    lastSeenAt: readString(row, "last_seen_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapTeammateMcpBinding(row: Record<string, SQLOutputValue>): TeammateMcpBinding {
  return {
    teammateId: readString(row, "teammate_id"),
    serverId: readString(row, "server_id"),
    mode: readString(row, "mode") as TeammateMcpBinding["mode"],
    selectedToolNames: parseJsonStringArray(readString(row, "selected_tool_names_json")),
    approvalOverrides: parseMcpApprovalOverrides(readString(row, "approval_overrides_json")),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function parseMcpRuntimeStatusSnapshot(value: string): McpRuntimeStatusSnapshot {
  const parsed = parseJsonObject(value);
  const status = parsed.status;
  if (
    status !== "unknown" &&
    status !== "ready" &&
    status !== "failed" &&
    status !== "disabled" &&
    status !== "expired" &&
    status !== "migration_required"
  ) {
    throw new Error("Expected MCP runtime status snapshot kind from SQLite");
  }
  if (typeof parsed.serverId !== "string") {
    throw new Error("Expected MCP runtime status snapshot serverId from SQLite");
  }
  if (typeof parsed.checkedAt !== "string") {
    throw new Error("Expected MCP runtime status snapshot checkedAt from SQLite");
  }
  if (typeof parsed.expiresAt !== "string") {
    throw new Error("Expected MCP runtime status snapshot expiresAt from SQLite");
  }
  const authStatus = isRecord(parsed.authStatus) ? parsed.authStatus : undefined;
  if (!authStatus) {
    throw new Error("Expected MCP runtime status snapshot authStatus from SQLite");
  }
  const authKind = authStatus.kind;
  if (
    authKind !== "not_required" &&
    authKind !== "configured" &&
    authKind !== "missing" &&
    authKind !== "access_denied" &&
    authKind !== "store_unavailable" &&
    authKind !== "invalid_ref" &&
    authKind !== "migration_required"
  ) {
    throw new Error("Expected MCP runtime status auth kind from SQLite");
  }
  const serverInfo = parsed.serverInfo === undefined ? undefined : parseMcpServerInfo(parsed.serverInfo);
  return omitUndefined({
    serverId: parsed.serverId,
    checkedAt: parsed.checkedAt,
    expiresAt: parsed.expiresAt,
    status,
    serverInfo,
    protocolVersion: typeof parsed.protocolVersion === "string" ? parsed.protocolVersion : undefined,
    toolCount: typeof parsed.toolCount === "number" ? parsed.toolCount : undefined,
    missingSecretRefs: parseUnknownStringArray(parsed.missingSecretRefs, "MCP runtime missingSecretRefs"),
    authStatus: omitUndefined({
      kind: authKind,
      refs: parseUnknownStringArray(authStatus.refs, "MCP runtime auth refs"),
      missingRefs: parseUnknownStringArray(authStatus.missingRefs, "MCP runtime auth missingRefs"),
      message: typeof authStatus.message === "string" ? authStatus.message : undefined,
    }),
    latencyMs: typeof parsed.latencyMs === "number" ? parsed.latencyMs : undefined,
    errorCode: typeof parsed.errorCode === "string" ? parsed.errorCode : undefined,
    message: typeof parsed.message === "string" ? parsed.message : undefined,
  }) as McpRuntimeStatusSnapshot;
}

export function normalizeMcpServerTransport(transport: McpServerTransport): McpServerTransport {
  if (transport.type === "stdio") {
    if (typeof transport.command !== "string" || transport.command.length === 0) {
      throw new Error("Expected MCP stdio command");
    }
    const secretEnvRefs = { ...(transport.secretEnvRefs ?? {}) };
    validateMcpSecretRefRecord(secretEnvRefs, "MCP stdio secretEnvRefs");
    for (const envName of Object.keys(secretEnvRefs)) {
      if (transport.env?.[envName] !== undefined) {
        throw new Error(`MCP stdio env ${envName} cannot be both static and secret-backed`);
      }
    }
    const normalized = omitUndefined({
      type: "stdio",
      command: transport.command,
      args: [...(transport.args ?? [])],
      env: { ...(transport.env ?? {}) },
      cwd: transport.cwd,
      secretEnvRefs,
      secretEnvNames: transport.secretEnvNames ? [...transport.secretEnvNames] : undefined,
    });
    return normalized as McpServerTransport;
  }
  if (transport.type === "streamable-http") {
    if (typeof transport.url !== "string" || transport.url.length === 0) {
      throw new Error("Expected MCP streamable HTTP URL");
    }
    const secretHeaderRefs = { ...(transport.secretHeaderRefs ?? {}) };
    validateMcpSecretRefRecord(secretHeaderRefs, "MCP HTTP secretHeaderRefs");
    for (const headerName of Object.keys(secretHeaderRefs)) {
      if (transport.headers?.[headerName] !== undefined) {
        throw new Error(`MCP HTTP header ${headerName} cannot be both static and secret-backed`);
      }
    }
    if (transport.bearerTokenRef !== undefined) {
      parseSecretRef(transport.bearerTokenRef);
    }
    const normalized = omitUndefined({
      type: "streamable-http",
      url: transport.url,
      headers: { ...(transport.headers ?? {}) },
      secretHeaderRefs,
      bearerTokenRef: transport.bearerTokenRef,
      bearerTokenEnvVar: transport.bearerTokenEnvVar,
      envHeaders: transport.envHeaders ? { ...transport.envHeaders } : undefined,
      secretHeaderNames: transport.secretHeaderNames ? [...transport.secretHeaderNames] : undefined,
      oauthClientId: transport.oauthClientId,
      oauthResource: transport.oauthResource,
    });
    return normalized as McpServerTransport;
  }
  throw new Error("Expected MCP server transport from SQLite");
}

function parseMcpServerTransport(value: string): McpServerTransport {
  return normalizeMcpServerTransport(parseJson(value) as McpServerTransport);
}

function validateMcpSecretRefRecord(refs: Readonly<Record<string, string>>, label: string): void {
  for (const [name, ref] of Object.entries(refs)) {
    if (!name.trim()) {
      throw new Error(`${label} keys must be non-empty`);
    }
    parseSecretRef(ref);
  }
}

function parseMcpServerStatus(value: string): McpServerStatus {
  const parsed = parseJsonObject(value);
  if (
    parsed.kind !== "unknown" &&
    parsed.kind !== "checking" &&
    parsed.kind !== "ready" &&
    parsed.kind !== "failed" &&
    parsed.kind !== "disabled"
  ) {
    throw new Error("Expected MCP server status kind from SQLite");
  }
  if (parsed.message !== undefined && typeof parsed.message !== "string") {
    throw new Error("Expected MCP server status message from SQLite");
  }
  if (parsed.checkedAt !== undefined && typeof parsed.checkedAt !== "string") {
    throw new Error("Expected MCP server status checkedAt from SQLite");
  }
  return omitUndefined({
    kind: parsed.kind,
    message: parsed.message,
    checkedAt: parsed.checkedAt,
  }) as McpServerStatus;
}

function parseMcpServerInfo(value: unknown): McpRuntimeStatusSnapshot["serverInfo"] {
  if (!isRecord(value)) {
    throw new Error("Expected MCP runtime serverInfo object from SQLite");
  }
  return omitUndefined({
    name: typeof value.name === "string" ? value.name : undefined,
    version: typeof value.version === "string" ? value.version : undefined,
  });
}

function parseUnknownStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected ${label} to be a string array`);
  }
  return value as string[];
}

function parseMcpApprovalOverrides(value: string): TeammateMcpBinding["approvalOverrides"] {
  const parsed = parseJsonObject(value);
  const result: Record<string, McpTool["defaultApproval"]> = {};
  for (const [toolName, decision] of Object.entries(parsed)) {
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      throw new Error("Expected MCP approval override decision from SQLite");
    }
    result[toolName] = decision;
  }
  return result;
}
