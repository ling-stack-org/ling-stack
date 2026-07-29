import type { ApprovalResolution } from "../approvals/types.js";
import { useI18n } from "../../i18n.js";
import type {
  ApprovalRequest,
  MemoryObject,
  ResourceLease,
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  StateTransitionEvent,
  UsedMemoryEvent,
  WorkUnitDetailResponse,
} from "../../types.js";
import { RunDetailPanel } from "./RunDetailPanel.js";
import { RunHistoryHeader } from "./RunHistoryHeader.js";
import { ThreadDetailPanel } from "./ThreadDetailPanel.js";
import { WorkHistoryList } from "./WorkHistoryList.js";
import type { WorkHistoryTurnGroup } from "./runs-thread-types.js";
import { turnStateKey } from "./runs-thread-view-models.js";
import { useRunsThreadsPageController } from "./useRunsThreadsPageController.js";

export function RunHistory({
  cwd,
  runs,
  selectedRunId,
  selectedRun,
  memoryById,
  usedMemoryEvents,
  events,
  artifacts,
  resourceLeases,
  stateTransitions,
  workUnitDetail,
  assistantText,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  isLoading,
  isRunning,
  cancellingRunId,
  errorMessage,
  onRefresh,
  onRefreshSelected,
  onRefreshApprovals,
  onRerun,
  onCancelRun,
  onResolveApproval,
  onOpenProviders,
  onOpenApprovals,
  onEditTask,
  onSelect,
}: {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
  readonly selectedRunId: string;
  readonly selectedRun: RunSession | undefined;
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly workUnitDetail: WorkUnitDetailResponse | undefined;
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly cancellingRunId: string;
  readonly errorMessage: string;
  readonly onRefresh: () => void;
  readonly onRefreshSelected: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onCancelRun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onEditTask: (run: RunSession) => void;
  readonly onSelect: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const controller = useRunsThreadsPageController({ cwd, runs, selectedRunId, selectedRun, autoSelectThread: false, loadTurns: true });
  const { state, actions } = controller;

  function selectRun(runId: string): void {
    actions.setSelectedThreadId("");
    onSelect(runId);
  }

  function selectGroup(group: WorkHistoryTurnGroup): void {
    if (group.source === "durable_turn") {
      selectRun(group.latestRunId);
      return;
    }
    actions.setSelectedThreadId(group.threadId);
    if (group.latestRunId && group.latestRunId !== selectedRunId) onSelect(group.latestRunId);
  }

  function refreshAll(): void {
    onRefresh();
    void actions.refreshThreads();
  }

  return (
    <div className="run-history-layout runs-page-shell">
      <aside className="runs-list-pane runs-panel">
        <RunHistoryHeader
          archivedFilter={state.archivedFilter}
          onArchivedFilterChange={actions.setArchivedFilter}
          onRefresh={refreshAll}
          onSearchChange={actions.setSearch}
          refreshing={isLoading || state.listState === "refreshing"}
          search={state.search}
          title={t("Work history")}
        />
        <div className="thread-list runs-list-scroll">
          <WorkHistoryList
            error={state.listError || errorMessage}
            fallback={state.fallbackFromRuns}
            groups={state.groups}
            loadState={state.listState}
            onClearSearch={() => actions.setSearch("")}
            onRetry={() => void actions.refreshThreads()}
            onSelectGroup={selectGroup}
            onSelectRun={selectRun}
            search={state.search}
            searchMatches={state.searchMatches}
            selectedRunId={selectedRunId}
            selectedThreadId={state.selectedThreadId}
            standaloneRuns={state.standaloneRuns}
            treeRows={state.treeRows}
          />
        </div>
      </aside>
      {state.selectedThreadId ? (
        <ThreadDetailPanel
          cwd={cwd}
          isRunning={isRunning}
          onRefresh={refreshAll}
          onSelectRun={selectRun}
          onSelectThreadId={actions.setSelectedThreadId}
          thread={state.selectedThread}
          threadId={state.selectedThreadId}
          turnState={state.turnStateByThreadKey[turnStateKey(cwd, state.selectedThreadId)]}
          visibleThreads={state.threads}
        />
      ) : (
        <RunDetailPanel
          approvals={approvals}
          approvalsLoading={approvalsLoading}
          artifacts={artifacts}
          assistantText={assistantText}
          cancellingRunId={cancellingRunId}
          cwd={cwd}
          events={events}
          isRunning={isRunning}
          memoryById={memoryById}
          onCancelRun={onCancelRun}
          onEditTask={onEditTask}
          onOpenApprovals={onOpenApprovals}
          onOpenProviders={onOpenProviders}
          onRefresh={onRefreshSelected}
          onRefreshApprovals={onRefreshApprovals}
          onRerun={onRerun}
          onResolveApproval={onResolveApproval}
          onSelectRun={selectRun}
          resolvingApprovals={resolvingApprovals}
          resourceLeases={resourceLeases}
          run={selectedRun}
          stateTransitions={stateTransitions}
          turnContext={state.selectedTurnContext}
          usedMemoryEvents={usedMemoryEvents}
          workUnitDetail={workUnitDetail}
        />
      )}
    </div>
  );
}

export { ThreadDetailPanel } from "./ThreadDetailPanel.js";
