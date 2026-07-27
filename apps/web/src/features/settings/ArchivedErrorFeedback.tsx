import { useI18n } from "../../i18n.js";
import { InlineFeedback, InspectorSection } from "../../shared/ui/index.js";
import type { ArchivedSettingsFeedback } from "./useArchivedSettingsController.js";

export function ArchivedErrorFeedback({
  className,
  feedback,
}: {
  readonly className?: string;
  readonly feedback: ArchivedSettingsFeedback;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className={["archived-items-feedback", className].filter(Boolean).join(" ")}>
      <InlineFeedback tone="danger">{feedback.message}</InlineFeedback>
      {feedback.details ? (
        <InspectorSection
          className="archived-items-error-details"
          title={t("Error details")}
          summary={t("Needs attention")}
        >
          <code>{feedback.details}</code>
        </InspectorSection>
      ) : null}
    </div>
  );
}
