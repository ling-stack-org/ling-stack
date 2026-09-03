import { readFile } from "node:fs/promises";
import {
  DEFAULT_LING_CONVERSATION_TONE,
  DEFAULT_SKILL_GOVERNANCE_POLICY,
  resolveConfigPaths,
  type SkillGovernancePolicy,
  type RunStorePathsFacet,
  type UpdateWorkspaceSettingsInput,
  type WorkspaceStoreFacet,
  type WorkspaceSettings,
} from "@ling-stack/core";
import type {
  EffectiveConfigDiagnostic,
  EffectiveConfigResponse,
  EffectiveConfigSource,
  EffectiveConfigValue,
} from "@ling-stack/contracts";
import { isSupportedLocale } from "@ling-stack/localization";
import type { RunnerRegistry } from "../../runtime/runners.js";
import {
  loadWorkspaceRuntimeSettingsWithSources,
  normalizeUserRuntimeDefaults,
  type RuntimeSettingsSourceInfo,
  type UserRuntimeDefaults,
} from "../../runtime/runner-settings.js";

interface UserSettingsLayer {
  readonly theme?: "light" | "dark" | "system";
  readonly locale?: WorkspaceSettings["locale"];
  readonly responseLanguage?: WorkspaceSettings["responseLanguage"];
  readonly lingConversationTone?: WorkspaceSettings["lingConversationTone"];
}

interface UserConfigLayer {
  readonly runtimeDefaults?: UserRuntimeDefaults;
}

type EffectiveConfigStore = RunStorePathsFacet & WorkspaceStoreFacet;

export async function buildEffectiveConfigResponse(input: {
  readonly cwd: string;
  readonly store: EffectiveConfigStore;
  readonly runnerRegistry: RunnerRegistry;
}): Promise<EffectiveConfigResponse> {
  const paths = resolveConfigPaths(input.cwd);
  const diagnostics: EffectiveConfigDiagnostic[] = [];
  const [userConfig, userSettings] = await Promise.all([
    readUserConfigLayer(paths.user.configPath, diagnostics, input.runnerRegistry),
    readUserSettingsLayer(paths.user.settingsPath, diagnostics),
  ]);
  const workspaceSettings = input.store.getWorkspaceSettings();
  const runtimeResolution = loadWorkspaceRuntimeSettingsWithSources(input.store, input.runnerRegistry, {
    userConfigPath: paths.user.configPath,
    userRuntimeDefaults: userConfig?.runtimeDefaults,
    diagnostics,
  });
  const runtimeSettings = runtimeResolution.settings;

  return {
    cwd: paths.cwd,
    paths: {
      user: {
        rootDir: paths.user.rootDir,
        configPath: paths.user.configPath,
        settingsPath: paths.user.settingsPath,
        providerProfilesPath: paths.user.providerProfilesPath,
        pluginCacheDir: paths.user.pluginCacheDir,
        globalDatabasePath: paths.user.globalDatabasePath,
        workspacesDir: paths.user.workspacesDir,
        logsDir: paths.user.logsDir,
      },
      workspace: {
        stateLocation: paths.workspace.stateLocation,
        workspaceId: paths.workspace.identity.workspaceId,
        rootDir: paths.workspace.rootDir,
        configPath: paths.workspace.configPath,
        databasePath: paths.workspace.databasePath,
        runtimeSettingsPath: paths.workspace.runtimeSettingsPath,
        sessionsDir: paths.workspace.sessionsDir,
        artifactsDir: paths.workspace.artifactsDir,
        attachmentsDir: paths.workspace.attachmentsDir,
        pluginCacheDir: paths.workspace.pluginCacheDir,
        worktreesDir: paths.workspace.worktreesDir,
        memoryExportsDir: paths.workspace.memoryExportsDir,
        logsDir: paths.workspace.logsDir,
      },
    },
    values: {
      workspaceCwd: effectiveValue(
        workspaceSettings.workspaceCwd,
        "workspace",
        paths.workspace.databasePath,
        "workspaceCwd",
        undefined,
        "user",
        undefined,
        paths.cwd,
      ),
      theme: effectiveValue(
        workspaceSettings.theme,
        "workspace",
        paths.workspace.databasePath,
        "theme",
        userSettings?.theme,
        "user",
        paths.user.settingsPath,
        "system",
      ),
      locale: effectiveValue(
        workspaceSettings.locale,
        "workspace",
        paths.workspace.databasePath,
        "locale",
        userSettings?.locale,
        "user",
        paths.user.settingsPath,
        "zh-CN",
      ),
      responseLanguage: effectiveValue(
        workspaceSettings.responseLanguage,
        "workspace",
        paths.workspace.databasePath,
        "responseLanguage",
        userSettings?.responseLanguage,
        "user",
        paths.user.settingsPath,
        "follow_user",
      ),
      lingConversationTone: effectiveValue(
        workspaceSettings.lingConversationTone,
        "workspace",
        paths.workspace.databasePath,
        "lingConversationTone",
        userSettings?.lingConversationTone,
        "user",
        paths.user.settingsPath,
        DEFAULT_LING_CONVERSATION_TONE,
      ),
      skillGovernancePolicy: effectiveValue(
        workspaceSettings.skillGovernancePolicy,
        "workspace",
        paths.workspace.databasePath,
        "skillGovernancePolicy",
        undefined,
        "user",
        undefined,
        DEFAULT_SKILL_GOVERNANCE_POLICY,
      ),
      runtime: {
        defaultRunnerId: runtimeEffectiveValue(runtimeSettings.defaultRunnerId, runtimeResolution.sources.defaultRunnerId, "runtime.defaultRunnerId"),
        explicitRunnerFallback: runtimeEffectiveValue(runtimeSettings.explicitRunnerFallback, runtimeResolution.sources.explicitRunnerFallback, "runtime.explicitRunnerFallback"),
        implicitRunnerFallback: runtimeEffectiveValue(runtimeSettings.implicitRunnerFallback, runtimeResolution.sources.implicitRunnerFallback, "runtime.implicitRunnerFallback"),
      },
    },
    layers: {
      userConfig: toOptionalRecord(userConfig),
      userSettings: toOptionalRecord(userSettings),
      workspaceSettings,
    },
    diagnostics,
  };
}

export function parseWorkspaceSettingsUpdate(value: unknown): UpdateWorkspaceSettingsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workspace settings update must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  return {
    workspaceCwd: readNullableString(record.workspaceCwd, "workspaceCwd"),
    theme: readNullableTheme(record.theme),
    locale: readNullableLocale(record.locale),
    responseLanguage: readNullableResponseLanguagePreference(record.responseLanguage),
    lingConversationTone: readNullableLingConversationTone(record.lingConversationTone),
    defaultProviderPresetId: readNullableString(record.defaultProviderPresetId, "defaultProviderPresetId"),
    mediaGenerationDefaults: readNullableMediaGenerationDefaults(record.mediaGenerationDefaults),
    defaultAuthorizationMode: readNullableAuthorizationMode(record.defaultAuthorizationMode),
    defaultWorkspaceAccessMode: readNullableWorkspaceAccessMode(record.defaultWorkspaceAccessMode),
    defaultPermissionMode: readNullableSessionPermissionMode(record.defaultPermissionMode),
    defaultPermissionPreset: readNullablePermissionPreset(record.defaultPermissionPreset),
    channelNotifications: readNullableStringRecord(record.channelNotifications, "channelNotifications"),
    channelActivityViews: readNullableUnknownRecord(record.channelActivityViews, "channelActivityViews"),
    skillGovernancePolicy: readNullableSkillGovernancePolicy(record.skillGovernancePolicy),
  };
}

function readNullableMediaGenerationDefaults(
  value: unknown,
): UpdateWorkspaceSettingsInput["mediaGenerationDefaults"] {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mediaGenerationDefaults must be an object or null");
  }
  const record = value as Record<string, unknown>;
  const image = readOptionalMediaGenerationTargetRef(record.image, "mediaGenerationDefaults.image");
  const video = readOptionalMediaGenerationTargetRef(record.video, "mediaGenerationDefaults.video");
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
  };
}

function readOptionalMediaGenerationTargetRef(
  value: unknown,
  path: string,
): NonNullable<UpdateWorkspaceSettingsInput["mediaGenerationDefaults"]>["image"] {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "provider") {
    return { kind: "provider", providerPresetId: readRequiredTargetId(record.providerPresetId, `${path}.providerPresetId`) };
  }
  if (record.kind === "workflow") {
    return { kind: "workflow", workflowDefinitionId: readRequiredTargetId(record.workflowDefinitionId, `${path}.workflowDefinitionId`) };
  }
  throw new Error(`${path}.kind must be provider or workflow`);
}

function readRequiredTargetId(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function effectiveValue<T>(
  workspaceValue: T | undefined,
  workspaceSource: EffectiveConfigSource,
  workspacePath: string | undefined,
  key: string,
  userValue: T | undefined,
  userSource: EffectiveConfigSource,
  userPath: string | undefined,
  builtInValue: T,
): EffectiveConfigValue<T> {
  if (workspaceValue !== undefined) {
    return { value: workspaceValue, source: workspaceSource, path: workspacePath, key };
  }
  if (userValue !== undefined) {
    return { value: userValue, source: userSource, path: userPath, key };
  }
  return { value: builtInValue, source: "built_in", key };
}

function runtimeEffectiveValue<T>(
  value: T,
  source: RuntimeSettingsSourceInfo,
  key: string,
): EffectiveConfigValue<T> {
  return { value, source: source.source, path: source.path, key };
}

async function readUserConfigLayer(
  path: string,
  diagnostics: EffectiveConfigDiagnostic[],
  runnerRegistry: RunnerRegistry,
): Promise<UserConfigLayer | undefined> {
  const record = await readOptionalJsonObject(path, "user_config", diagnostics);
  if (!record) {
    return undefined;
  }
  const runtimeDefaults = normalizeUserRuntimeDefaults(runnerRegistry, record.runtimeDefaults, path, diagnostics);
  return runtimeDefaults ? { runtimeDefaults } : {};
}

async function readUserSettingsLayer(path: string, diagnostics: EffectiveConfigDiagnostic[]): Promise<UserSettingsLayer | undefined> {
  const record = await readOptionalJsonObject(path, "user_settings", diagnostics);
  if (!record) {
    return undefined;
  }
  const result: {
    theme?: "light" | "dark" | "system";
    locale?: WorkspaceSettings["locale"];
    responseLanguage?: WorkspaceSettings["responseLanguage"];
    lingConversationTone?: WorkspaceSettings["lingConversationTone"];
  } = {};
  const theme = readOptionalTheme(record.theme, path, diagnostics);
  if (theme) {
    result.theme = theme;
  }
  const locale = readOptionalLocale(record.locale, path, diagnostics);
  if (locale) {
    result.locale = locale;
  }
  const responseLanguage = readOptionalResponseLanguage(record.responseLanguage, path, diagnostics);
  if (responseLanguage) {
    result.responseLanguage = responseLanguage;
  }
  const lingConversationTone = readOptionalLingConversationTone(record.lingConversationTone, path, diagnostics);
  if (lingConversationTone) {
    result.lingConversationTone = lingConversationTone;
  }
  return Object.keys(result).length > 0 ? result : {};
}

async function readOptionalJsonObject(path: string, code: string, diagnostics: EffectiveConfigDiagnostic[]): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    diagnostics.push({
      level: "warning",
      code: `${code}_unreadable`,
      message: error instanceof Error ? error.message : String(error),
      path,
    });
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      diagnostics.push({
        level: "warning",
        code: `${code}_invalid`,
        message: "Config file must contain a JSON object.",
        path,
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    diagnostics.push({
      level: "warning",
      code: `${code}_invalid_json`,
      message: error instanceof Error ? error.message : String(error),
      path,
    });
    return undefined;
  }
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
  if (value !== "follow_user" && !isSupportedLocale(value)) {
    throw new Error("responseLanguage must be follow_user, a supported locale, or null");
  }
  return value;
}

function readNullableLocale(value: unknown): UpdateWorkspaceSettingsInput["locale"] {
  if (value === undefined || value === null) {
    return value;
  }
  if (!isSupportedLocale(value)) {
    throw new Error("locale must be a supported locale or null");
  }
  return value;
}

function readNullableLingConversationTone(value: unknown): UpdateWorkspaceSettingsInput["lingConversationTone"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value !== "friendly" && value !== "pragmatic" && value !== "none") {
    throw new Error("lingConversationTone must be friendly, pragmatic, none, or null");
  }
  return value;
}

function readNullableAuthorizationMode(value: unknown): UpdateWorkspaceSettingsInput["defaultAuthorizationMode"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value !== "ask" && value !== "smart" && value !== "always") {
    throw new Error("defaultAuthorizationMode must be ask, smart, always, or null");
  }
  return value;
}

function readNullableWorkspaceAccessMode(value: unknown): UpdateWorkspaceSettingsInput["defaultWorkspaceAccessMode"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value !== "read_only" && value !== "workspace_write" && value !== "full_access") {
    throw new Error("defaultWorkspaceAccessMode must be read_only, workspace_write, full_access, or null");
  }
  return value;
}

function readNullableSessionPermissionMode(value: unknown): UpdateWorkspaceSettingsInput["defaultPermissionMode"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value !== "ask_everything" && value !== "balanced" && value !== "workspace_write" && value !== "full_access" && value !== "custom") {
    throw new Error("defaultPermissionMode must be ask_everything, balanced, workspace_write, full_access, custom, or null");
  }
  return value;
}

function readNullablePermissionPreset(value: unknown): UpdateWorkspaceSettingsInput["defaultPermissionPreset"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value !== "read_only" && value !== "workspace_collaboration" && value !== "full_access" && value !== "custom") {
    throw new Error("defaultPermissionPreset must be read_only, workspace_collaboration, full_access, custom, or null");
  }
  return value;
}

function readNullableSkillGovernancePolicy(value: unknown): SkillGovernancePolicy | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("skillGovernancePolicy must be an object or null");
  }
  const generationMode = value.generationMode;
  const recordingMode = value.recordingMode;
  if (generationMode !== "off" && generationMode !== "approval_only" && generationMode !== "semi_auto" && generationMode !== "auto_candidate") {
    throw new Error("skillGovernancePolicy.generationMode must be off, approval_only, semi_auto, or auto_candidate");
  }
  if (recordingMode !== "disabled" && recordingMode !== "user_initiated") {
    throw new Error("skillGovernancePolicy.recordingMode must be disabled or user_initiated");
  }
  if (value.invocationMode !== undefined && value.invocationMode !== "explicit_only") {
    throw new Error("skillGovernancePolicy.invocationMode must be explicit_only");
  }
  if (value.publishMode !== undefined && value.publishMode !== "manual_review") {
    throw new Error("skillGovernancePolicy.publishMode must be manual_review");
  }
  if (value.bindMode !== undefined && value.bindMode !== "manual_review") {
    throw new Error("skillGovernancePolicy.bindMode must be manual_review");
  }
  return {
    generationMode,
    recordingMode,
    invocationMode: "explicit_only",
    publishMode: "manual_review",
    bindMode: "manual_review",
  };
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

function readOptionalTheme(value: unknown, path: string, diagnostics: EffectiveConfigDiagnostic[]): "light" | "dark" | "system" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  diagnostics.push({
    level: "warning",
    code: "user_settings_invalid_theme",
    message: "theme must be light, dark, or system.",
    path,
  });
  return undefined;
}

function readOptionalResponseLanguage(value: unknown, path: string, diagnostics: EffectiveConfigDiagnostic[]): WorkspaceSettings["responseLanguage"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "follow_user" || isSupportedLocale(value)) {
    return value;
  }
  diagnostics.push({
    level: "warning",
    code: "user_settings_invalid_response_language",
    message: "responseLanguage must be follow_user or a supported locale.",
    path,
  });
  return undefined;
}

function readOptionalLocale(value: unknown, path: string, diagnostics: EffectiveConfigDiagnostic[]): WorkspaceSettings["locale"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isSupportedLocale(value)) {
    return value;
  }
  diagnostics.push({
    level: "warning",
    code: "user_settings_invalid_locale",
    message: "locale must be a supported locale.",
    path,
  });
  return undefined;
}

function readOptionalLingConversationTone(value: unknown, path: string, diagnostics: EffectiveConfigDiagnostic[]): WorkspaceSettings["lingConversationTone"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "friendly" || value === "pragmatic" || value === "none") {
    return value;
  }
  diagnostics.push({
    level: "warning",
    code: "user_settings_invalid_ling_conversation_tone",
    message: "lingConversationTone must be friendly, pragmatic, or none.",
    path,
  });
  return undefined;
}

function readOptionalNonEmptyString(
  value: unknown,
  key: string,
  path: string,
  diagnostics: EffectiveConfigDiagnostic[],
  code = "user_config_invalid_string",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  diagnostics.push({
    level: "warning",
    code,
    message: `${key} must be a non-empty string.`,
    path,
  });
  return undefined;
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toOptionalRecord(value: object | undefined): Record<string, unknown> | undefined {
  return value ? { ...value } as Record<string, unknown> : undefined;
}
