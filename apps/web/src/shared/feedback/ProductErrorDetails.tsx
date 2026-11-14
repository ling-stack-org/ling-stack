import { useI18n } from "../../i18n.js";
import { InspectorSection } from "../ui/index.js";

export function ProductErrorDetails({
  className,
  technicalMessage,
}: {
  readonly className?: string;
  readonly technicalMessage?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (!technicalMessage) return null;

  return (
    <InspectorSection
      appearance="plain"
      className={className ? `product-error-details ${className}` : "product-error-details"}
      title={t("Technical details")}
    >
      <code className="product-error-details-message">{technicalMessage}</code>
    </InspectorSection>
  );
}
