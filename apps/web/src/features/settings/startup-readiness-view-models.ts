import type {
  StartupDiagnostic,
  StartupPhase,
  StartupPhaseStatus,
  StartupStatusResponse,
} from "../../types.js";

export type SettingsStatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface StartupStatusViewModel {
  readonly labelKey: string;
  readonly tone: SettingsStatusTone;
  readonly stale: boolean;
}

export interface StartupIssueViewModel {
  readonly key: string;
  readonly message: string;
  readonly nextAction?: string;
  readonly tone: "warning" | "danger";
}

export interface StartupPhaseDefinition {
  readonly id: StartupPhase;
  readonly labelKey: string;
  readonly kindLabelKey: "Required" | "Warmup";
}

export interface StartupPhaseViewModel extends StartupPhaseDefinition {
  readonly status: StartupPhaseStatus;
  readonly statusLabelKey: string;
  readonly tone: SettingsStatusTone;
}

export const startupPhaseDefinitions: readonly StartupPhaseDefinition[] = [
  { id: "process_config", labelKey: "Process configuration", kindLabelKey: "Required" },
  { id: "user_config", labelKey: "User configuration", kindLabelKey: "Required" },
  { id: "workspace_store", labelKey: "Workspace storage", kindLabelKey: "Required" },
  { id: "effective_config", labelKey: "Effective configuration", kindLabelKey: "Required" },
  { id: "runtime_policy", labelKey: "Runtime policy", kindLabelKey: "Required" },
  { id: "secret_resolver", labelKey: "Secret resolver", kindLabelKey: "Required" },
  { id: "provider_warmup", labelKey: "Provider warmup", kindLabelKey: "Warmup" },
  { id: "automation_scheduler", labelKey: "Automation scheduler", kindLabelKey: "Warmup" },
  { id: "external_work_scheduler", labelKey: "External work scheduler", kindLabelKey: "Warmup" },
  { id: "plugin_warmup", labelKey: "Plugin warmup", kindLabelKey: "Warmup" },
];

export function projectStartupStatus(
  status: StartupStatusResponse | undefined,
  loading: boolean,
  errorMessage: string,
): StartupStatusViewModel {
  if (!status) {
    return {
      labelKey: loading ? "Loading startup status" : "Status unavailable",
      tone: "neutral",
      stale: false,
    };
  }

  const presentation = status.state === "ready"
    ? { labelKey: "Ready", tone: "success" as const }
    : status.state === "degraded"
      ? { labelKey: "Degraded", tone: "warning" as const }
      : status.state === "failed"
        ? { labelKey: "Failed", tone: "danger" as const }
        : { labelKey: "Starting", tone: "info" as const };

  return { ...presentation, stale: Boolean(errorMessage) };
}

export function projectStartupIssues(status: StartupStatusResponse | undefined): readonly StartupIssueViewModel[] {
  return (status?.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.level === "warning" || diagnostic.level === "error")
    .map((diagnostic) => ({
      key: diagnosticKey(diagnostic),
      message: diagnostic.message,
      nextAction: diagnostic.nextAction,
      tone: diagnostic.level === "error" ? "danger" : "warning",
    }));
}

export function projectStartupPhases(status: StartupStatusResponse): readonly StartupPhaseViewModel[] {
  return startupPhaseDefinitions.map((definition) => {
    const phaseStatus = status.phases[definition.id] ?? "not_started";
    return {
      ...definition,
      status: phaseStatus,
      statusLabelKey: startupPhaseStatusLabelKey(phaseStatus),
      tone: startupPhaseTone(phaseStatus),
    };
  });
}

export function startupTechnicalSummary(status: StartupStatusResponse): string {
  const issueCount = status.diagnostics.filter((diagnostic) => diagnostic.level !== "info").length;
  return `${startupPhaseDefinitions.length}:${issueCount}`;
}

export function startupDiagnosticKey(diagnostic: StartupDiagnostic): string {
  return diagnosticKey(diagnostic);
}

function diagnosticKey(diagnostic: StartupDiagnostic): string {
  return `${diagnostic.phase}:${diagnostic.code}:${diagnostic.message}`;
}

function startupPhaseStatusLabelKey(status: StartupPhaseStatus): string {
  if (status === "not_started") return "Not started";
  if (status === "loading") return "Loading";
  if (status === "warming") return "Warming";
  if (status === "ready") return "Ready";
  if (status === "degraded") return "Degraded";
  return "Failed";
}

function startupPhaseTone(status: StartupPhaseStatus): SettingsStatusTone {
  if (status === "ready") return "success";
  if (status === "failed") return "danger";
  if (status === "degraded") return "warning";
  if (status === "warming" || status === "loading") return "info";
  return "neutral";
}
