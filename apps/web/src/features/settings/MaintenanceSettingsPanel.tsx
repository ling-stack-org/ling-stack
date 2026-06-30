import { useState } from "react";
import { CircleAlert, Database, Loader2, Power, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import type { StartupStatusResponse } from "../../types.js";
import { ArchivedSettingsPanel } from "./ArchivedSettingsPanel.js";
import { SettingsSubnav } from "./SettingsSubnav.js";
import type { ArchivedSettingsControllerActions, ArchivedSettingsControllerState } from "./useArchivedSettingsController.js";

type MaintenanceSubsectionId = "archived" | "diagnostics";

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

export function MaintenanceSettingsPanel({
  cwd,
  archivedState,
  archivedActions,
  startupStatus,
  startupStatusLoading,
  startupStatusAction,
  startupStatusError,
  onRefreshStartup,
  onOpenRunDiagnostics,
}: {
  readonly cwd: string;
  readonly archivedState: ArchivedSettingsControllerState;
  readonly archivedActions: ArchivedSettingsControllerActions;
  readonly startupStatus: StartupStatusResponse | undefined;
  readonly startupStatusLoading: boolean;
  readonly startupStatusAction: "refresh" | undefined;
  readonly startupStatusError: string;
  readonly onRefreshStartup: () => void;
  readonly onOpenRunDiagnostics: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [activeSubsection, setActiveSubsection] = useState<MaintenanceSubsectionId>("archived");

  return (
    <div className="settings-section-stack">
      <SettingsSubnav
        label="Data and maintenance sections"
        activeId={activeSubsection}
        onChange={(id) => setActiveSubsection(id as MaintenanceSubsectionId)}
        options={[
          {
            id: "archived",
            label: "Archived items",
            description: "Restore or permanently delete archived channels and branches.",
            badge: String(archivedState.archivedChannels.length + archivedState.archivedBranches.length),
          },
          {
            id: "diagnostics",
            label: "Startup and diagnostics",
            description: "Inspect startup readiness and open raw run diagnostics when support needs evidence.",
            badge: startupStatus ? t(startupStatus.state) : undefined,
          },
        ]}
      />

      {activeSubsection === "archived" ? <ArchivedSettingsPanel state={archivedState} actions={archivedActions} /> : null}

      {activeSubsection === "diagnostics" ? (
        <section className="panel settings-panel developer-settings-panel" aria-labelledby="developer-settings-title">
        <div className="panel-title">
          <Database size={18} />
          <h2 id="developer-settings-title">{t("Developer")}</h2>
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
              <small>{t("Inspect raw runs, events, artifacts, approvals, shell snapshots, and thread bindings for support debugging.")}</small>
            </div>
            <button className="secondary-button" type="button" onClick={onOpenRunDiagnostics}>
              <Database size={16} />
              {t("Open Run Diagnostics")}
            </button>
          </div>
        </div>
        </section>
      ) : null}
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

      <div className="startup-summary-grid">
        <MetaRow label={t("Workspace")} value={startupStatus?.cwd ?? cwd} compact />
        <MetaRow label={t("State")} value={startupStatus ? startupStatusLabel(startupStatus, t) : startupStatusLoading ? t("Loading") : t("not loaded")} compact />
        <MetaRow label={t("Attempt")} value={startupStatus?.startupAttemptId ?? "-"} compact />
        <MetaRow label={t("Effective config")} value={startupStatus?.effectiveConfigLoadedAt ? formatDateTime(startupStatus.effectiveConfigLoadedAt) : "-"} compact />
      </div>

      <div className="startup-phase-grid" aria-label={t("Startup phases")}>
        {STARTUP_REQUIRED_PHASES.map((phase) => (
          <StartupPhaseRow key={phase} phase={phase} status={startupStatus?.phases[phase] ?? "not_started"} required t={t} />
        ))}
      </div>

      <div className="startup-warmup-list" aria-label={t("Warmup phases")}>
        {STARTUP_OPTIONAL_PHASES.map((phase) => (
          <StartupPhaseRow key={phase} phase={phase} status={startupStatus?.phases[phase] ?? "not_started"} t={t} />
        ))}
      </div>

      {startupStatus?.diagnostics.length ? (
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
