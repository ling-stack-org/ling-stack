import type { CreateMcpServerInput, McpServerTransport } from "@ling-stack/core";
import { isRecord, readNullableNumber, readNullableStringArray, readOptionalBoolean, readOptionalNumber, readOptionalString, readOptionalStringArray, readOptionalStringRecord, readString, validateUrl } from "../../shared/validation.js";

interface McpServerCreateRequest {
  readonly serverInput: CreateMcpServerInput;
}

interface McpServerUpdateRequest {
  readonly serverInput: {
    readonly displayName?: string;
    readonly transport?: McpServerTransport;
    readonly enabled?: boolean;
    readonly required?: boolean;
    readonly startupTimeoutSec?: number | null;
    readonly toolTimeoutSec?: number | null;
    readonly enabledTools?: readonly string[] | null;
    readonly disabledTools?: readonly string[];
  };
}

export function parseMcpServerCreateRequest(value: unknown): McpServerCreateRequest {
  if (!isRecord(value)) {
    throw new Error("MCP server request must be a JSON object");
  }
  rejectRemovedMcpSecretFields(value);
  return {
    serverInput: {
      id: readOptionalString(value, "id"),
      displayName: readString(value, "displayName"),
      transport: readMcpServerTransport(value, "transport"),
      enabled: readOptionalBoolean(value, "enabled"),
      required: readOptionalBoolean(value, "required"),
      startupTimeoutSec: readOptionalNumber(value, "startupTimeoutSec"),
      toolTimeoutSec: readOptionalNumber(value, "toolTimeoutSec"),
      enabledTools: readOptionalStringArray(value, "enabledTools"),
      disabledTools: readOptionalStringArray(value, "disabledTools"),
    },
  };
}

export function parseMcpServerUpdateRequest(value: unknown): McpServerUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("MCP server update must be a JSON object");
  }
  rejectRemovedMcpSecretFields(value);
  return {
    serverInput: {
      displayName: readOptionalString(value, "displayName"),
      transport: value.transport === undefined ? undefined : readMcpServerTransport(value, "transport"),
      enabled: readOptionalBoolean(value, "enabled"),
      required: readOptionalBoolean(value, "required"),
      startupTimeoutSec: readNullableNumber(value, "startupTimeoutSec"),
      toolTimeoutSec: readNullableNumber(value, "toolTimeoutSec"),
      enabledTools: readNullableStringArray(value, "enabledTools"),
      disabledTools: readOptionalStringArray(value, "disabledTools"),
    },
  };
}

function readMcpServerTransport(record: Record<string, unknown>, key: string): McpServerTransport {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const type = readString(value, "type");
  if (type === "stdio") {
    rejectLegacyTransportSecretFields(value, ["secretEnvNames"]);
    return {
      type,
      command: readString(value, "command"),
      args: readOptionalStringArray(value, "args") ?? [],
      env: readOptionalStringRecord(value, "env") ?? {},
      cwd: readOptionalString(value, "cwd"),
      secretEnvRefs: readOptionalStringRecord(value, "secretEnvRefs") ?? {},
    };
  }
  if (type === "streamable-http") {
    rejectLegacyTransportSecretFields(value, ["bearerTokenEnvVar", "envHeaders", "secretHeaderNames"]);
    const url = readString(value, "url");
    validateUrl(url, `${key}.url`);
    return {
      type,
      url,
      headers: readOptionalStringRecord(value, "headers") ?? {},
      secretHeaderRefs: readOptionalStringRecord(value, "secretHeaderRefs") ?? {},
      bearerTokenRef: readOptionalString(value, "bearerTokenRef"),
      oauthClientId: readOptionalString(value, "oauthClientId"),
      oauthResource: readOptionalString(value, "oauthResource"),
    };
  }
  throw new Error(`${key}.type must be stdio or streamable-http`);
}

function rejectRemovedMcpSecretFields(record: Record<string, unknown>): void {
  for (const key of ["secrets", "clearSecretNames", "status"]) {
    if (record[key] !== undefined) {
      throw new Error("MCP server secrets and status must use secret refs and status snapshots; raw values and persisted status are not accepted.");
    }
  }
}

function rejectLegacyTransportSecretFields(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (record[key] !== undefined) {
      throw new Error(`transport.${key} is legacy-only; use secret refs instead.`);
    }
  }
}
