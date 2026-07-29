import { useI18n } from "../../i18n.js";
import { InlineFeedback, InspectorSection, type InlineFeedbackTone } from "../../shared/ui/index.js";

export function SettingsDiagnosticsErrorFeedback({
  className,
  message,
  title,
  tone,
}: {
  readonly className?: string;
  readonly message: string;
  readonly title: string;
  readonly tone: InlineFeedbackTone;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <InlineFeedback className={className} title={title} tone={tone}>
      <InspectorSection
        className="settings-diagnostics-error-details"
        title={t("Error details")}
        summary={t("Needs attention")}
      >
        <code>{message}</code>
      </InspectorSection>
    </InlineFeedback>
  );
}
