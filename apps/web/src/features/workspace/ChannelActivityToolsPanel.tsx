import type {
  ApprovalRequest,
  Channel,
  ChannelWorkflowStep,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  RunArtifact,
  RunSession,
  Task,
  WorkItemView,
} from "../../types.js";
import type {
  ChannelActivitySavedView,
  ChannelActivityViewAttentionFilter,
  ChannelActivityViewCategoryFilter,
} from "../../lib/channel-activity-views.js";
import { CiTriageAuditPanel } from "../external-work/CiTriageAuditPanel.js";
import { ChannelWorkBoard } from "../work-board/ChannelWorkBoard.js";
import { ActivityFilterToolbar } from "./ChannelActivityPanels.js";

interface ChannelActivityToolsPanelProps {
  readonly search: string;
  readonly categoryFilter: ChannelActivityViewCategoryFilter;
  readonly attentionFilter: ChannelActivityViewAttentionFilter;
  readonly savedViews: readonly ChannelActivitySavedView[];
  readonly activeSavedViewId: string;
  readonly filtersExpanded: boolean;
  readonly savedViewCounts: Readonly<Record<string, number>>;
  readonly selectedSavedView: ChannelActivitySavedView | undefined;
  readonly categoryCounts: Readonly<Record<ChannelActivityViewCategoryFilter, number>>;
  readonly attentionCounts: Readonly<Record<Exclude<ChannelActivityViewAttentionFilter, "all">, number>>;
  readonly filtersActive: boolean;
  readonly customViewLimitReached: boolean;
  readonly onSavedViewSelect: (view: ChannelActivitySavedView) => void;
  readonly onSaveView: () => void;
  readonly onRenameView: () => void;
  readonly onDeleteView: () => void;
  readonly onFiltersExpandedChange: (expanded: boolean) => void;
  readonly onSearchChange: (value: string) => void;
  readonly onCategoryFilterChange: (filter: ChannelActivityViewCategoryFilter) => void;
  readonly onAttentionFilterChange: (filter: ChannelActivityViewAttentionFilter) => void;
  readonly onClearFilters: () => void;
  readonly channel: Channel | undefined;
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly durableWorkItems: readonly WorkItemView[];
  readonly workBoardLoading: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
  readonly onClaimWorkItem: (workItemId: string) => void;
  readonly onHeartbeatWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onReleaseWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onCompleteWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onFailWorkItem: (workItemId: string, claimToken: string) => void;
  readonly busyWorkItemId: string;
  readonly ciTriageLoading: boolean;
  readonly cwd: string;
  readonly onRefreshCiTriage: () => void;
}

export function ChannelActivityToolsPanel({
  search,
  categoryFilter,
  attentionFilter,
  savedViews,
  activeSavedViewId,
  filtersExpanded,
  savedViewCounts,
  selectedSavedView,
  categoryCounts,
  attentionCounts,
  filtersActive,
  customViewLimitReached,
  onSavedViewSelect,
  onSaveView,
  onRenameView,
  onDeleteView,
  onFiltersExpandedChange,
  onSearchChange,
  onCategoryFilterChange,
  onAttentionFilterChange,
  onClearFilters,
  channel,
  tasks,
  runs,
  approvals,
  workflowSteps,
  externalActionDetails,
  externalWorkCiTriage,
  artifactsByRun,
  durableWorkItems,
  workBoardLoading,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
  onClaimWorkItem,
  onHeartbeatWorkItem,
  onReleaseWorkItem,
  onCompleteWorkItem,
  onFailWorkItem,
  busyWorkItemId,
  ciTriageLoading,
  cwd,
  onRefreshCiTriage,
}: ChannelActivityToolsPanelProps): JSX.Element {
  return (
    <div className="channel-activity-tools">
      <ActivityFilterToolbar
        search={search}
        categoryFilter={categoryFilter}
        attentionFilter={attentionFilter}
        savedViews={savedViews}
        activeSavedViewId={activeSavedViewId}
        filtersExpanded={filtersExpanded}
        savedViewCounts={savedViewCounts}
        selectedSavedView={selectedSavedView}
        categoryCounts={categoryCounts}
        attentionCounts={attentionCounts}
        clearDisabled={!filtersActive}
        customViewLimitReached={customViewLimitReached}
        onSavedViewSelect={onSavedViewSelect}
        onSaveView={onSaveView}
        onRenameView={onRenameView}
        onDeleteView={onDeleteView}
        onFiltersExpandedChange={onFiltersExpandedChange}
        onSearchChange={onSearchChange}
        onCategoryFilterChange={onCategoryFilterChange}
        onAttentionFilterChange={onAttentionFilterChange}
        onClear={onClearFilters}
      />
      <ChannelWorkBoard
        channel={channel}
        tasks={tasks}
        runs={runs}
        approvals={approvals}
        workflowSteps={workflowSteps}
        externalActionDetails={externalActionDetails}
        externalWorkCiTriage={externalWorkCiTriage}
        artifactsByRun={artifactsByRun}
        durableWorkItems={durableWorkItems}
        loading={workBoardLoading}
        onOpenTask={onOpenTask}
        onOpenRun={onOpenRun}
        onOpenApproval={onOpenApproval}
        onClaimWorkItem={onClaimWorkItem}
        onHeartbeatWorkItem={onHeartbeatWorkItem}
        onReleaseWorkItem={onReleaseWorkItem}
        onCompleteWorkItem={onCompleteWorkItem}
        onFailWorkItem={onFailWorkItem}
        busyWorkItemId={busyWorkItemId}
      />
      <CiTriageAuditPanel
        records={externalWorkCiTriage}
        loading={ciTriageLoading}
        compact
        maxRecords={3}
        cwd={cwd}
        onRefresh={onRefreshCiTriage}
        onSelectTask={onOpenTask}
        onOpenRun={onOpenRun}
      />
    </div>
  );
}
