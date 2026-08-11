import { RefreshCw, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { IconButton } from "../../shared/ui/index.js";
import type { RunDiagnosticsCounts } from "./run-diagnostics-view-models.js";

export function SettingsRunDiagnosticsToolbar({
  counts,
  isLoading,
  onClose,
  onRefresh,
}: {
  readonly counts: RunDiagnosticsCounts;
  readonly isLoading: boolean;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <header className="settings-run-diagnostics-toolbar">
      <span className="settings-run-diagnostics-heading">
        <strong>{t("Run Diagnostics")}</strong>
        <small>{t("{count} recent · {running} running · {attention} need attention", {
          count: counts.recent,
          running: counts.running,
          attention: counts.attention,
        })}</small>
      </span>
      <span className="settings-run-diagnostics-actions">
        <IconButton
          icon={RefreshCw}
          label={t("Check run status")}
          loading={isLoading}
          loadingLabel={t("Checking run status")}
          onClick={onRefresh}
        />
        <IconButton icon={X} label={t("Close run diagnostics")} onClick={onClose} />
      </span>
    </header>
  );
}
