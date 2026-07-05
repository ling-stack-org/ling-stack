import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_SKILL_GOVERNANCE_POLICY,
  DEFAULT_WORKSPACE_ID,
  type LingConversationTone,
  type ResponseLanguagePreference,
  type SkillGovernancePolicy,
  type UpdateWorkspaceSettingsInput,
  type WorkspaceSettings,
} from "../../workspace-types.js";
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
      lingConversationTone: nullableUpdate(input.lingConversationTone, current.lingConversationTone),
      defaultProviderPresetId: nullableUpdate(input.defaultProviderPresetId, current.defaultProviderPresetId),
      defaultPermissionMode: nullableUpdate(input.defaultPermissionMode, current.defaultPermissionMode),
      defaultPermissionPreset: nullableUpdate(input.defaultPermissionPreset, current.defaultPermissionPreset),
      channelNotifications: nullableUpdate(input.channelNotifications, current.channelNotifications),
      channelActivityViews: nullableUpdate(input.channelActivityViews, current.channelActivityViews),
      skillGovernancePolicy: input.skillGovernancePolicy === undefined
        ? current.skillGovernancePolicy
        : input.skillGovernancePolicy ?? DEFAULT_SKILL_GOVERNANCE_POLICY,
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
    defaultPermissionMode: "workspace_write",
    defaultPermissionPreset: "workspace_collaboration",
    skillGovernancePolicy: DEFAULT_SKILL_GOVERNANCE_POLICY,
    updatedAt: now,
  };
}

function parseOptionalResponseLanguagePreference(value: unknown): ResponseLanguagePreference | undefined {
  return value === "follow_user" || value === "zh-CN" || value === "en-US" ? value : undefined;
}

function parseOptionalLingConversationTone(value: unknown): LingConversationTone | undefined {
  return value === "friendly" || value === "pragmatic" || value === "none" ? value : undefined;
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
    lingConversationTone: parseOptionalLingConversationTone(parsed.lingConversationTone),
    defaultProviderPresetId: typeof parsed.defaultProviderPresetId === "string" && parsed.defaultProviderPresetId.trim() ? parsed.defaultProviderPresetId : undefined,
    defaultPermissionMode: parseOptionalSessionPermissionMode(parsed.defaultPermissionMode) ?? "workspace_write",
    defaultPermissionPreset: parseOptionalPermissionPreset(parsed.defaultPermissionPreset) ?? "workspace_collaboration",
    channelNotifications: parseOptionalStringRecord(parsed.channelNotifications),
    channelActivityViews: parseOptionalUnknownRecord(parsed.channelActivityViews),
    skillGovernancePolicy: parseSkillGovernancePolicy(parsed.skillGovernancePolicy) ?? DEFAULT_SKILL_GOVERNANCE_POLICY,
    updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : updatedAt,
  });
}

function parseOptionalSessionPermissionMode(value: unknown): WorkspaceSettings["defaultPermissionMode"] | undefined {
  return value === "ask_everything" || value === "balanced" || value === "workspace_write" || value === "full_access" || value === "custom"
    ? value
    : undefined;
}

function parseOptionalPermissionPreset(value: unknown): WorkspaceSettings["defaultPermissionPreset"] | undefined {
  return value === "read_only" || value === "workspace_collaboration" || value === "full_access" || value === "custom"
    ? value
    : undefined;
}

function parseSkillGovernancePolicy(value: unknown): SkillGovernancePolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const generationMode = record.generationMode;
  const recordingMode = record.recordingMode;
  return {
    generationMode: generationMode === "off" || generationMode === "approval_only" || generationMode === "semi_auto" || generationMode === "auto_candidate"
      ? generationMode
      : DEFAULT_SKILL_GOVERNANCE_POLICY.generationMode,
    recordingMode: recordingMode === "disabled" || recordingMode === "user_initiated"
      ? recordingMode
      : DEFAULT_SKILL_GOVERNANCE_POLICY.recordingMode,
    invocationMode: "explicit_only",
    publishMode: "manual_review",
    bindMode: "manual_review",
  };
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
