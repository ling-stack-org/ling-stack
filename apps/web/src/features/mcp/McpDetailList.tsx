import { useI18n } from "../../i18n.js";
import type { McpDetailItem } from "./mcp-settings-view-models.js";

export function McpDetailList({ items }: { readonly items: readonly McpDetailItem[] }): JSX.Element {
  const { t } = useI18n();
  return (
    <dl className="settings-mcp-detail-list">
      {items.map((item) => (
        <div key={`${item.labelKey}:${item.value}`}>
          <dt>{t(item.labelKey)}</dt>
          <dd>{localizeDetailValue(item.value, t)}</dd>
        </div>
      ))}
    </dl>
  );
}

function localizeDetailValue(value: string, t: (key: string) => string): string {
  if (value === "Yes" || value === "No") return t(value);
  return value;
}
