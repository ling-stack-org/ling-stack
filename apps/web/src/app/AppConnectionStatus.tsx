import { RotateCw } from "lucide-react";
import { useI18n } from "../i18n.js";
import { Button, InlineFeedback } from "../shared/ui/index.js";

export function AppConnectionStatus({
  offline,
  refreshing,
  onRetry,
}: {
  readonly offline: boolean;
  readonly refreshing: boolean;
  readonly onRetry: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
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
