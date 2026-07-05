import { CircleAlert, Database, Loader2, Power, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import type { StartupStatusResponse } from "../../types.js";

const STARTUP_REQUIRED_PHASES = [
  "process_config",
  "user_config",
  "workspace_store",
  "effective_config",
  "runtime_policy",
  "secret_resolver",
] as const;

const STARTUP_OPTIONAL_PHASES = [
  "provider_warmup",
  "automation_scheduler",
  "external_work_scheduler",
  "plugin_warmup",
] as const;

export function StartupDiagnosticsSettingsPanel({
  cwd,
  startupStatus,
  startupStatusLoading,
  startupStatusAction,
  startupStatusError,
  onRefreshStartup,
  onOpenRunDiagnostics,
}: {
  readonly cwd: string;
  readonly startupStatus: StartupStatusResponse | undefined;
  readonly startupStatusLoading: boolean;
  readonly startupStatusAction: "refresh" | undefined;
  readonly startupStatusError: string;
  readonly onRefreshStartup: () => void;
  readonly onOpenRunDiagnostics: () => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="settings-section-stack">
      <section className="panel settings-panel developer-settings-panel" aria-labelledby="developer-settings-title">
        <div className="panel-title">
          <Database size={18} />
          <h2 id="developer-settings-title">{t("Startup and diagnostics")}</h2>
        </div>
        <div className="developer-settings-stack">
          <StartupReadinessSection
            cwd={cwd}
            startupStatus={startupStatus}
            startupStatusLoading={startupStatusLoading}
            startupStatusAction={startupStatusAction}
            startupStatusError={startupStatusError}
            onRefreshStartup={onRefreshStartup}
            t={t}
          />
          <div className="settings-action-box">
            <div>
              <strong>{t("Run Diagnostics")}</strong>
            </div>
            <details className="settings-compact-details">
              <summary>{t("What diagnostics include")}</summary>
              <span>{t("Inspect raw runs, events, artifacts, approvals, shell snapshots, and thread bindings for support debugging.")}</span>
            </details>
            <button className="secondary-button" type="button" onClick={onOpenRunDiagnostics}>
              <Database size={16} />
              {t("Open Run Diagnostics")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function StartupReadinessSection({
  cwd,
  startupStatus,
  startupStatusLoading,
  startupStatusAction,
  startupStatusError,
  onRefreshStartup,
  t,
}: {
  readonly cwd: string;
  readonly startupStatus: StartupStatusResponse | undefined;
  readonly startupStatusLoading: boolean;
  readonly startupStatusAction: "refresh" | undefined;
  readonly startupStatusError: string;
  readonly onRefreshStartup: () => void;
  readonly t: Translate;
}): JSX.Element {
  const blockers = (startupStatus?.diagnostics ?? []).filter((diagnostic) =>
    diagnostic.level === "error" || diagnostic.level === "warning"
  );

  return (
    <section className="developer-settings-subsection startup-settings-panel" aria-labelledby="startup-settings-title">
      <div className="panel-title split">
        <span>
          <Power size={18} />
          <h2 id="startup-settings-title">{t("Startup readiness")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onRefreshStartup} disabled={startupStatusLoading}>
          {startupStatusAction === "refresh" || startupStatusLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("Refresh")}
        </button>
      </div>

      {startupStatusError ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {startupStatusError}
        </div>
      ) : null}

      <div className="startup-readiness-card">
        <div className="startup-readiness-main">
          <span>
            <strong>{startupStatus ? startupStatusLabel(startupStatus, t) : startupStatusLoading ? t("Loading") : t("not loaded")}</strong>
            <small>{startupStatus?.updatedAt ? t("Updated {time}", { time: formatDateTime(startupStatus.updatedAt) }) : t("Refresh startup status to inspect this workspace.")}</small>
          </span>
          <StatusBadge status={startupStatus?.state ?? (startupStatusLoading ? "loading" : "not_loaded")} />
        </div>
        <div className="startup-summary-grid">
          <MetaRow label={t("Workspace")} value={startupStatus?.cwd ?? cwd} compact />
          <MetaRow label={t("Attempt")} value={startupStatus?.startupAttemptId ?? "-"} compact />
          <MetaRow label={t("Effective config")} value={startupStatus?.effectiveConfigLoadedAt ? formatDateTime(startupStatus.effectiveConfigLoadedAt) : "-"} compact />
          <MetaRow label={t("Diagnostics")} value={String(startupStatus?.diagnostics.length ?? 0)} compact />
        </div>
      </div>

      {blockers.length > 0 ? (
        <div className="startup-blocker-list" aria-label={t("Startup blockers")}>
          {blockers.slice(0, 4).map((diagnostic) => (
            <div key={`${diagnostic.phase}:${diagnostic.code}:${diagnostic.message}`} className={`startup-diagnostic ${diagnostic.level}`}>
              <div>
                <strong>{diagnostic.phase} / {diagnostic.code}{diagnostic.count && diagnostic.count > 1 ? ` x${diagnostic.count}` : ""}</strong>
                <span>{diagnostic.message}</span>
              </div>
              {diagnostic.nextAction ? <small>{diagnostic.nextAction}</small> : null}
            </div>
          ))}
        </div>
      ) : null}

      <details className="settings-compact-details startup-details">
        <summary>{t("Startup phases")}</summary>
        <div className="startup-phase-grid" aria-label={t("Startup phases")}>
          {STARTUP_REQUIRED_PHASES.map((phase) => (
            <StartupPhaseRow key={phase} phase={phase} status={startupStatus?.phases[phase] ?? "not_started"} required t={t} />
          ))}
        </div>
      </details>

      <details className="settings-compact-details startup-details">
        <summary>{t("Warmup phases")}</summary>
        <div className="startup-warmup-list" aria-label={t("Warmup phases")}>
          {STARTUP_OPTIONAL_PHASES.map((phase) => (
            <StartupPhaseRow key={phase} phase={phase} status={startupStatus?.phases[phase] ?? "not_started"} t={t} />
          ))}
        </div>
      </details>

      {startupStatus?.diagnostics.length ? (
        <details className="settings-compact-details startup-details">
          <summary>{t("Startup diagnostics")}: {startupStatus.diagnostics.length}</summary>
          <div className="startup-diagnostic-list">
            {startupStatus.diagnostics.slice(0, 8).map((diagnostic) => (
              <div key={`${diagnostic.phase}:${diagnostic.code}:${diagnostic.message}`} className={`startup-diagnostic ${diagnostic.level}`}>
                <div>
                  <strong>{diagnostic.phase} / {diagnostic.code}{diagnostic.count && diagnostic.count > 1 ? ` x${diagnostic.count}` : ""}</strong>
                  <span>{diagnostic.message}</span>
                </div>
                {diagnostic.nextAction ? <small>{diagnostic.nextAction}</small> : null}
              </div>
            ))}
          </div>
        </details>
      ) : (
        <div className="empty-state compact-empty startup-empty">
          {startupStatusLoading ? <Loader2 className="spin" /> : <ShieldCheck />}
          <span>{startupStatusLoading ? t("Loading startup status...") : t("No startup diagnostics")}</span>
        </div>
      )}
    </section>
  );
}

function StartupPhaseRow({
  phase,
  status,
  required,
  t,
}: {
  readonly phase: string;
  readonly status: string;
  readonly required?: boolean;
  readonly t: Translate;
}): JSX.Element {
  return (
    <div className={`startup-phase-row ${startupPhaseTone(status)}`}>
      <span>
        <strong>{phase}</strong>
        <small>{required ? t("Required") : t("Warmup")}</small>
      </span>
      <StatusBadge status={status} />
    </div>
  );
}

function startupStatusLabel(status: StartupStatusResponse, t: Translate): string {
  if (status.state === "ready") {
    return t("ready");
  }
  if (status.state === "degraded") {
    return t("degraded");
  }
  if (status.state === "failed") {
    return t("failed");
  }
  return t("starting");
}

function startupPhaseTone(status: string): string {
  if (status === "ready") {
    return "ready";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "degraded") {
    return "degraded";
  }
  return "loading";
}
