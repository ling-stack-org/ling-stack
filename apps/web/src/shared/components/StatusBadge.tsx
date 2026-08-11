import { useI18n } from "../../i18n.js";

/** @deprecated Use Badge or StatusIndicator with a feature-derived tone and label. */
export function StatusBadge({ status }: { readonly status: string }): React.JSX.Element {
  const { t } = useI18n();
  return <span className={`status-badge ${status}`}>{t(status)}</span>;
}
