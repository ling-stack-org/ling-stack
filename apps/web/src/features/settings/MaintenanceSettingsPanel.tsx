import type { EffectiveConfigResponse, StartupStatusResponse } from "../../types.js";
import { useI18n } from "../../i18n.js";
import { StartupIssueList } from "./StartupIssueList.js";
import { StartupReadinessSummary } from "./StartupReadinessSummary.js";
import { StartupTechnicalDetails } from "./StartupTechnicalDetails.js";
import {
  projectStartupIssues,
  projectStartupStatus,
} from "./startup-readiness-view-models.js";

export function StartupDiagnosticsSettingsPanel({
  effectiveConfig,
  startupStatus,
  startupStatusLoading,
  startupStatusError,
  onRefreshStartup,
  onOpenRunDiagnostics,
}: {
  readonly cwd: string;
  readonly effectiveConfig?: EffectiveConfigResponse;
  readonly startupStatus: StartupStatusResponse | undefined;
  readonly startupStatusLoading: boolean;
  readonly startupStatusAction: "refresh" | undefined;
  readonly startupStatusError: string;
  readonly onRefreshStartup: () => void;
  readonly onOpenRunDiagnostics: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const statusView = projectStartupStatus(startupStatus, startupStatusLoading, startupStatusError);
  const issues = projectStartupIssues(startupStatus);

  return (
    <section
      className="settings-startup-diagnostics"
      data-ui2-settings-startup-diagnostics=""
      aria-label={t("Startup and diagnostics")}
    >
      <StartupReadinessSummary
        isLoading={startupStatusLoading}
        status={startupStatus}
        statusView={statusView}
        onOpenRunDiagnostics={onOpenRunDiagnostics}
        onRefresh={onRefreshStartup}
      />
      <StartupIssueList
        errorMessage={startupStatusError}
        hasSnapshot={Boolean(startupStatus)}
        issues={issues}
      />
      {startupStatus ? <StartupTechnicalDetails effectiveConfig={effectiveConfig} status={startupStatus} /> : null}
    </section>
  );
}
