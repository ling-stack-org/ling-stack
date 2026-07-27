import { useI18n } from "../../i18n.js";
import { InspectorSection } from "../../shared/ui/index.js";

export function WorkBoardGuide(): JSX.Element {
  const { t } = useI18n();
  return (
    <InspectorSection title={t("How Work Board is organized")}>
      <div className="work-board-guide-list">
        <span>{t("Approvals are handled in Inbox.")}</span>
        <span>{t("Failures appear in Needs action.")}</span>
        <span>{t("Completed work appears in History.")}</span>
      </div>
    </InspectorSection>
  );
}
