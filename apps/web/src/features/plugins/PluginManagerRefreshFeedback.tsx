import { RefreshCw } from "lucide-react";
import { Button, InlineFeedback } from "../../shared/ui/index.js";
import type { Translate } from "../../i18n.js";

export function PluginManagerRefreshFeedback({
  count,
  errorMessage,
  loading,
  onRetry,
  t,
}: {
  readonly count: number;
  readonly errorMessage: string;
  readonly loading: boolean;
  readonly onRetry: () => void;
  readonly t: Translate;
}): JSX.Element {
  return (
    <InlineFeedback
      className="plugin-manager-retained-feedback"
      data-plugin-refresh-retained="true"
      title={`${t("Refresh")} · ${t("failed")}`}
      tone="warning"
    >
      <span className="plugin-manager-retained-copy">
        {count > 0 ? `${t("Stale")} · ${t("Showing")} ${count} ${t("Plugins")}` : errorMessage}
      </span>
      {count > 0 ? <span>{errorMessage}</span> : null}
      <Button
        leadingIcon={<RefreshCw aria-hidden="true" />}
        loading={loading}
        loadingLabel={t("Loading")}
        onClick={onRetry}
        size="sm"
      >
        {t("Retry")}
      </Button>
    </InlineFeedback>
  );
}
