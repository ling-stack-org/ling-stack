import type { SQLOutputValue } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID, type ResponseLanguagePreference, type UpdateWorkspaceSettingsInput, type WorkspaceSettings } from "../../workspace-types.js";
import { nullableUpdate, omitUndefined, parseJsonObject, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteWorkspaceSettingsStore {
  constructor(private readonly context: SqliteStoreContext) {}

  getWorkspaceSettings(): WorkspaceSettings {
    const row = this.context.database
      .prepare("SELECT settings_json, updated_at FROM workspace_settings WHERE workspace_id = ?")
      .get(DEFAULT_WORKSPACE_ID);
    if (!row) {
      return createDefaultWorkspaceSettings(new Date().toISOString());
    }
    return parseWorkspaceSettings(readString(row as Record<string, SQLOutputValue>, "settings_json"), readString(row as Record<string, SQLOutputValue>, "updated_at"));
  }

  updateWorkspaceSettings(input: UpdateWorkspaceSettingsInput, now: string): WorkspaceSettings {
    const current = this.getWorkspaceSettings();
    const next: WorkspaceSettings = omitUndefined({
      schemaVersion: 1 as const,
      workspaceCwd: nullableUpdate(input.workspaceCwd, current.workspaceCwd),
      theme: nullableUpdate(input.theme, current.theme),
      locale: nullableUpdate(input.locale, current.locale),
      responseLanguage: nullableUpdate(input.responseLanguage, current.responseLanguage),
      channelNotifications: nullableUpdate(input.channelNotifications, current.channelNotifications),
      channelActivityViews: nullableUpdate(input.channelActivityViews, current.channelActivityViews),
      updatedAt: now,
    });
    this.context.database
      .prepare(`
        INSERT INTO workspace_settings (workspace_id, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `)
      .run(DEFAULT_WORKSPACE_ID, stringifyJson(next), now, now);
    return this.getWorkspaceSettings();
  }
}

function createDefaultWorkspaceSettings(now: string): WorkspaceSettings {
  return {
    schemaVersion: 1,
    updatedAt: now,
  };
}

function parseOptionalResponseLanguagePreference(value: unknown): ResponseLanguagePreference | undefined {
  return value === "follow_user" || value === "zh-CN" || value === "en-US" ? value : undefined;
}

function parseWorkspaceSettings(value: string, updatedAt: string): WorkspaceSettings {
  const parsed = parseJsonObject(value);
  const parsedTheme: WorkspaceSettings["theme"] =
    parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system" ? parsed.theme : undefined;
  return omitUndefined({
    schemaVersion: 1 as const,
    workspaceCwd: typeof parsed.workspaceCwd === "string" && parsed.workspaceCwd.trim() ? parsed.workspaceCwd : undefined,
    theme: parsedTheme,
    locale: typeof parsed.locale === "string" && parsed.locale.trim() ? parsed.locale : undefined,
    responseLanguage: parseOptionalResponseLanguagePreference(parsed.responseLanguage),
    channelNotifications: parseOptionalStringRecord(parsed.channelNotifications),
    channelActivityViews: parseOptionalUnknownRecord(parsed.channelActivityViews),
    updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : updatedAt,
  });
}

function parseOptionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      result[key] = entryValue;
    }
  }
  return result;
}

function parseOptionalUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
