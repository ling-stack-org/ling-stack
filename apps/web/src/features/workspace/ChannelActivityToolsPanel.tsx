import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
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
import {
  ChannelSavedViewDialog,
  type ChannelSavedViewDialogState,
} from "./ChannelSavedViewDialog.js";

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
  readonly showSearch?: boolean;
  readonly onSavedViewSelect: (view: ChannelActivitySavedView) => void;
  readonly onSaveView: (name: string) => Promise<boolean>;
  readonly onRenameView: (viewId: string, name: string) => Promise<boolean>;
  readonly onDeleteView: (viewId: string) => Promise<boolean>;
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
  showSearch,
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
}: ChannelActivityToolsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [savedViewDialog, setSavedViewDialog] = useState<ChannelSavedViewDialogState>();
  const [savedViewDialogBusy, setSavedViewDialogBusy] = useState(false);
  const [savedViewDialogError, setSavedViewDialogError] = useState("");
  const savedViewReturnFocusRef = useRef<HTMLElement | null>(null);
  const savedViewFallbackFocusRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    setSavedViewDialog(undefined);
    setSavedViewDialogBusy(false);
    setSavedViewDialogError("");
  }, [channel?.id]);

  function rememberSavedViewTrigger(): void {
    savedViewReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }

  function openCreateSavedView(): void {
    rememberSavedViewTrigger();
    setSavedViewDialogError("");
    if (customViewLimitReached) {
      void onSaveView(t("Custom view"));
      return;
    }
    setSavedViewDialog({ mode: "create", draft: t("Custom view") });
  }

  function openRenameSavedView(): void {
    if (!selectedSavedView || selectedSavedView.builtin) return;
    rememberSavedViewTrigger();
    setSavedViewDialogError("");
    setSavedViewDialog({
      mode: "rename",
      draft: selectedSavedView.name,
      viewId: selectedSavedView.id,
      viewName: selectedSavedView.name,
    });
  }

  function openDeleteSavedView(): void {
    if (!selectedSavedView || selectedSavedView.builtin) return;
    rememberSavedViewTrigger();
    setSavedViewDialogError("");
    setSavedViewDialog({
      mode: "delete",
      viewId: selectedSavedView.id,
      viewName: selectedSavedView.name,
    });
  }

  function closeSavedViewDialog(): void {
    if (savedViewDialogBusy) return;
    setSavedViewDialog(undefined);
    setSavedViewDialogError("");
  }

  function restoreSavedViewFocus(forceFallback = false): void {
    const returnTarget = savedViewReturnFocusRef.current;
    const returnTargetDisabled = returnTarget && "disabled" in returnTarget
      ? Boolean((returnTarget as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled)
      : false;
    if (!forceFallback && returnTarget?.isConnected && !returnTargetDisabled) {
      returnTarget.focus({ preventScroll: true });
    } else {
      savedViewFallbackFocusRef.current?.focus({ preventScroll: true });
    }
  }

  async function submitSavedViewDialog(): Promise<void> {
    if (!savedViewDialog || savedViewDialogBusy) return;
    const submittedMode = savedViewDialog.mode;
    setSavedViewDialogBusy(true);
    setSavedViewDialogError("");
    try {
      if (savedViewDialog.mode === "create") {
        await onSaveView(savedViewDialog.draft);
      } else if (savedViewDialog.mode === "rename") {
        await onRenameView(savedViewDialog.viewId, savedViewDialog.draft);
      } else {
        await onDeleteView(savedViewDialog.viewId);
      }
      setSavedViewDialog(undefined);
      globalThis.requestAnimationFrame(() => restoreSavedViewFocus(submittedMode === "delete"));
    } catch (caught) {
      setSavedViewDialogError(caught instanceof Error
        ? caught.message
        : t("Saved view changes could not be saved. Try again."));
    } finally {
      setSavedViewDialogBusy(false);
    }
  }

  return (
    <>
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
          showSearch={showSearch}
          savedViewSelectRef={savedViewFallbackFocusRef}
          onSavedViewSelect={onSavedViewSelect}
          onSaveView={openCreateSavedView}
          onRenameView={openRenameSavedView}
          onDeleteView={openDeleteSavedView}
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
      {savedViewDialog ? (
        <ChannelSavedViewDialog
          busy={savedViewDialogBusy}
          error={savedViewDialogError}
          fallbackFocusRef={savedViewFallbackFocusRef}
          returnFocusRef={savedViewReturnFocusRef}
          state={savedViewDialog}
          onClose={closeSavedViewDialog}
          onDraftChange={(draft) => setSavedViewDialog((current) => current?.mode === "create" || current?.mode === "rename"
            ? { ...current, draft }
            : current)}
          onSubmit={() => void submitSavedViewDialog()}
        />
      ) : null}
    </>
  );
}
