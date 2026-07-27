import { RefreshCw } from "lucide-react";
import { Button, InlineFeedback } from "../../shared/ui/index.js";
import type { Translate } from "../../i18n.js";

export function PluginManagerRefreshFeedback({
  count,
  loading,
  onRetry,
  t,
}: {
  readonly count: number;
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
        {t("Stale")} · {t("Showing")} {count} {t("Plugins")}
      </span>
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
