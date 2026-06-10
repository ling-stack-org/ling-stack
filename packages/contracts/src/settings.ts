export interface WorkspaceSettings {
  readonly schemaVersion: 1;
  readonly workspaceCwd?: string;
  readonly theme?: "light" | "dark" | "system";
  readonly locale?: string;
  readonly channelNotifications?: Record<string, string>;
  readonly channelActivityViews?: Record<string, unknown>;
  readonly updatedAt: string;
}

export interface UpdateWorkspaceSettingsRequest {
  readonly workspaceCwd?: string | null;
  readonly theme?: "light" | "dark" | "system" | null;
  readonly locale?: string | null;
  readonly channelNotifications?: Record<string, string> | null;
  readonly channelActivityViews?: Record<string, unknown> | null;
}

export interface WorkspaceSettingsResponse {
  readonly cwd: string;
  readonly settings: WorkspaceSettings;
}
