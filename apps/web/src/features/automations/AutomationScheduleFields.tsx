import { SelectControl } from "../../shared/components/SelectControl.js";
export type AutomationScheduleChoice = "daily" | "workdays" | "weekly" | "custom";

export function AutomationScheduleFields({
  scheduleMode,
  timeOfDay,
  weekday,
  customRRule,
  t,
  onScheduleModeChange,
  onTimeOfDayChange,
  onWeekdayChange,
  onCustomRRuleChange,
}: {
  readonly scheduleMode: AutomationScheduleChoice;
  readonly timeOfDay: string;
  readonly weekday: string;
  readonly customRRule: string;
  readonly t: (value: string) => string;
  readonly onScheduleModeChange: (mode: AutomationScheduleChoice) => void;
  readonly onTimeOfDayChange: (value: string) => void;
  readonly onWeekdayChange: (value: string) => void;
  readonly onCustomRRuleChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="automation-popover-form">
      <label>
        <span>{t("Plan")}</span>
        <SelectControl value={scheduleMode} onChange={(event) => onScheduleModeChange(event.target.value as AutomationScheduleChoice)}>
          <option value="daily">{t("Daily")}</option>
          <option value="workdays">{t("Workdays")}</option>
          <option value="weekly">{t("Weekly")}</option>
          <option value="custom">{t("Custom RRULE")}</option>
        </SelectControl>
      </label>
      {scheduleMode === "weekly" ? (
        <label>
          <span>{t("Weekday")}</span>
          <SelectControl value={weekday} onChange={(event) => onWeekdayChange(event.target.value)}>
            <option value="1">{t("Monday")}</option>
            <option value="2">{t("Tuesday")}</option>
            <option value="3">{t("Wednesday")}</option>
            <option value="4">{t("Thursday")}</option>
            <option value="5">{t("Friday")}</option>
            <option value="6">{t("Saturday")}</option>
            <option value="0">{t("Sunday")}</option>
          </SelectControl>
        </label>
      ) : null}
      {scheduleMode === "custom" ? (
        <details className="automation-advanced-schedule" open>
          <summary>{t("Advanced schedule")}</summary>
          <label>
            <span>{t("RRULE")}</span>
            <input value={customRRule} onChange={(event) => onCustomRRuleChange(event.target.value)} />
          </label>
        </details>
      ) : (
        <label>
          <span>{t("Time")}</span>
          <input type="time" value={timeOfDay} onChange={(event) => onTimeOfDayChange(event.target.value)} />
        </label>
      )}
    </div>
  );
}
