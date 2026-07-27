import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow } from "../../shared/components/index.js";
import { InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { ThreadDetailController } from "./ThreadDetailPanel.js";
import { runStatusTone } from "./run-list-view-models.js";

export function ThreadOverviewSection({ controller }: { readonly controller: ThreadDetailController }): JSX.Element {
  const { t } = useI18n();
  const thread = controller.state.displayThread;
  return (
    <InspectorSection open summary={thread?.objective} title={t("Summary")}>
      <div className="runs-summary-grid">
        <MetaRow label={t("Title")} value={thread?.title ?? "-"} compact />
        <div className="runs-summary-status"><span>{t("Status")}</span><StatusIndicator compact label={t(thread?.status ?? "unknown")} tone={runStatusTone(thread?.status ?? "unknown")} /></div>
        <MetaRow label={t("Kind")} value={thread?.kind ?? "-"} compact />
        <MetaRow label={t("Updated")} value={thread ? formatDateTime(thread.updatedAt) : "-"} compact />
        <MetaRow label={t("Pinned")} value={thread?.pinnedAt ? formatDateTime(thread.pinnedAt) : "-"} compact />
        <MetaRow label={t("Archived")} value={thread?.archivedAt ? formatDateTime(thread.archivedAt) : thread?.status === "archived" ? t("Legacy archived") : "-"} compact />
      </div>
      {thread?.objective ? <p className="runs-readable-copy"><strong>{t("Objective")}</strong>{thread.objective}</p> : null}
    </InspectorSection>
  );
}
