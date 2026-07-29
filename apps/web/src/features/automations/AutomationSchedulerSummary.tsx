import { CalendarClock } from "lucide-react";
import { Button, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { AutomationSchedulerViewModel, AutomationTranslate } from "./automation-view-models.js";

export function AutomationSchedulerSummary({
  busy,
  error,
  scheduler,
  t,
  onStart,
  onStop,
}: {
  readonly busy: boolean;
  readonly error: string;
  readonly scheduler: AutomationSchedulerViewModel;
  readonly t: AutomationTranslate;
  readonly onStart: () => void;
  readonly onStop: () => void;
}): JSX.Element {
  return (
    <section className="automation-scheduler-strip automation-ui2-scheduler" aria-label={t("Automation scheduler")}>
      <div className="automation-ui2-scheduler-icon" aria-hidden="true"><CalendarClock size={17} /></div>
      <div className="automation-ui2-scheduler-copy">
        <StatusIndicator compact label={scheduler.statusLabel} tone={scheduler.statusTone} />
        <span>{scheduler.summary}</span>
      </div>
      {scheduler.nextRunAt ? (
        <span className="automation-ui2-scheduler-next">{t("Time")} · {formatDateTime(scheduler.nextRunAt)}</span>
      ) : null}
      {scheduler.action ? (
        <Button
          loading={busy}
          loadingLabel={scheduler.actionLabel}
          onClick={scheduler.action === "start" ? onStart : onStop}
          size="sm"
          variant="secondary"
        >
          {scheduler.actionLabel}
        </Button>
      ) : null}
      {error ? (
        <InlineFeedback className="automation-ui2-scheduler-error" title={t("Scheduler needs attention")} tone="danger">
          {error}
        </InlineFeedback>
      ) : null}
    </section>
  );
}
