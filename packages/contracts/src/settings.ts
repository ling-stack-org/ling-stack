import type { PermissionPreset, SessionPermissionMode } from "./shared.js";

export type ResponseLanguage = "zh-CN" | "en-US";

export type ResponseLanguagePreference = "follow_user" | ResponseLanguage;

export type LingConversationTone = "friendly" | "pragmatic" | "none";

export type SkillGovernanceGenerationMode = "off" | "approval_only" | "semi_auto" | "auto_candidate";

export type SkillGovernanceRecordingMode = "disabled" | "user_initiated";

export interface SkillGovernancePolicy {
  readonly generationMode: SkillGovernanceGenerationMode;
  readonly recordingMode: SkillGovernanceRecordingMode;
  readonly invocationMode: "explicit_only";
  readonly publishMode: "manual_review";
  readonly bindMode: "manual_review";
}

export interface WorkspaceSettings {
  readonly schemaVersion: 1;
  readonly workspaceCwd?: string;
  readonly theme?: "light" | "dark" | "system";
  readonly locale?: string;
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly lingConversationTone?: LingConversationTone;
  readonly defaultProviderPresetId?: string;
  readonly defaultPermissionMode?: SessionPermissionMode;
  readonly defaultPermissionPreset?: PermissionPreset;
  readonly channelNotifications?: Record<string, string>;
  readonly channelActivityViews?: Record<string, unknown>;
  readonly skillGovernancePolicy: SkillGovernancePolicy;
  readonly updatedAt: string;
}

export interface UpdateWorkspaceSettingsRequest {
  readonly workspaceCwd?: string | null;
  readonly theme?: "light" | "dark" | "system" | null;
  readonly locale?: string | null;
  readonly responseLanguage?: ResponseLanguagePreference | null;
  readonly lingConversationTone?: LingConversationTone | null;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultPermissionMode?: SessionPermissionMode | null;
  readonly defaultPermissionPreset?: PermissionPreset | null;
  readonly channelNotifications?: Record<string, string> | null;
  readonly channelActivityViews?: Record<string, unknown> | null;
  readonly skillGovernancePolicy?: SkillGovernancePolicy | null;
}

export interface WorkspaceSettingsResponse {
  readonly cwd: string;
  readonly settings: WorkspaceSettings;
}

export type EffectiveConfigSource = "workspace" | "user" | "built_in";

export interface EffectiveConfigValue<T> {
  readonly value: T;
  readonly source: EffectiveConfigSource;
  readonly path?: string;
  readonly key: string;
}

export interface EffectiveConfigDiagnostic {
  readonly level: "warning";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface EffectiveConfigPaths {
  readonly user: {
    readonly rootDir: string;
    readonly configPath: string;
    readonly settingsPath: string;
    readonly providerProfilesPath: string;
    readonly pluginCacheDir: string;
    readonly globalDatabasePath?: string;
    readonly workspacesDir?: string;
    readonly logsDir: string;
  };
  readonly workspace: {
    readonly stateLocation?: "repo-local" | "user-data-dir";
    readonly workspaceId?: string;
    readonly rootDir: string;
    readonly configPath: string;
    readonly databasePath: string;
    readonly runtimeSettingsPath: string;
    readonly sessionsDir: string;
    readonly artifactsDir: string;
    readonly attachmentsDir: string;
    readonly pluginCacheDir: string;
    readonly worktreesDir?: string;
    readonly memoryExportsDir?: string;
    readonly logsDir: string;
  };
}

export interface EffectiveConfigResponse {
  readonly cwd: string;
  readonly paths: EffectiveConfigPaths;
  readonly values: {
    readonly workspaceCwd: EffectiveConfigValue<string>;
    readonly theme: EffectiveConfigValue<"light" | "dark" | "system">;
    readonly locale: EffectiveConfigValue<string>;
    readonly responseLanguage: EffectiveConfigValue<ResponseLanguagePreference>;
    readonly lingConversationTone: EffectiveConfigValue<LingConversationTone>;
    readonly skillGovernancePolicy: EffectiveConfigValue<SkillGovernancePolicy>;
    readonly runtime: {
      readonly defaultRunnerId: EffectiveConfigValue<string>;
      readonly explicitRunnerFallback: EffectiveConfigValue<"disabled" | "allow_to_default">;
      readonly implicitRunnerFallback: EffectiveConfigValue<"disabled" | "allow_to_default">;
    };
  };
  readonly layers: {
    readonly userConfig?: Record<string, unknown>;
    readonly userSettings?: Record<string, unknown>;
    readonly workspaceSettings: WorkspaceSettings;
  };
  readonly diagnostics: readonly EffectiveConfigDiagnostic[];
}
