import { Activity } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { StatusBadge } from "../../shared/components/index.js";
import type { TeammateActivityItem } from "../../types.js";
import { TeammateListSection } from "./TeammateListSection.js";

export function TeammateActivityTab({
  activityItems,
}: {
  readonly activityItems: readonly TeammateActivityItem[];
}): JSX.Element {
  const { t } = useI18n();
  return (
    <TeammateListSection
      icon={<Activity size={16} />}
      title={t("Activity")}
      emptyLabel={t("No teammate activity yet")}
      items={activityItems}
      renderItem={(item) => (
        <article key={item.id} className="teammate-data-row">
          <span>
            <strong>{item.title}</strong>
            <small>
              {item.subtitle ?? item.sourceId} · {formatDateTime(item.createdAt)}
            </small>
          </span>
          <StatusBadge status={item.status ?? item.kind} />
        </article>
      )}
    />
  );
}
