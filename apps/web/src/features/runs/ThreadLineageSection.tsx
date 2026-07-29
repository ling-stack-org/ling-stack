import { GitBranch } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { Button, DataRow, EmptyState, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { ThreadDetailController } from "./ThreadDetailPanel.js";
import { runStatusTone } from "./run-list-view-models.js";

export function ThreadLineageSection({ controller, onSelectThreadId }: {
  readonly controller: ThreadDetailController;
  readonly onSelectThreadId: (threadId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const { displayThread: thread, parentThread, childThreads } = controller.state;
  return (
    <InspectorSection summary={t("{count} child branches", { count: childThreads.length })} title={t("Fork lineage")}>
      <div className="runs-section-list">
        {thread?.parentThreadId ? (
          <DataRow
            actions={<Button onClick={() => onSelectThreadId(thread.parentThreadId ?? "")} size="sm">{t("Open source")}</Button>}
            identity={<span><strong>{t("Forked from")} {parentThread?.title ?? thread.parentThreadId}</strong><small>{thread.parentTurnId ? `${t("Source turn")}: ${thread.parentTurnId}` : t("Thread-level fork")}</small></span>}
            status={<StatusIndicator compact label={t(parentThread?.status ?? "unknown")} tone={runStatusTone(parentThread?.status ?? "unknown")} />}
          />
        ) : <EmptyState compact icon={<GitBranch />} title={t("This thread is a source branch.")} />}
        {childThreads.map((child) => (
          <DataRow
            identity={<span><strong>{child.title}</strong><small>{formatDateTime(child.updatedAt)}</small></span>}
            key={child.id}
            onClick={() => onSelectThreadId(child.id)}
            role="button"
            status={<StatusIndicator compact label={t(child.status)} tone={runStatusTone(child.status)} />}
          />
        ))}
        {controller.state.forkedThreadId ? <p className="runs-readable-copy"><strong>{t("Fork created")}</strong>{controller.state.forkedThreadId}</p> : null}
      </div>
    </InspectorSection>
  );
}
