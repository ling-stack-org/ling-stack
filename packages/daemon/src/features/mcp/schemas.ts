import type { CreateMcpServerInput, McpServerStatus, McpServerTransport, McpStreamableHttpTransport } from "@ling-stack/core";
import { isRecord, readNullableNumber, readNullableStringArray, readOptionalBoolean, readOptionalNumber, readOptionalString, readOptionalStringArray, readOptionalStringRecord, readString, readStringAllowEmpty, removeUndefined, validateUrl } from "../../shared/validation.js";

interface McpServerCreateRequest {
  readonly serverInput: CreateMcpServerInput;
  readonly secrets: Readonly<Record<string, string>>;
}

interface McpServerUpdateRequest {
  readonly serverInput: {
    readonly displayName?: string;
    readonly transport?: McpServerTransport;
    readonly enabled?: boolean;
    readonly required?: boolean;
    readonly status?: McpServerStatus;
    readonly startupTimeoutSec?: number | null;
    readonly toolTimeoutSec?: number | null;
    readonly enabledTools?: readonly string[] | null;
    readonly disabledTools?: readonly string[];
  };
  readonly secrets: Readonly<Record<string, string>>;
  readonly clearSecretNames: readonly string[];
}

export function parseMcpServerCreateRequest(value: unknown): McpServerCreateRequest {
  if (!isRecord(value)) {
    throw new Error("MCP server request must be a JSON object");
  }
  return {
    serverInput: {
      id: readOptionalString(value, "id"),
      displayName: readString(value, "displayName"),
      transport: readMcpServerTransport(value, "transport"),
      enabled: readOptionalBoolean(value, "enabled"),
      required: readOptionalBoolean(value, "required"),
      status: readOptionalMcpServerStatus(value, "status"),
      startupTimeoutSec: readOptionalNumber(value, "startupTimeoutSec"),
      toolTimeoutSec: readOptionalNumber(value, "toolTimeoutSec"),
      enabledTools: readOptionalStringArray(value, "enabledTools"),
      disabledTools: readOptionalStringArray(value, "disabledTools"),
    },
    secrets: readOptionalStringRecord(value, "secrets") ?? {},
  };
}

export function parseMcpServerUpdateRequest(value: unknown): McpServerUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("MCP server update must be a JSON object");
  }
  return {
    serverInput: {
      displayName: readOptionalString(value, "displayName"),
      transport: value.transport === undefined ? undefined : readMcpServerTransport(value, "transport"),
      enabled: readOptionalBoolean(value, "enabled"),
      required: readOptionalBoolean(value, "required"),
      status: readOptionalMcpServerStatus(value, "status"),
      startupTimeoutSec: readNullableNumber(value, "startupTimeoutSec"),
      toolTimeoutSec: readNullableNumber(value, "toolTimeoutSec"),
      enabledTools: readNullableStringArray(value, "enabledTools"),
      disabledTools: readOptionalStringArray(value, "disabledTools"),
    },
    secrets: readOptionalStringRecord(value, "secrets") ?? {},
    clearSecretNames: readOptionalStringArray(value, "clearSecretNames") ?? [],
  };
}

function readMcpServerTransport(record: Record<string, unknown>, key: string): McpServerTransport {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const type = readString(value, "type");
  if (type === "stdio") {
    return {
      type,
      command: readString(value, "command"),
      args: readOptionalStringArray(value, "args") ?? [],
      env: readOptionalStringRecord(value, "env") ?? {},
      cwd: readOptionalString(value, "cwd"),
      secretEnvNames: readOptionalStringArray(value, "secretEnvNames") ?? [],
    };
  }
  if (type === "streamable-http") {
    const url = readString(value, "url");
    validateUrl(url, `${key}.url`);
    return {
      type,
      url,
      bearerTokenEnvVar: readOptionalString(value, "bearerTokenEnvVar"),
      headers: readOptionalStringRecord(value, "headers") ?? {},
      envHeaders: readOptionalStringRecord(value, "envHeaders") ?? {},
      secretHeaderNames: readOptionalStringArray(value, "secretHeaderNames") ?? [],
      oauthClientId: readOptionalString(value, "oauthClientId"),
      oauthResource: readOptionalString(value, "oauthResource"),
    };
  }
  throw new Error(`${key}.type must be stdio or streamable-http`);
}

function readOptionalMcpServerStatus(record: Record<string, unknown>, key: string): McpServerStatus | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const kind = readString(value, "kind");
  if (kind !== "unknown" && kind !== "checking" && kind !== "ready" && kind !== "failed" && kind !== "disabled") {
    throw new Error(`${key}.kind must be unknown, checking, ready, failed, or disabled`);
  }
  return removeUndefined({
    kind,
    message: readOptionalString(value, "message"),
    checkedAt: readOptionalString(value, "checkedAt"),
  }) as McpServerStatus;
}
