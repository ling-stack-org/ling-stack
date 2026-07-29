import { useEffect, useState } from "react";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, InlineFeedback } from "../../shared/ui/index.js";
import type { AutomationDefinition, AutomationTrigger } from "../../types.js";
import { AutomationScheduleFields, type AutomationScheduleValue } from "./AutomationScheduleFields.js";
import { definitionScheduleValue, triggerFromAutomationSchedule } from "./automation-form-models.js";
import type { AutomationTranslate } from "./automation-view-models.js";

export function AutomationScheduleDialog({
  automation,
  busy,
  error,
  t,
  onOpenChange,
  onSave,
}: {
  readonly automation?: AutomationDefinition;
  readonly busy: boolean;
  readonly error: string;
  readonly t: AutomationTranslate;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (trigger: AutomationTrigger, rrule?: string) => void;
}): JSX.Element {
  const [value, setValue] = useState<AutomationScheduleValue>(() => automation ? definitionScheduleValue(automation) : definitionScheduleValue({ trigger: { type: "manual" } } as AutomationDefinition));
  useEffect(() => {
    if (automation) setValue(definitionScheduleValue(automation));
  }, [automation?.id]);
  const invalid = value.mode === "interval" && Number(value.intervalMinutes) <= 0
    || value.mode === "custom" && !/^FREQ=/i.test(value.customRRule.trim());
  return (
    <Dialog busy={busy} open={Boolean(automation)} onOpenChange={onOpenChange}>
      <DialogContent className="automation-ui2-schedule-dialog" size="sm">
        <DialogHeader closeLabel={t("Close")} description={automation?.title} title={t("Schedule")} />
        <DialogBody>
          {error ? <InlineFeedback title={t("Setup needs attention")} tone="danger">{error}</InlineFeedback> : null}
          <AutomationScheduleFields error={invalid ? t("Required") : undefined} t={t} value={value} onChange={setValue} />
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={() => onOpenChange(false)} variant="ghost">{t("Cancel")}</Button>
          <Button
            disabled={invalid}
            loading={busy}
            loadingLabel={t("Save")}
            onClick={() => onSave(triggerFromAutomationSchedule(value), value.mode === "custom" ? value.customRRule.trim() : undefined)}
            variant="primary"
          >
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
