import { Workflow } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { Button, DataRow, EmptyState, InlineFeedback, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import type { LingThread } from "../../types.js";
import { runStatusTone } from "./run-list-view-models.js";
import type { ThreadListLoadState } from "./runs-thread-types.js";

export function ThreadList({ threads, selectedThreadId, search, loadState, error, onClearSearch, onRetry, onSelect }: {
  readonly threads: readonly LingThread[];
  readonly selectedThreadId: string;
  readonly search: string;
  readonly loadState: ThreadListLoadState;
  readonly error: string;
  readonly onClearSearch: () => void;
  readonly onRetry: () => void;
  readonly onSelect: (threadId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (loadState === "loading-initial") {
    return <div className="runs-history-skeleton">{Array.from({ length: 7 }, (_, index) => <Skeleton height={58} key={index} shape="block" />)}</div>;
  }
  if (loadState === "failed") {
    return <EmptyState action={<Button onClick={onRetry} size="sm">{t("Retry")}</Button>} description={error} icon={<Workflow />} title={t("Page failed to load")} />;
  }
  return (
    <div className="runs-thread-list" role="listbox" aria-label={t("Threads")}>
      {loadState === "stale" ? <InlineFeedback tone="warning" title={t("Some information may be out of date. Reconnect to continue.")}><span>{error}</span><Button onClick={onRetry} size="sm">{t("Retry")}</Button></InlineFeedback> : null}
      {threads.length === 0 ? (
        <EmptyState
          action={search.trim() ? <Button onClick={onClearSearch} size="sm">{t("Clear")}</Button> : undefined}
          compact
          icon={<Workflow />}
          title={search.trim() ? t("No active branches match") : t("No threads yet")}
        />
      ) : threads.map((thread) => (
        <DataRow
          className="runs-history-row"
          identity={<span><strong>{thread.title}</strong><small>{thread.kind} · {thread.objective}</small></span>}
          key={thread.id}
          onClick={() => onSelect(thread.id)}
          role="button"
          selected={thread.id === selectedThreadId}
          status={<span><StatusIndicator compact label={t(thread.status)} tone={runStatusTone(thread.status)} /><time>{formatDateTime(thread.updatedAt)}</time></span>}
        />
      ))}
    </div>
  );
}
