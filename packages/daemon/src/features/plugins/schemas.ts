import type { McpServerTransport } from "@ling-stack/core";
import { isRecord, readOptionalObject, readOptionalString, readString } from "../../shared/validation.js";
import { parseMcpServerCreateRequest } from "../mcp/schemas.js";

export function parseManagedPluginCreateRequest(value: unknown): {
  readonly displayName: string;
  readonly description: string;
  readonly transport: McpServerTransport;
} {
  if (!isRecord(value)) {
    throw new Error("Plugin create request body must be an object.");
  }
  const displayName = readString(value, "displayName").trim();
  const description = readString(value, "description").trim();
  if (!displayName || displayName.length > 80) {
    throw new Error("Plugin displayName must contain 1 to 80 characters.");
  }
  if (!description || description.length > 180) {
    throw new Error("Plugin description must contain 1 to 180 characters.");
  }
  const mcpInput = parseMcpServerCreateRequest({
    displayName,
    transport: value.transport,
    enabled: false,
    required: false,
  });
  return { displayName, description, transport: mcpInput.serverInput.transport };
}

export function parseManagedPluginApplyPresetRequest(value: unknown): { readonly options: Readonly<Record<string, unknown>> } {
  if (value === undefined || value === null) {
    return { options: {} };
  }
  if (!isRecord(value)) {
    throw new Error("Plugin preset request body must be an object.");
  }
  return {
    options: readOptionalObject(value, "options") ?? {},
  };
}

export function parseManagedPluginConnectRequest(value: unknown): { readonly command?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Plugin connect request body must be an object.");
  }
  const command = readOptionalString(value, "command")?.trim();
  return command ? { command } : {};
}

export function parseManagedPluginDisableRequest(value: unknown): { readonly reason?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Plugin disable request body must be an object.");
  }
  return {
    reason: readOptionalString(value, "reason"),
  };
}

export function parseManagedPluginValidatePackageRequest(value: unknown): { readonly options: Readonly<Record<string, unknown>> } {
  if (value === undefined || value === null) {
    return { options: {} };
  }
  if (!isRecord(value)) {
    throw new Error("Plugin package validation request body must be an object.");
  }
  return {
    options: readOptionalObject(value, "options") ?? {},
  };
}

export function parseManagedPluginInstallRequest(value: unknown): { readonly options: Readonly<Record<string, unknown>> } {
  if (value === undefined || value === null) {
    return { options: {} };
  }
  if (!isRecord(value)) {
    throw new Error("Plugin install request body must be an object.");
  }
  return {
    options: readOptionalObject(value, "options") ?? {},
  };
}

export function parseManagedPluginUninstallRequest(value: unknown): { readonly reason?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Plugin uninstall request body must be an object.");
  }
  return {
    reason: readOptionalString(value, "reason"),
  };
}
