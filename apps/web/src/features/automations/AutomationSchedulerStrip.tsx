import { Loader2, Play, Square } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { AutomationSchedulerState } from "../../types.js";

export function AutomationSchedulerStrip({
  scheduler,
  schedulerAction,
  onStart,
  onStop,
}: {
  readonly scheduler?: AutomationSchedulerState;
  readonly schedulerAction: "start" | "stop" | "";
  readonly onStart: () => void;
  readonly onStop: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const isRunning = scheduler?.status === "running";
  const isError = scheduler?.status === "error";
  const isBusy = schedulerAction !== "";
  const scheduleCount = scheduler?.automationCount ?? 0;
  const statusLabel = isError ? t("Scheduler needs attention") : isRunning ? t("Scheduler running") : t("Scheduler stopped");
  const summary = isError
    ? t("Scheduler needs attention: {message}", { message: scheduler?.lastErrorMessage || t("Unknown error") })
    : isRunning
      ? t("{count} enabled schedules are being watched.", { count: scheduleCount })
      : t("{count} enabled schedules are ready. Start scheduling to run them automatically.", { count: scheduleCount });

  return (
    <section className="automation-scheduler-strip" aria-label={t("Automation scheduler")}>
      <div className="automation-scheduler-summary">
        <strong>{statusLabel}</strong>
        <span>{summary}</span>
      </div>
      <div className="automation-scheduler-actions">
        {isRunning ? (
          <button className="secondary-button compact-button" type="button" onClick={onStop} disabled={isBusy}>
            {schedulerAction === "stop" ? <Loader2 className="spin" size={15} /> : <Square size={15} />}
            {t("Stop scheduler")}
          </button>
        ) : (
          <button className="primary-button compact-button" type="button" onClick={onStart} disabled={isBusy}>
            {schedulerAction === "start" ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
            {t("Start scheduler")}
          </button>
        )}
      </div>
    </section>
  );
}
