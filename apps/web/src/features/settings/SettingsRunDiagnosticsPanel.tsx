import { useI18n } from "../../i18n.js";
import type { RunArtifact, RunEventEnvelope, RunSession } from "../../types.js";
import { SettingsDiagnosticsErrorFeedback } from "./SettingsDiagnosticsErrorFeedback.js";
import { SettingsRunDiagnosticsDetail } from "./SettingsRunDiagnosticsDetail.js";
import { SettingsRunDiagnosticsList } from "./SettingsRunDiagnosticsList.js";
import { SettingsRunDiagnosticsToolbar } from "./SettingsRunDiagnosticsToolbar.js";
import {
  projectRunDiagnosticsCounts,
  projectRunDiagnosticsRows,
} from "./run-diagnostics-view-models.js";

export function SettingsRunDiagnosticsPanel({
  artifacts,
  errorMessage,
  events,
  isLoading,
  runs,
  selectedRun,
  selectedRunId,
  onClose,
  onOpenFullDiagnostics,
  onRefresh,
  onSelectRun,
}: {
  readonly artifacts: readonly RunArtifact[];
  readonly errorMessage: string;
  readonly events: readonly RunEventEnvelope[];
  readonly isLoading: boolean;
  readonly runs: readonly RunSession[];
  readonly selectedRun: RunSession | undefined;
  readonly selectedRunId: string;
  readonly onClose: () => void;
  readonly onOpenFullDiagnostics: (runId?: string) => void;
  readonly onRefresh: () => void;
  readonly onSelectRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const rows = projectRunDiagnosticsRows(runs);
  const counts = projectRunDiagnosticsCounts(runs);
  const matchingRun = selectedRun?.id === selectedRunId ? selectedRun : undefined;
  const detailLoading = Boolean(selectedRunId && !matchingRun && !errorMessage);

  return (
    <section
      className="settings-run-diagnostics-panel"
      data-ui2-settings-run-diagnostics=""
      role="region"
      aria-label={t("Run Diagnostics")}
    >
      <SettingsRunDiagnosticsToolbar
        counts={counts}
        isLoading={isLoading}
        onClose={onClose}
        onRefresh={onRefresh}
      />
      {errorMessage ? (
        <SettingsDiagnosticsErrorFeedback
          className="settings-run-diagnostics-feedback"
          message={errorMessage}
          title={runs.length > 0 ? t("Run diagnostics may be out of date") : t("Run diagnostics are unavailable")}
          tone={runs.length > 0 ? "warning" : "danger"}
        />
      ) : null}
      <div className="settings-run-diagnostics-layout">
        <SettingsRunDiagnosticsList
          isLoading={isLoading}
          rows={rows}
          selectedRunId={selectedRunId}
          onSelect={onSelectRun}
        />
        <SettingsRunDiagnosticsDetail
          artifacts={matchingRun ? artifacts : []}
          events={matchingRun ? events : []}
          loading={detailLoading}
          run={matchingRun}
          selectedRunId={selectedRunId}
          onOpenFullDiagnostics={onOpenFullDiagnostics}
        />
      </div>
    </section>
  );
}
