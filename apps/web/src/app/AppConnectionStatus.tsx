import { RotateCw } from "lucide-react";
import { useI18n } from "../i18n.js";
import { Button, InlineFeedback } from "../shared/ui/index.js";
import type { DesktopDaemonStatus } from "../../../desktop/shared/desktop-capabilities.js";

export function AppConnectionStatus({
  offline,
  refreshing,
  onRetry,
  desktopStatus,
}: {
  readonly offline: boolean;
  readonly refreshing: boolean;
  readonly onRetry: () => void;
  readonly desktopStatus?: DesktopDaemonStatus;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (desktopStatus?.ownedByDesktop && (desktopStatus.state === "draining" || desktopStatus.state === "blocked")) {
    const draining = desktopStatus.state === "draining";
    const refused = desktopStatus.reason === "stop_blocked";
    return (
      <div className="app-connection-status" role="status">
        <InlineFeedback tone={draining ? "warning" : "danger"} title={t(draining ? "Draining local work"
          : refused ? "Local work could not stop" : "Local work stop is unconfirmed")}>
          <span>{t(draining ? "Waiting for the original Host to finish. Existing executions and their evidence are preserved."
            : refused ? "Stop proof is unavailable. The original Host is retained; automatic restart is withheld."
              : "The original Host has not confirmed a clean stop. No replacement will be started.")}</span>
        </InlineFeedback>
      </div>
    );
  }
  if (!offline) return null;

  return (
    <div className="app-connection-status">
      <InlineFeedback title={t("Local service is unavailable")} tone="danger">
        <div className="app-connection-status-content">
          <span>{t("Some information may be out of date. Reconnect to continue.")}</span>
          <Button
            leadingIcon={<RotateCw aria-hidden="true" size={14} />}
            loading={refreshing}
            loadingLabel={t("Reconnecting")}
            onClick={onRetry}
            size="sm"
          >
            {t("Reconnect")}
          </Button>
        </div>
      </InlineFeedback>
    </div>
  );
}
