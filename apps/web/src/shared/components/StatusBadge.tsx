import { useI18n } from "../../i18n.js";

export function StatusBadge({ status }: { readonly status: string }): JSX.Element {
  const { t } = useI18n();
  return <span className={`status-badge ${status}`}>{t(status)}</span>;
}
