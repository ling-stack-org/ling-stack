import type { EffectiveConfigResponse } from "./settings.js";

export type StartupPhase =
  | "process_config"
  | "user_config"
  | "workspace_store"
  | "effective_config"
  | "runtime_policy"
  | "secret_resolver"
  | "provider_warmup"
  | "automation_scheduler"
  | "external_work_scheduler"
  | "plugin_warmup";

export type StartupPhaseStatus =
  | "not_started"
  | "loading"
  | "ready"
  | "warming"
  | "degraded"
  | "failed";

export type StartupWorkspaceState = "starting" | "ready" | "degraded" | "failed";

export interface StartupDiagnostic {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly phase: StartupPhase;
  readonly path?: string;
  readonly nextAction?: string;
  readonly count?: number;
}

export interface WorkspaceStartupStatus {
  readonly startupAttemptId: string;
  readonly cwd: string;
  readonly state: StartupWorkspaceState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly phases: Readonly<Record<StartupPhase, StartupPhaseStatus>>;
  readonly diagnostics: readonly StartupDiagnostic[];
  readonly effectiveConfigLoadedAt?: string;
}

export interface StartupStatusResponse extends WorkspaceStartupStatus {}

export interface StartupRefreshResponse extends WorkspaceStartupStatus {}

export interface EffectiveConfigStartupSnapshot {
  readonly cwd: string;
  readonly loadedAt: string;
  readonly source: "startup" | "manual_refresh";
  readonly response: EffectiveConfigResponse;
}
