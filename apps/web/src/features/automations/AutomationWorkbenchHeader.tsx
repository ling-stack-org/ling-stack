import { Plus } from "lucide-react";
import { Button } from "../../shared/ui/index.js";
import type { AutomationPageSummary, AutomationTranslate } from "./automation-view-models.js";
import { DesktopTitlebarSurface } from "../../app/DesktopTitlebarSurface.js";

export function AutomationWorkbenchHeader({
  disabled,
  summary,
  t,
  onCreate,
}: {
  readonly disabled: boolean;
  readonly summary: AutomationPageSummary;
  readonly t: AutomationTranslate;
  readonly onCreate: () => void;
}): React.JSX.Element {
  return (
    <DesktopTitlebarSurface>
    <header
      className="automations-inbox-header automation-ui2-header"
      data-desktop-window-drag-region="true"
    >
      <div className="automation-ui2-header-copy">
        <h1 id="automations-title">{t("Scheduled tasks")}</h1>
        <p>{t("{count} tasks · {enabled} enabled · {scheduled} scheduled · {attention} need attention", {
          attention: summary.attentionCount,
          count: summary.totalCount,
          enabled: summary.enabledCount,
          scheduled: summary.scheduledCount,
        })}</p>
      </div>
      <div className="automation-ui2-header-actions">
        <Button
          disabled={disabled}
          leadingIcon={<Plus aria-hidden="true" size={16} />}
          onClick={onCreate}
          variant="primary"
        >
          {t("Create task")}
        </Button>
      </div>
    </header>
    </DesktopTitlebarSurface>
  );
}
