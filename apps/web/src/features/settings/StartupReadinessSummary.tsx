import { Power, RefreshCw, SquareTerminal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { Button, IconButton, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import type { StartupStatusResponse } from "../../types.js";
import type { StartupStatusViewModel } from "./startup-readiness-view-models.js";

export function StartupReadinessSummary({
  isLoading,
  status,
  statusView,
  onOpenRunDiagnostics,
  onRefresh,
}: {
  readonly isLoading: boolean;
  readonly status: StartupStatusResponse | undefined;
  readonly statusView: StartupStatusViewModel;
  readonly onOpenRunDiagnostics: () => void;
  readonly onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const timestamp = status?.updatedAt
    ? t("Updated {time}", { time: formatDateTime(status.updatedAt) })
    : t("Check startup status to inspect this workspace.");

  return (
    <header className="settings-startup-header">
      <div className="settings-startup-identity">
        <Power aria-hidden="true" />
        <span>
          <strong>{t("Startup status")}</strong>
          {isLoading && !status ? <Skeleton width={176} /> : <small>{timestamp}</small>}
        </span>
      </div>
      <div className="settings-startup-primary-state">
        <StatusIndicator label={t(statusView.labelKey)} tone={statusView.tone} />
      </div>
      <div className="settings-startup-actions">
        <IconButton
          icon={RefreshCw}
          label={t("Check status")}
          loading={isLoading}
          loadingLabel={t("Checking status")}
          onClick={onRefresh}
        />
        <Button
          leadingIcon={<SquareTerminal aria-hidden="true" />}
          size="sm"
          variant="secondary"
          onClick={onOpenRunDiagnostics}
        >
          {t("Open Run Diagnostics")}
        </Button>
      </div>
    </header>
  );
}
