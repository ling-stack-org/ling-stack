import { InspectorSection } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { formatEventData } from "../../lib/data.js";
import type { ApprovalRequest } from "../../types.js";

export function ApprovalTechnicalDetails({ approval }: { readonly approval: ApprovalRequest }): JSX.Element {
  const { t } = useI18n();
  return (
    <InspectorSection className="approval-technical-details" summary={approval.id} title={t("Technical details")}>
      <pre>{formatEventData(approval.payload)}</pre>
    </InspectorSection>
  );
}
