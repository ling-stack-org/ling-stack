import { Clock3, History, Workflow } from "lucide-react";
import type { CSSProperties } from "react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import { Button, DataRow, EmptyState, InlineFeedback, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import type { LingThreadSearchMatch, RunSession } from "../../types.js";
import {
  buildThreadSearchMatchMap,
  formatLingThreadSearchMatch,
  formatWorkHistoryMetadataHint,
  runStatusTone,
} from "./run-list-view-models.js";
import type { ThreadListLoadState, WorkHistoryTreeRow, WorkHistoryTurnGroup } from "./runs-thread-types.js";

export function WorkHistoryList({
  groups,
  treeRows,
  standaloneRuns,
  selectedRunId,
  selectedThreadId,
  search,
  searchMatches,
  loadState,
  error,
  fallback,
  onClearSearch,
  onRetry,
  onSelectGroup,
  onSelectRun,
}: {
  readonly groups: readonly WorkHistoryTurnGroup[];
  readonly treeRows: readonly WorkHistoryTreeRow[];
  readonly standaloneRuns: readonly RunSession[];
  readonly selectedRunId: string;
  readonly selectedThreadId: string;
  readonly search: string;
  readonly searchMatches: readonly LingThreadSearchMatch[];
  readonly loadState: ThreadListLoadState;
  readonly error: string;
  readonly fallback: boolean;
  readonly onClearSearch: () => void;
  readonly onRetry: () => void;
  readonly onSelectGroup: (group: WorkHistoryTurnGroup) => void;
  readonly onSelectRun: (runId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const searchMatchByThreadId = buildThreadSearchMatchMap(searchMatches);
  const initialLoading = loadState === "loading-initial";
  const failed = loadState === "failed";
  const stale = loadState === "stale";
  const noResult = Boolean(search.trim()) && groups.length === 0 && !initialLoading && !failed;
  return (
    <div className="runs-history-list" role="listbox" aria-label={t("Work history")}>
      {stale ? (
        <InlineFeedback tone="warning" title={t("Some information may be out of date. Reconnect to continue.")}>
          <span>{error}</span>
          <Button onClick={onRetry} size="sm">{t("Retry")}</Button>
        </InlineFeedback>
      ) : null}
      {fallback ? <InlineFeedback tone="info">{t("Legacy run-only records")}</InlineFeedback> : null}
      {initialLoading ? <HistorySkeleton /> : failed ? (
        <EmptyState
          action={<Button onClick={onRetry} size="sm">{t("Retry")}</Button>}
          icon={<History />}
          title={t("Page failed to load")}
          description={error}
        />
      ) : noResult ? (
        <EmptyState
          action={<Button onClick={onClearSearch} size="sm">{t("Clear")}</Button>}
          compact
          icon={<History />}
          title={t("No active branches match")}
        />
      ) : groups.length === 0 ? (
        <EmptyState compact icon={<Workflow />} title={t("No thread bindings yet")} />
      ) : treeRows.map(({ group, depth, parentHidden }) => {
        const selected = group.source === "durable_turn"
          ? !selectedThreadId && group.runIds.includes(selectedRunId)
          : group.threadId === selectedThreadId || (!selectedThreadId && group.latestRunId === selectedRunId);
        const metadata = [
          group.thread?.parentThreadId ? t("Fork branch") : "",
          parentHidden ? t("Parent hidden") : "",
          group.thread?.pinnedAt ? t("Pinned") : "",
          group.thread?.archivedAt || group.thread?.status === "archived" ? t("Archived") : "",
          group.source === "durable_turn" ? t("Durable turn") : group.thread?.kind ?? t("Work thread"),
          t("{count} attempts", { count: group.attemptCount }),
          formatWorkHistoryMetadataHint(group.thread, t),
        ].filter(Boolean).join(" · ");
        const match = searchMatchByThreadId.get(group.threadId);
        return (
          <div className="runs-history-group" key={group.id}>
            <DataRow
              className={`runs-history-row work-history-branch-row${selected ? " selected" : ""}`}
              data-depth={depth}
              identity={<span><strong>{group.title}</strong><small>{metadata}</small>{match ? <small>{formatLingThreadSearchMatch(match, t)}: {match.snippet}</small> : null}</span>}
              onClick={() => onSelectGroup(group)}
              role="button"
              selected={selected}
              status={<span><StatusIndicator compact label={t(group.status)} tone={runStatusTone(group.status)} /><time>{formatDateTime(group.updatedAt)}</time></span>}
              style={{ "--runs-tree-depth": depth } as CSSProperties}
            />
            {group.source === "durable_turn" && group.attempts.length > 1 ? (
              <div className="runs-attempt-list" aria-label={t("Attempts")}>
                {group.attempts.map((attempt) => (
                  <DataRow
                    compact
                    className="runs-attempt-row"
                    identity={<span><strong>{t("Attempt {number}", { number: attempt.attemptNumber })}</strong><small>{readTaskTitle(attempt.run.taskSnapshot) || attempt.run.taskId}</small></span>}
                    key={attempt.run.id}
                    onClick={() => onSelectRun(attempt.run.id)}
                    role="button"
                    selected={attempt.run.id === selectedRunId && !selectedThreadId}
                    status={<span><StatusIndicator compact label={t(attempt.run.status)} tone={runStatusTone(attempt.run.status)} /><time>{formatDateTime(attempt.run.updatedAt || attempt.run.createdAt)}</time></span>}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="runs-standalone-list" aria-label={t("Legacy run-only records")}>
        <h3><Clock3 aria-hidden="true" size={15} />{t("Legacy run-only records")}</h3>
        {standaloneRuns.length === 0 ? <EmptyState compact icon={<Clock3 />} title={t("No run-only records for this workspace")} /> : standaloneRuns.map((run) => (
          <DataRow
            className="runs-history-row"
            identity={<span><strong>{readTaskTitle(run.taskSnapshot) || run.taskId}</strong><small>{run.providerName}/{run.providerModel}</small></span>}
            key={run.id}
            onClick={() => onSelectRun(run.id)}
            role="button"
            selected={run.id === selectedRunId}
            status={<span><StatusIndicator compact label={t(run.status)} tone={runStatusTone(run.status)} /><time>{formatDateTime(run.createdAt)}</time></span>}
          />
        ))}
      </div>
    </div>
  );
}

function HistorySkeleton(): React.JSX.Element {
  return <div className="runs-history-skeleton" aria-label="Loading">{Array.from({ length: 6 }, (_, index) => <Skeleton height={58} key={index} shape="block" />)}</div>;
}
