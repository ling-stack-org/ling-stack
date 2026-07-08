import { useI18n } from "../../i18n.js";
import type { AutomationSchedulerState } from "../../types.js";
import { automationSchedulerCopy } from "./automation-view-models.js";

export function AutomationSchedulerStrip({
  scheduler,
  manualEnabledCount,
}: {
  readonly scheduler?: AutomationSchedulerState;
  readonly manualEnabledCount: number;
}): JSX.Element {
  const { t } = useI18n();
  const copy = automationSchedulerCopy({ scheduler, manualEnabledCount, t });

  return (
    <section className="automation-scheduler-strip" aria-label={t("Automation scheduler")}>
      <div className="automation-scheduler-summary">
        <strong>{copy.statusLabel}</strong>
        <span>{copy.summary}</span>
      </div>
    </section>
  );
}
