import { Wrench } from "lucide-react";
import { Button, InlineFeedback, InspectorSection } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { MediaJobProjectionInput, MediaJobRepairView } from "./media-job-types.js";

export function MediaJobRepair({
  projection,
  repair,
  onAction,
}: {
  readonly projection: MediaJobProjectionInput;
  readonly repair: MediaJobRepairView;
  readonly onAction: (action: MediaJobRepairView["primaryAction"]["id"], projection: MediaJobProjectionInput) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="media-job-repair-owner">
      <InlineFeedback className="media-job-repair" data-media-job-repair={repair.primaryAction.id} role="alert" title={t(repair.titleKey)} tone={repair.tone}>
        <p>{t(repair.descriptionKey)}</p>
        <Button
          disabled={repair.primaryAction.disabled}
          leadingIcon={<Wrench size={15} />}
          size="sm"
          title={repair.primaryAction.disabledReasonKey ? t(repair.primaryAction.disabledReasonKey) : undefined}
          variant="primary"
          onClick={() => onAction(repair.primaryAction.id, projection)}
        >{t(repair.primaryAction.labelKey)}</Button>
      </InlineFeedback>
      <InspectorSection title={t("Technical details")} summary={t("Raw generation error")}>
        <p className="media-job-repair-raw">{repair.rawDetails}</p>
      </InspectorSection>
    </div>
  );
}
