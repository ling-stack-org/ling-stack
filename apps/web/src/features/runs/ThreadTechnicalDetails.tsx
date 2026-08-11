import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow } from "../../shared/components/index.js";
import { DataRow, EmptyState, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { ThreadDetailController } from "./ThreadDetailPanel.js";

export function ThreadTechnicalDetails({ controller }: { readonly controller: ThreadDetailController }): React.JSX.Element {
  const { t } = useI18n();
  const thread = controller.state.displayThread;
  const transitions = controller.state.evidence?.transitions ?? [];
  return (
    <InspectorSection summary={t("{count} transitions", { count: transitions.length })} title={t("Technical details")}>
      <div className="runs-summary-grid">
        <MetaRow label={t("Thread")} value={thread?.id ?? "-"} compact />
        <MetaRow label={t("Active run")} value={thread?.activeRunId ?? "-"} compact />
        <MetaRow label={t("Last run")} value={thread?.lastRunId ?? "-"} compact />
        <MetaRow label={t("Parent thread")} value={thread?.parentThreadId ?? "-"} compact />
        <MetaRow label={t("Parent turn")} value={thread?.parentTurnId ?? "-"} compact />
        <MetaRow label={t("Fork source run")} value={thread?.forkedFromRunId ?? "-"} compact />
      </div>
      <div className="runs-section-list">
        {transitions.length === 0 ? <EmptyState compact title={t("No state transitions recorded.")} /> : transitions.map((transition) => (
          <DataRow identity={`${transition.event}: ${transition.fromStatus} -> ${transition.toStatus}`} key={transition.id} status={<span><StatusIndicator compact label={transition.entityType} /><small>{formatDateTime(transition.createdAt)}</small></span>} />
        ))}
      </div>
    </InspectorSection>
  );
}
