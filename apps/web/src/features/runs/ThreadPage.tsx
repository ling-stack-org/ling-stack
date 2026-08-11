import { Workflow } from "lucide-react";
import { useEffect } from "react";
import { useI18n } from "../../i18n.js";
import { useFocusRevalidationToken } from "../../shared/hooks/use-focus-revalidation-token.js";
import { EmptyState } from "../../shared/ui/index.js";
import { RunHistoryHeader } from "./RunHistoryHeader.js";
import { ThreadDetailPanel } from "./ThreadDetailPanel.js";
import { ThreadList } from "./ThreadList.js";
import { useRunsThreadsPageController } from "./useRunsThreadsPageController.js";

export function ThreadPage({ cwd, isRunning, initialThreadId, onRefreshRuns, onSelectRun }: {
  readonly cwd: string;
  readonly isRunning: boolean;
  readonly initialThreadId?: string;
  readonly onRefreshRuns: () => void;
  readonly onSelectRun: (runId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const focusRevalidationToken = useFocusRevalidationToken();
  const controller = useRunsThreadsPageController({ cwd, runs: [], initialThreadId, autoSelectThread: true, loadTurns: false });
  const { state, actions } = controller;
  function refreshAll(): void {
    onRefreshRuns();
    void actions.refreshThreads();
  }
  useEffect(() => {
    if (focusRevalidationToken === 0) return;
    void actions.refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRevalidationToken]);
  return (
    <div className="run-history-layout thread-page-layout runs-page-shell">
      <aside className="runs-list-pane runs-panel">
        <RunHistoryHeader
          archivedFilter={state.archivedFilter}
          onArchivedFilterChange={actions.setArchivedFilter}
          onSearchChange={actions.setSearch}
          search={state.search}
          title={t("Threads")}
        />
        <div className="thread-list runs-list-scroll">
          <ThreadList
            error={state.listError}
            loadState={state.listState}
            onClearSearch={() => actions.setSearch("")}
            onRetry={() => void actions.refreshThreads()}
            onSelect={actions.setSelectedThreadId}
            search={state.search}
            selectedThreadId={state.selectedThreadId}
            threads={state.threads}
          />
        </div>
      </aside>
      {state.selectedThreadId ? (
        <ThreadDetailPanel
          cwd={cwd}
          isRunning={isRunning}
          onRefresh={refreshAll}
          onSelectRun={onSelectRun}
          onSelectThreadId={actions.setSelectedThreadId}
          thread={state.selectedThread}
          threadId={state.selectedThreadId}
          visibleThreads={state.threads}
        />
      ) : (
        <section className="runs-detail-workspace" aria-label={t("Thread detail")}>
          <EmptyState icon={<Workflow />} title={t("Select a thread to inspect evidence, actions, lineage, and resume context.")} />
        </section>
      )}
    </div>
  );
}
