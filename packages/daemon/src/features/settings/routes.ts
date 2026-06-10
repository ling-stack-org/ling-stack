import type { IncomingMessage, ServerResponse } from "node:http";
import type { UpdateWorkspaceSettingsInput } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

export async function handleWorkspaceSettings(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, { cwd, settings: store.getWorkspaceSettings() });
      return;
    }
    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const settings = store.updateWorkspaceSettings(parseWorkspaceSettingsUpdate(body), new Date().toISOString());
      writeJson(response, 200, { cwd, settings });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workspace settings` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseWorkspaceSettingsUpdate(value: unknown): UpdateWorkspaceSettingsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workspace settings update must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  return {
    workspaceCwd: readNullableString(record.workspaceCwd, "workspaceCwd"),
    theme: readNullableTheme(record.theme),
    locale: readNullableString(record.locale, "locale"),
    responseLanguage: readNullableResponseLanguagePreference(record.responseLanguage),
    channelNotifications: readNullableStringRecord(record.channelNotifications, "channelNotifications"),
    channelActivityViews: readNullableUnknownRecord(record.channelActivityViews, "channelActivityViews"),
  };
}

function readNullableString(value: unknown, key: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

function readNullableTheme(value: unknown): UpdateWorkspaceSettingsInput["theme"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value !== "light" && value !== "dark" && value !== "system") {
    throw new Error("theme must be light, dark, system, or null");
  }
  return value;
}

function readNullableResponseLanguagePreference(value: unknown): UpdateWorkspaceSettingsInput["responseLanguage"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value !== "follow_user" && value !== "zh-CN" && value !== "en-US") {
    throw new Error("responseLanguage must be follow_user, zh-CN, en-US, or null");
  }
  return value;
}

function readNullableStringRecord(value: unknown, key: string): Record<string, string> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object or null`);
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue !== "string") {
      throw new Error(`${key}.${entryKey} must be a string`);
    }
    result[entryKey] = entryValue;
  }
  return result;
}

function readNullableUnknownRecord(value: unknown, key: string): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object or null`);
  }
  return value as Record<string, unknown>;
}
