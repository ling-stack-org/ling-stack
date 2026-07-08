import { CircleAlert, Loader2, RefreshCw, SquareTerminal, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import type { RunSession } from "../../types.js";

export function SettingsRunDiagnosticsPanel({
  runs,
  selectedRunId,
  isLoading,
  errorMessage,
  onRefresh,
  onSelectRun,
  onOpenFullDiagnostics,
  onClose,
}: {
  readonly runs: readonly RunSession[];
  readonly selectedRunId: string;
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly onRefresh: () => void;
  readonly onSelectRun: (runId: string) => void;
  readonly onOpenFullDiagnostics: (runId?: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];
  const recentRuns = runs.slice(0, 12);
  const failedCount = runs.filter((run) => run.status === "failed" || run.status === "cancelled").length;
  const runningCount = runs.filter((run) => run.status === "running").length;

  return (
    <section className="panel settings-panel settings-run-diagnostics-panel" aria-label={t("Run Diagnostics")}>
      <div className="panel-title split">
        <span>
          <SquareTerminal size={18} />
          <h2>{t("Run Diagnostics")}</h2>
        </span>
        <div className="action-row compact-actions">
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
          <button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label={t("Close run diagnostics")}>
            <X size={15} />
          </button>
        </div>
      </div>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      <div className="settings-run-diagnostics-summary" aria-label={t("Run diagnostics summary")}>
        <MetaRow label={t("Recent runs")} value={String(runs.length)} compact />
        <MetaRow label={t("Running")} value={String(runningCount)} compact />
        <MetaRow label={t("Needs attention")} value={String(failedCount)} compact />
        <MetaRow label={t("Selected run")} value={selectedRun ? runTitle(selectedRun, t) : t("None")} compact />
      </div>

      <div className="settings-run-diagnostics-layout">
        <div className="settings-run-diagnostics-list" aria-label={t("Recent runs")}>
          {recentRuns.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <SquareTerminal />}
              <span>{isLoading ? t("Loading run diagnostics") : t("No runs yet")}</span>
            </div>
          ) : (
            recentRuns.map((run) => (
              <button
                key={run.id}
                className={run.id === selectedRun?.id ? "settings-run-row active" : "settings-run-row"}
                type="button"
                onClick={() => onSelectRun(run.id)}
              >
                <span>
                  <strong>{runTitle(run, t)}</strong>
                  <small>{formatDateTime(run.updatedAt)}</small>
                </span>
                <StatusBadge status={run.status} />
              </button>
            ))
          )}
        </div>

        <div className="settings-run-diagnostics-detail" aria-label={t("Run diagnostics detail")}>
          {selectedRun ? (
            <>
              <div className="settings-interaction-summary">
                <strong>{runTitle(selectedRun, t)}</strong>
                <StatusBadge status={selectedRun.status} />
                <span>{runNextStep(selectedRun, t)}</span>
              </div>
              {selectedRun.errorMessage ? (
                <div className="inline-error">
                  <CircleAlert size={17} />
                  {t("Run needs attention. Raw failure detail is available below.")}
                </div>
              ) : null}
              <div className="settings-status-grid compact-status-grid">
                <MetaRow label={t("Created")} value={formatDateTime(selectedRun.createdAt)} compact />
                <MetaRow label={t("Updated")} value={formatDateTime(selectedRun.updatedAt)} compact />
              </div>
              <details className="settings-compact-details settings-interaction-details">
                <summary>{t("Raw run details")}</summary>
                <div className="settings-status-grid compact-status-grid">
                  <MetaRow label={t("Run id")} value={selectedRun.id} compact />
                  <MetaRow label={t("Provider")} value={selectedRun.providerName || "-"} compact />
                  <MetaRow label={t("Model")} value={selectedRun.providerModel || "-"} compact />
                  <MetaRow label={t("Failure detail")} value={selectedRun.errorMessage || "-"} compact />
                  <MetaRow label={t("Task")} value={selectedRun.taskId || "-"} compact />
                  <MetaRow label={t("Channel")} value={selectedRun.channelId ?? "-"} compact />
                  <MetaRow label={t("Work unit")} value={selectedRun.workUnitId ?? "-"} compact />
                  <MetaRow label={t("Event log")} value={selectedRun.eventLogPath || "-"} compact />
                </div>
                <button className="secondary-button compact-button" type="button" onClick={() => onOpenFullDiagnostics(selectedRun.id)}>
                  <SquareTerminal size={14} />
                  {t("Open full diagnostics in app")}
                </button>
              </details>
            </>
          ) : (
            <div className="empty-state compact-empty">
              <SquareTerminal />
              <span>{t("Select a run to inspect diagnostics.")}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function runTitle(run: RunSession, t: (key: string, values?: Readonly<Record<string, string | number>>) => string): string {
  const snapshot = run.taskSnapshot;
  if (snapshot && typeof snapshot === "object" && "title" in snapshot) {
    const title = (snapshot as { readonly title?: unknown }).title;
    if (typeof title === "string" && title.trim()) {
      return title;
    }
  }
  return t("Untitled run");
}

function runNextStep(run: RunSession, t: (key: string, values?: Readonly<Record<string, string | number>>) => string): string {
  if (run.status === "failed" || run.status === "cancelled") {
    return t("Review the failure summary, then repair the model or rerun from the original workspace.");
  }
  if (run.status === "running") {
    return t("This run is still active. Refresh diagnostics to inspect the latest state.");
  }
  return t("This run is complete. Raw evidence is available below when support needs it.");
}
