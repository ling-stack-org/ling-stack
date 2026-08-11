import { Field, Input, Select } from "../../shared/ui/index.js";
import type { AutomationTranslate } from "./automation-view-models.js";

export type AutomationScheduleChoice = "custom" | "daily" | "interval" | "manual" | "weekly";

export interface AutomationScheduleValue {
  readonly customRRule: string;
  readonly intervalMinutes: string;
  readonly mode: AutomationScheduleChoice;
  readonly timeOfDay: string;
  readonly weekday: string;
}

export function AutomationScheduleFields({
  disabled = false,
  error,
  t,
  value,
  onChange,
}: {
  readonly disabled?: boolean;
  readonly error?: string;
  readonly t: AutomationTranslate;
  readonly value: AutomationScheduleValue;
  readonly onChange: (value: AutomationScheduleValue) => void;
}): React.JSX.Element {
  return (
    <div className="automation-ui2-schedule-fields">
      <Field label={t("Schedule")} error={error}>
        <Select
          aria-label={t("Schedule")}
          disabled={disabled}
          value={value.mode}
          onChange={(event) => onChange({ ...value, mode: event.target.value as AutomationScheduleChoice })}
        >
          <option value="manual">{t("Manual")}</option>
          <option value="interval">{t("Interval")}</option>
          <option value="daily">{t("Daily")}</option>
          <option value="weekly">{t("Weekly")}</option>
          <option value="custom">{t("Custom RRULE")}</option>
        </Select>
      </Field>
      {value.mode === "interval" ? (
        <Field label={`${t("Interval")} (${t("minutes")})`}>
          <Input
            disabled={disabled}
            min={1}
            onChange={(event) => onChange({ ...value, intervalMinutes: event.target.value })}
            type="number"
            value={value.intervalMinutes}
          />
        </Field>
      ) : null}
      {value.mode === "daily" || value.mode === "weekly" ? (
        <Field label={t("Time")}>
          <Input
            disabled={disabled}
            onChange={(event) => onChange({ ...value, timeOfDay: event.target.value })}
            type="time"
            value={value.timeOfDay}
          />
        </Field>
      ) : null}
      {value.mode === "weekly" ? (
        <Field label={t("Weekday")}>
          <Select
            disabled={disabled}
            onChange={(event) => onChange({ ...value, weekday: event.target.value })}
            value={value.weekday}
          >
            {[t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")].map((label, index) => (
              <option key={label} value={String(index)}>{label}</option>
            ))}
          </Select>
        </Field>
      ) : null}
      {value.mode === "custom" ? (
        <Field label={t("RRULE")}>
          <Input
            disabled={disabled}
            onChange={(event) => onChange({ ...value, customRRule: event.target.value })}
            value={value.customRRule}
          />
        </Field>
      ) : null}
    </div>
  );
}
