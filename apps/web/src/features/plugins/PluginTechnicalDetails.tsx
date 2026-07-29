import { InspectorSection } from "../../shared/ui/index.js";
import type { Translate } from "../../i18n.js";
import type { PluginDetailFieldView } from "./plugin-manager-types.js";

export function PluginTechnicalDetails({
  fields,
  t,
}: {
  readonly fields: readonly PluginDetailFieldView[];
  readonly t: Translate;
}): JSX.Element | null {
  if (!fields.length) return null;
  return (
    <InspectorSection
      className="plugin-detail-technical"
      summary={t("Details and diagnostics")}
      title={t("Technical details")}
    >
      <dl className="plugin-detail-fields plugin-technical-fields">
        {fields.map((field, index) => (
          <div key={`${field.label}-${index}`}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </InspectorSection>
  );
}
