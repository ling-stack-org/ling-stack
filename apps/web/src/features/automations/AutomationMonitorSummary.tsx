import { Activity } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import { StatusIndicator } from "../../shared/ui/index.js";
import type { AutomationMonitorViewModel, AutomationTranslate } from "./automation-view-models.js";

export function AutomationMonitorSummary({
  monitors,
  t,
}: {
  readonly monitors: readonly AutomationMonitorViewModel[];
  readonly t: AutomationTranslate;
}): React.JSX.Element | null {
  if (monitors.length === 0) return null;
  return (
    <section className="automation-monitor-summary" aria-label={t("Monitor findings")}>
      <div className="automation-monitor-summary-heading">
        <div className="automation-monitor-summary-title">
          <Activity aria-hidden="true" size={16} />
          <strong>{t("Monitor findings")}</strong>
        </div>
        <span>{t("Bounded local monitor state")}</span>
      </div>
      <div className="automation-monitor-summary-list">
        {monitors.map((monitor) => (
          <div className="automation-monitor-summary-item" key={monitor.automationId}>
            <div className="automation-monitor-summary-item-main">
              <strong>{monitor.title}</strong>
              <span>{monitor.sourceLabel}</span>
            </div>
            <div className="automation-monitor-summary-item-state">
              <StatusIndicator compact label={monitor.statusLabel} tone={monitor.statusTone} />
              <span>{monitor.summary}</span>
              {monitor.lastRunAt ? <time dateTime={monitor.lastRunAt}>{formatDateTime(monitor.lastRunAt)}</time> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
