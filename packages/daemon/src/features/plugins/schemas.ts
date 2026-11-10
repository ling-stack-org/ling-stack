import type { McpServerTransport } from "@ling-stack/core";
import { isRecord, readOptionalObject, readOptionalString, readString } from "../../shared/validation.js";
import { parseMcpServerCreateRequest } from "../mcp/schemas.js";
import { pluginImportSources, type PluginImportSource } from "./import/sources.js";

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

export function parsePluginImportPreviewRequest(value: unknown): { readonly source: PluginImportSource } {
  if (!isRecord(value)) {
    throw new Error("Plugin import preview request body must be an object.");
  }
  const source = readString(value, "source");
  if (!(pluginImportSources as readonly string[]).includes(source)) {
    throw new Error(`Plugin import source must be one of: ${pluginImportSources.join(", ")}`);
  }
  return { source: source as PluginImportSource };
}

export function parsePluginImportApplyRequest(value: unknown): {
  readonly source: PluginImportSource;
  readonly names: readonly string[];
} {
  if (!isRecord(value)) {
    throw new Error("Plugin import apply request body must be an object.");
  }
  const source = readString(value, "source");
  if (!(pluginImportSources as readonly string[]).includes(source)) {
    throw new Error(`Plugin import source must be one of: ${pluginImportSources.join(", ")}`);
  }
  const rawNames = value.names;
  if (!Array.isArray(rawNames) || rawNames.length === 0 || rawNames.some((name) => typeof name !== "string" || name.trim().length === 0)) {
    throw new Error("Plugin import apply request must select at least one candidate name.");
  }
  if (rawNames.length > 200) {
    throw new Error("Plugin import apply request must select at most 200 candidates.");
  }
  return {
    source: source as PluginImportSource,
    names: rawNames.map((name) => (name as string).trim()),
  };
}
