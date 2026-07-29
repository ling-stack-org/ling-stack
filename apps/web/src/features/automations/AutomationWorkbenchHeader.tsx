import { Plus, RefreshCw } from "lucide-react";
import { Button, IconButton } from "../../shared/ui/index.js";
import type { AutomationPageSummary, AutomationTranslate } from "./automation-view-models.js";

export function AutomationWorkbenchHeader({
  disabled,
  refreshing,
  summary,
  t,
  onCreate,
  onRefresh,
}: {
  readonly disabled: boolean;
  readonly refreshing: boolean;
  readonly summary: AutomationPageSummary;
  readonly t: AutomationTranslate;
  readonly onCreate: () => void;
  readonly onRefresh: () => void;
}): JSX.Element {
  return (
    <header
      className="automations-inbox-header automation-ui2-header"
      data-desktop-window-drag-region="true"
    >
      <div className="automation-ui2-header-copy">
        <h1 id="automations-title">{t("Automations")}</h1>
        <p>{t("{count} automations · {enabled} enabled · {scheduled} scheduled watches · {attention} need attention", {
          attention: summary.attentionCount,
          count: summary.totalCount,
          enabled: summary.enabledCount,
          scheduled: summary.scheduledCount,
        })}</p>
      </div>
      <div className="automation-ui2-header-actions">
        <IconButton
          disabled={disabled}
          icon={RefreshCw}
          label={t("Refresh")}
          loading={refreshing}
          loadingLabel={t("Refresh")}
          onClick={onRefresh}
        />
        <Button
          disabled={disabled}
          leadingIcon={<Plus aria-hidden="true" size={16} />}
          onClick={onCreate}
          variant="primary"
        >
          {t("Create automation")}
        </Button>
      </div>
    </header>
  );
}
