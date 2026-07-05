import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, ClipboardList, ExternalLink, Inbox, ListFilter, RefreshCw, Route, SquareTerminal, UserCheck, XCircle } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  buildWorkItemViews,
  isActionableWorkItem,
  isTerminalWorkItemView,
  workItemActionGroup,
  workItemActionGroupLabel,
  workItemActionGroupOrder,
  workItemNextActionLabel,
  workItemStatusOrder,
  workItemStatusLabel,
  type WorkItemSourceType,
  type WorkItemStatus,
  type WorkItemView,
  type WorkItemWaitingReason,
} from "../../lib/work-items.js";
import { OperationEmptyState, PageActionHeader, StatusBadge } from "../../shared/components/index.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelWorkflowStep,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  RunArtifact,
  RunSession,
  Task,
  WorkItemView as DurableWorkItemView,
} from "../../types.js";
import { WorkItemRow } from "./WorkItemRow.js";

export type WorkBoardScope = "actionable" | "global" | "channel" | "mine" | "blocked" | "history";

const workBoardScopeOrder: readonly WorkBoardScope[] = ["actionable", "global", "channel", "mine", "blocked", "history"];

export function GlobalWorkBoardPage({
  channels,
  tasks,
  runs,
  approvals,
  workflowSteps,
  externalActionDetails,
  externalWorkCiTriage,
  artifactsByRun,
  durableWorkItems,
  onRefresh,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
  onOpenChannel,
  onRouteExternalWork,
  onClaimWorkItem,
  onHeartbeatWorkItem,
  onReleaseWorkItem,
  onCompleteWorkItem,
  onFailWorkItem,
  routingExternalWorkId,
  busyWorkItemId,
  requestedScope,
  settingsToolMode = false,
}: {
  readonly channels: readonly Channel[];
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly artifactsByRun?: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly durableWorkItems?: readonly DurableWorkItemView[];
  readonly onRefresh: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
  readonly onOpenChannel: (channelId: string) => void;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly onClaimWorkItem?: (workItemId: string) => void;
  readonly onHeartbeatWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onReleaseWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onCompleteWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onFailWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly routingExternalWorkId?: string;
  readonly busyWorkItemId?: string;
  readonly requestedScope?: WorkBoardScope;
  readonly settingsToolMode?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const [channelFilter, setChannelFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<WorkItemStatus | "">("");
  const [sourceFilter, setSourceFilter] = useState<WorkItemSourceType | "">("");
  const [waitingFilter, setWaitingFilter] = useState<WorkItemWaitingReason | "">("");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [activeScope, setActiveScope] = useState<WorkBoardScope>("actionable");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState("");
  const appliedRequestedScopeRef = useRef<WorkBoardScope | undefined>();
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const items = useMemo(
    () => buildWorkItemViews({
      tasks,
      runs,
      approvals,
      workflowSteps,
      externalActions: externalActionDetails,
      externalWorkCiTriage,
      artifactsByRun,
      durableWorkItems,
    }),
    [approvals, artifactsByRun, durableWorkItems, externalActionDetails, externalWorkCiTriage, runs, tasks, workflowSteps],
  );
  const scopedItems = useMemo(
    () => filterByScope(items, activeScope),
    [activeScope, items],
  );
  const filtersActive = Boolean(channelFilter || statusFilter || sourceFilter || waitingFilter);
  const filteredItems = scopedItems.filter((item) =>
    (!channelFilter || item.channelId === channelFilter) &&
    (!statusFilter || item.status === statusFilter) &&
    (!sourceFilter || item.sourceType === sourceFilter) &&
    (!waitingFilter || item.waitingReason === waitingFilter)
  );
  const selectedItem = filteredItems.find((item) => item.id === selectedWorkItemId) ?? (filteredItems.length > 0 ? filteredItems[0] : undefined);
  const sourceOptions = [...new Set(scopedItems.map((item) => item.sourceType))].sort();
  const waitingOptions = [...new Set(scopedItems.map((item) => item.waitingReason).filter(Boolean))].sort() as WorkItemWaitingReason[];
  const stats = useMemo(() => readWorkBoardStats(items), [items]);
  const visibleGroups = useMemo(() => buildVisibleWorkBoardGroups(filteredItems, activeScope), [activeScope, filteredItems]);
  const settingsSummary = t("Work summary: {actionable} need action · {blocked} blocked · {active} active · {history} history", {
    actionable: stats.actionable,
    blocked: stats.blocked,
    active: stats.active,
    history: stats.completed,
  });
  const filterSummary = readFilterSummary({
    channelName: channelFilter ? channelById.get(channelFilter)?.name : undefined,
    statusFilter,
    sourceFilter,
    waitingFilter,
    t,
  });
  const selectScope = (scope: WorkBoardScope): void => {
    setActiveScope(scope);
    setSelectedWorkItemId("");
  };
  useEffect(() => {
    if (!requestedScope || requestedScope === appliedRequestedScopeRef.current) {
      return;
    }
    appliedRequestedScopeRef.current = requestedScope;
    setActiveScope(requestedScope);
    setSelectedWorkItemId("");
  }, [requestedScope]);
  const clearFilters = (): void => {
    setChannelFilter("");
    setStatusFilter("");
    setSourceFilter("");
    setWaitingFilter("");
    setFiltersExpanded(false);
  };
  const openHistoryScope = (): void => {
    selectScope("history");
  };
  const headerTitle = t(scopeTitle(activeScope));
  const headerDescription = t(scopeDescription(activeScope));
  const workBoardTabs = (
    <div className="work-board-tabs" aria-label={t("Work board views")}>
      {workBoardScopeOrder.map((scope) => (
        <button
          key={scope}
          type="button"
          className={activeScope === scope ? "active" : ""}
          aria-pressed={activeScope === scope}
          onClick={() => selectScope(scope)}
        >
          {t(scopeLabel(scope))}
        </button>
      ))}
    </div>
  );
  const filterToggleButton = (
    <button className="secondary-button compact-button" type="button" onClick={() => setFiltersExpanded((current) => !current)}>
      <ListFilter size={14} />
      {filtersExpanded ? t("Hide filters") : t("Show filters")}
    </button>
  );
  const clearFiltersButton = filtersActive ? (
    <button className="text-button" type="button" onClick={clearFilters}>
      {t("Clear filters")}
    </button>
  ) : null;
  const filterControls = (
    <div className="work-board-filters">
      <label>
        <span>{t("Channel")}</span>
        <select value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)}>
          <option value="">{t("All")}</option>
          {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </select>
      </label>
      <label>
        <span>{t("Status")}</span>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as WorkItemStatus | "")}>
          <option value="">{t("All")}</option>
          {workItemStatusOrder.map((status) => <option key={status} value={status}>{t(workItemStatusLabel(status))}</option>)}
        </select>
      </label>
      <label>
        <span>{t("Source")}</span>
        <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as WorkItemSourceType | "")}>
          <option value="">{t("All")}</option>
          {sourceOptions.map((source) => <option key={source} value={source}>{t(source)}</option>)}
        </select>
      </label>
      <label>
        <span>{t("Waiting reason")}</span>
        <select value={waitingFilter} onChange={(event) => setWaitingFilter(event.target.value as WorkItemWaitingReason | "")}>
          <option value="">{t("All")}</option>
          {waitingOptions.map((reason) => <option key={reason} value={reason}>{t(reason)}</option>)}
        </select>
      </label>
    </div>
  );

  return (
    <section
      className={settingsToolMode ? "panel work-board-page settings-return-mode" : "panel work-board-page"}
      aria-label={settingsToolMode ? headerTitle : undefined}
      aria-labelledby={settingsToolMode ? undefined : "global-work-board-title"}
    >
      {!settingsToolMode ? (
        <PageActionHeader
          title={<span id="global-work-board-title">{headerTitle}</span>}
          description={headerDescription}
          meta={(
            <div className="work-board-count-line">
              <button className={activeScope === "actionable" ? "active" : ""} type="button" onClick={() => selectScope("actionable")}>{t("{count} need action", { count: stats.actionable })}</button>
              <button className={activeScope === "global" ? "active" : ""} type="button" onClick={() => selectScope("global")}>{t("{count} running", { count: stats.running })}</button>
              <button className={activeScope === "blocked" ? "active" : ""} type="button" onClick={() => selectScope("blocked")}>{t("{count} blocked or failed", { count: stats.blocked })}</button>
              <button className={activeScope === "history" ? "active" : ""} type="button" onClick={() => selectScope("history")}>{t("{count} recently completed", { count: stats.completed })}</button>
            </div>
          )}
          secondaryActions={(
            <button className="secondary-button compact-button" type="button" onClick={onRefresh}>
              <RefreshCw size={15} />
              {t("Refresh")}
            </button>
          )}
          className="work-board-page-header"
        />
      ) : null}
      <div className="work-board-shell">
        <div className="work-board-list-pane">
          <div className={settingsToolMode ? "work-board-toolbar settings-tool-mode" : "work-board-toolbar"}>
            {settingsToolMode ? (
              <div className="work-board-settings-toolbar">
                {workBoardTabs}
                <span className="work-board-settings-summary" title={settingsSummary}>{settingsSummary}</span>
                {filterToggleButton}
                {clearFiltersButton}
                <button className="secondary-button compact-button" type="button" onClick={onRefresh}>
                  <RefreshCw size={15} />
                  {t("Refresh")}
                </button>
              </div>
            ) : (
              <>
                {workBoardTabs}
              </>
            )}
          </div>

          {settingsToolMode ? (
            filtersExpanded ? (
              <div className="work-board-filter-card settings-tool-mode expanded">
                {filterControls}
              </div>
            ) : null
          ) : (
            <div className={filtersExpanded ? "work-board-filter-card expanded" : "work-board-filter-card"}>
              <div className="work-board-filter-bar">
                {filterToggleButton}
                <span>{filtersActive ? t("Current filters: {summary}", { summary: filterSummary }) : t("Showing all work items")}</span>
                {clearFiltersButton}
              </div>
              {filtersExpanded ? filterControls : null}
            </div>
          )}

          {filteredItems.length === 0 ? (
            <WorkBoardEmptyState
              scopedCount={scopedItems.length}
              filtersActive={filtersActive}
              activeScope={activeScope}
              channelFilter={channelFilter}
              channelName={channelFilter ? channelById.get(channelFilter)?.name : undefined}
              onClearFilters={clearFilters}
              onViewHistory={openHistoryScope}
              onOpenChannel={channelFilter ? () => onOpenChannel(channelFilter) : undefined}
            />
          ) : (
            <div className="work-board-groups">
              {visibleGroups.map(({ key, label, items: group }) => {
                if (group.length === 0) {
                  return null;
                }
                return (
                  <section key={key} className="work-board-group">
                    <div className="work-board-group-head">
                      <strong>{t(label)}</strong>
                      <span>{group.length}</span>
                    </div>
                    <div className="work-board-list">
                      {group.map((item) => (
                        <WorkItemRow
                          key={item.id}
                          item={item}
                          selected={selectedItem?.id === item.id}
                          channelName={item.channelId ? channelById.get(item.channelId)?.name : undefined}
                          onSelect={setSelectedWorkItemId}
                          onOpenTask={onOpenTask}
                          onOpenRun={onOpenRun}
                          onOpenApproval={onOpenApproval}
                          onOpenExternalWork={item.channelId ? () => onOpenChannel(item.channelId as string) : undefined}
                          routeChannels={channels}
                          routing={item.externalWorkId === routingExternalWorkId}
                          onRouteExternalWork={onRouteExternalWork}
                          onClaimWorkItem={onClaimWorkItem}
                          onHeartbeatWorkItem={onHeartbeatWorkItem}
                          onReleaseWorkItem={onReleaseWorkItem}
                          onCompleteWorkItem={onCompleteWorkItem}
                          onFailWorkItem={onFailWorkItem}
                          busyWorkItemId={busyWorkItemId}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
        <WorkItemDetailDrawer
          item={selectedItem}
          activeScope={activeScope}
          scopedCount={scopedItems.length}
          filtersActive={filtersActive}
          onClearFilters={clearFilters}
          onViewHistory={openHistoryScope}
          channels={channels}
          channelName={selectedItem?.channelId ? channelById.get(selectedItem.channelId)?.name : undefined}
          routing={selectedItem?.externalWorkId === routingExternalWorkId}
          busyWorkItemId={busyWorkItemId}
          onOpenTask={onOpenTask}
          onOpenRun={onOpenRun}
          onOpenApproval={onOpenApproval}
          onOpenChannel={onOpenChannel}
          onRouteExternalWork={onRouteExternalWork}
          onClaimWorkItem={onClaimWorkItem}
          onHeartbeatWorkItem={onHeartbeatWorkItem}
          onReleaseWorkItem={onReleaseWorkItem}
          onCompleteWorkItem={onCompleteWorkItem}
          onFailWorkItem={onFailWorkItem}
        />
      </div>
    </section>
  );
}

function WorkBoardEmptyState({
  scopedCount,
  filtersActive,
  activeScope,
  channelFilter,
  channelName,
  onClearFilters,
  onViewHistory,
  onOpenChannel,
}: {
  readonly scopedCount: number;
  readonly filtersActive: boolean;
  readonly activeScope: WorkBoardScope;
  readonly channelFilter: string;
  readonly channelName?: string;
  readonly onClearFilters: () => void;
  readonly onViewHistory: () => void;
  readonly onOpenChannel?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const title = scopedCount === 0
    ? activeScope === "actionable"
      ? t("No work needs your attention")
      : t("No work items in this view")
    : filtersActive
      ? t("No work items match these filters")
      : t("No work items to show");
  const description = scopedCount === 0
    ? activeScope === "actionable"
      ? t("When approvals, failed runs, blockers, or claimable work appear, they will show up here.")
      : t("This view is empty right now. You can switch views or inspect completed history.")
    : t("Try clearing filters or opening the related channel to continue.");
  const actions = (
    <>
      {filtersActive ? (
        <button className="secondary-button compact-button" type="button" onClick={onClearFilters}>
          {t("Clear filters")}
        </button>
      ) : null}
      {activeScope !== "history" ? (
        <button className="secondary-button compact-button" type="button" onClick={onViewHistory}>
          {t("View history")}
        </button>
      ) : null}
      {channelFilter && onOpenChannel ? (
        <button className="secondary-button compact-button" type="button" onClick={onOpenChannel}>
          <ExternalLink size={14} />
          {channelName ? t("Open {channelName}", { channelName }) : t("Open channel")}
        </button>
      ) : null}
    </>
  );

  return (
    <OperationEmptyState
      compact
      className="work-board-empty-state"
      icon={<ClipboardList size={22} />}
      title={title}
      description={description}
      action={actions}
    />
  );
}

function filterByScope(items: readonly WorkItemView[], scope: WorkBoardScope): WorkItemView[] {
  if (scope === "actionable") {
    return items.filter(isActionableWorkItem);
  }
  if (scope === "channel") {
    return items.filter((item) => Boolean(item.channelId) && !isTerminalWorkItemView(item));
  }
  if (scope === "mine") {
    return items.filter((item) => Boolean(item.assigneeTeammateId || item.claim) && !isTerminalWorkItemView(item));
  }
  if (scope === "blocked") {
    return items.filter((item) => item.status === "blocked" || item.status === "waiting");
  }
  if (scope === "history") {
    return items.filter(isTerminalWorkItemView);
  }
  return items.filter((item) => !isTerminalWorkItemView(item));
}

function scopeLabel(scope: WorkBoardScope): string {
  if (scope === "actionable") {
    return "Needs action";
  }
  if (scope === "channel") {
    return "Channel scope";
  }
  if (scope === "mine") {
    return "Mine";
  }
  if (scope === "blocked") {
    return "Blocked work";
  }
  if (scope === "history") {
    return "History";
  }
  return "All active";
}

function scopeTitle(scope: WorkBoardScope): string {
  if (scope === "global") {
    return "All active work";
  }
  if (scope === "channel") {
    return "Channel work";
  }
  if (scope === "mine") {
    return "My work";
  }
  if (scope === "blocked") {
    return "Blocked work";
  }
  if (scope === "history") {
    return "Work history";
  }
  return "Needs action";
}

function scopeDescription(scope: WorkBoardScope): string {
  if (scope === "global") {
    return "All non-finished work across channels, runs, approvals, and durable work.";
  }
  if (scope === "channel") {
    return "Active work that is attached to a channel.";
  }
  if (scope === "mine") {
    return "Work assigned to a teammate or currently claimed.";
  }
  if (scope === "blocked") {
    return "Blocked, failed, or waiting work that needs recovery.";
  }
  if (scope === "history") {
    return "Recently finished work grouped by completion date.";
  }
  return "Action inbox across channels, runs, approvals, and durable work.";
}

function readWorkBoardStats(items: readonly WorkItemView[]): {
  readonly actionable: number;
  readonly active: number;
  readonly running: number;
  readonly blocked: number;
  readonly completed: number;
} {
  return {
    actionable: items.filter(isActionableWorkItem).length,
    active: items.filter((item) => !isTerminalWorkItemView(item)).length,
    running: items.filter((item) => item.status === "running").length,
    blocked: items.filter((item) => item.status === "blocked" || item.status === "waiting").length,
    completed: items.filter(isTerminalWorkItemView).length,
  };
}

function readFilterSummary({
  channelName,
  statusFilter,
  sourceFilter,
  waitingFilter,
  t,
}: {
  readonly channelName?: string;
  readonly statusFilter: WorkItemStatus | "";
  readonly sourceFilter: WorkItemSourceType | "";
  readonly waitingFilter: WorkItemWaitingReason | "";
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
}): string {
  const parts = [
    channelName ? t("Channel: {value}", { value: channelName }) : undefined,
    statusFilter ? t("Status: {value}", { value: t(workItemStatusLabel(statusFilter)) }) : undefined,
    sourceFilter ? t("Source: {value}", { value: t(sourceFilter) }) : undefined,
    waitingFilter ? t("Waiting: {value}", { value: t(waitingFilter) }) : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

function buildVisibleWorkBoardGroups(items: readonly WorkItemView[], activeScope: WorkBoardScope): ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly items: readonly WorkItemView[];
}> {
  if (activeScope === "history") {
    const groups = new Map<string, WorkItemView[]>();
    for (const item of [...items].sort(compareWorkItemUpdatedDesc)) {
      const key = readWorkItemDateKey(item.updatedAt);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()].map(([key, groupItems]) => ({
      key,
      label: key === "unknown" ? "Unknown date" : key,
      items: groupItems,
    }));
  }
  return workItemActionGroupOrder
    .map((groupKey) => ({
      key: groupKey,
      label: workItemActionGroupLabel(groupKey),
      items: items.filter((item) => workItemActionGroup(item) === groupKey).sort(compareWorkItemUpdatedDesc),
    }))
    .filter((group) => group.items.length > 0);
}

function compareWorkItemUpdatedDesc(left: WorkItemView, right: WorkItemView): number {
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

function readWorkItemDateKey(value: string): string {
  return value.includes("T") ? value.slice(0, 10) : value || "unknown";
}

function WorkItemDetailDrawer({
  item,
  activeScope,
  scopedCount,
  filtersActive,
  onClearFilters,
  onViewHistory,
  channels,
  channelName,
  routing,
  busyWorkItemId,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
  onOpenChannel,
  onRouteExternalWork,
  onClaimWorkItem,
  onHeartbeatWorkItem,
  onReleaseWorkItem,
  onCompleteWorkItem,
  onFailWorkItem,
}: {
  readonly item?: WorkItemView;
  readonly activeScope: WorkBoardScope;
  readonly scopedCount: number;
  readonly filtersActive: boolean;
  readonly onClearFilters: () => void;
  readonly onViewHistory: () => void;
  readonly channels: readonly Channel[];
  readonly channelName?: string;
  readonly routing?: boolean;
  readonly busyWorkItemId?: string;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
  readonly onOpenChannel: (channelId: string) => void;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly onClaimWorkItem?: (workItemId: string) => void;
  readonly onHeartbeatWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onReleaseWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onCompleteWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onFailWorkItem?: (workItemId: string, claimToken: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [routeChannelId, setRouteChannelId] = useState("");

  if (!item) {
    return (
      <aside className="work-board-detail empty guide" aria-label={t("Work detail")}>
        <OperationEmptyState
          compact
          icon={<ClipboardList size={22} />}
          title={t("Work handling guide")}
          description={scopedCount === 0 && activeScope === "actionable"
            ? t("You are clear for now. This panel explains where new work will appear.")
            : t("Use the left list to choose a work item, or use the shortcuts below to recover context.")}
        />
        <div className="work-board-guide-list">
          <span>
            <strong>{t("Approvals land in Inbox")}</strong>
            <small>{t("High-risk local actions and external confirmations wait for your decision there.")}</small>
          </span>
          <span>
            <strong>{t("Failures land in Needs action")}</strong>
            <small>{t("Blocked runs and claimable durable work stay visible until handled.")}</small>
          </span>
          <span>
            <strong>{t("Finished work moves to History")}</strong>
            <small>{t("Use history when you need evidence, artifacts, or completed run context.")}</small>
          </span>
        </div>
        <div className="work-board-empty-actions">
          {filtersActive ? (
            <button className="secondary-button compact-button" type="button" onClick={onClearFilters}>
              {t("Clear filters")}
            </button>
          ) : null}
          {activeScope !== "history" ? (
            <button className="secondary-button compact-button" type="button" onClick={onViewHistory}>
              {t("View history work")}
            </button>
          ) : null}
        </div>
      </aside>
    );
  }

  const targetChannelId = routeChannelId || item.channelId || "";
  const canRoute = Boolean(item.externalWorkId && onRouteExternalWork && channels.length > 1);
  const busy = busyWorkItemId === item.id;
  const canClaim = Boolean(item.durable && !item.claim && !isTerminalWorkItemView(item) && onClaimWorkItem);
  const canHeartbeat = Boolean(item.durable && item.claim?.token && onHeartbeatWorkItem);
  const canRelease = Boolean(item.durable && item.claim?.token && onReleaseWorkItem);
  const canComplete = Boolean(item.durable && item.claim?.token && onCompleteWorkItem && !isTerminalWorkItemView(item));
  const canFail = Boolean(item.durable && item.claim?.token && onFailWorkItem && !isTerminalWorkItemView(item));
  const owner = item.claim?.ownerId ?? item.assigneeTeammateId ?? t("Unassigned");
  const linkedObjects = [
    item.runId ? { key: "run", label: t("Run"), value: item.runId, icon: <SquareTerminal size={14} />, onClick: () => onOpenRun(item.runId as string) } : undefined,
    item.taskId ? { key: "task", label: t("Task"), value: item.taskId, icon: <ExternalLink size={14} />, onClick: () => onOpenTask(item.taskId as string) } : undefined,
    item.approvalId ? { key: "approval", label: t("Approval"), value: item.approvalId, icon: <Inbox size={14} />, onClick: () => onOpenApproval(item.approvalId as string) } : undefined,
    item.channelId ? { key: "channel", label: t("Channel"), value: channelName ?? item.channelId, icon: <ExternalLink size={14} />, onClick: () => onOpenChannel(item.channelId as string) } : undefined,
  ].filter(Boolean) as Array<{ readonly key: string; readonly label: string; readonly value: string; readonly icon: JSX.Element; readonly onClick: () => void }>;

  return (
    <aside className="work-board-detail" aria-label={t("Work detail")}>
      <div className="work-board-detail-head">
        <span className="work-board-detail-id">{item.id}</span>
        <h3>{item.title}</h3>
        <div className="work-board-detail-badges">
          <StatusBadge status={item.status} />
          <span>{t(item.priority)}</span>
          {item.waitingReason ? <span>{t(item.waitingReason)}</span> : null}
        </div>
      </div>

      <DetailSection title={t("Next action")} icon={<CircleAlert size={14} />}>
        <p>{t(workItemNextActionLabel(item))}{item.subtitle ? ` · ${item.subtitle}` : ""}</p>
      </DetailSection>

      <div className="work-board-detail-actions primary">
        {item.approvalId ? (
          <button className="primary-button compact-button" type="button" onClick={() => onOpenApproval(item.approvalId as string)}>
            <Inbox size={14} />
            {t("Handle approval")}
          </button>
        ) : item.status === "blocked" && item.runId ? (
          <button className="primary-button compact-button" type="button" onClick={() => onOpenRun(item.runId as string)}>
            <CircleAlert size={14} />
            {t("View failure")}
          </button>
        ) : item.runId ? (
          <button className="primary-button compact-button" type="button" onClick={() => onOpenRun(item.runId as string)}>
            <SquareTerminal size={14} />
            {t("View run")}
          </button>
        ) : item.taskId ? (
          <button className="primary-button compact-button" type="button" onClick={() => onOpenTask(item.taskId as string)}>
            <ExternalLink size={14} />
            {t("Open task")}
          </button>
        ) : item.channelId ? (
          <button className="primary-button compact-button" type="button" onClick={() => onOpenChannel(item.channelId as string)}>
            <ExternalLink size={14} />
            {t("Open channel")}
          </button>
        ) : null}
        {canClaim ? (
          <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onClaimWorkItem?.(item.id)}>
            <UserCheck size={14} />
            {busy ? t("Claiming") : t("Claim")}
          </button>
        ) : null}
      </div>

      <div className="work-board-detail-meta">
        <DetailField label={t("Owner")} value={owner} />
        <DetailField label={t("Channel")} value={channelName ?? item.channelId ?? "-"} />
        <DetailField label={t("Source")} value={t(item.sourceType)} />
        <DetailField label={t("Updated")} value={formatDateTime(item.updatedAt)} />
      </div>

      <DetailDisclosure title={t("Linked objects")} icon={<ExternalLink size={14} />}>
        {linkedObjects.length === 0 ? (
          <p>{t("No linked objects")}</p>
        ) : (
          <div className="work-board-linked-list">
            {linkedObjects.map((link) => (
              <button key={link.key} className="work-board-linked-row" type="button" onClick={link.onClick}>
                {link.icon}
                <span>{link.label}</span>
                <strong>{link.value}</strong>
              </button>
            ))}
          </div>
        )}
      </DetailDisclosure>

      <DetailDisclosure title={t("Diagnostics")} icon={<ClipboardList size={14} />}>
        <div className="work-board-diagnostics">
          <DetailField label={t("Created")} value={formatDateTime(item.createdAt)} />
          <DetailField label={t("Attempts")} value={item.attemptCount !== undefined && item.retryBudget !== undefined ? `${item.attemptCount}/${item.retryBudget}` : "-"} />
          <DetailField label={t("Artifacts")} value={String(item.artifactIds.length)} />
          <DetailField label={t("Proof artifacts")} value={String(item.proofArtifactIds.length)} />
        </div>
        {item.labels.length > 0 ? (
          <div className="work-item-labels">
            {item.labels.map((label) => <span key={label}>{label}</span>)}
          </div>
        ) : null}
      </DetailDisclosure>

      {canRoute ? (
        <div className="work-board-detail-route">
          <select
            aria-label={t("Route to channel")}
            value={targetChannelId}
            disabled={routing}
            onChange={(event) => setRouteChannelId(event.target.value)}
          >
            {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
          </select>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={routing || !targetChannelId || targetChannelId === item.channelId}
            onClick={() => item.externalWorkId && onRouteExternalWork?.(item.externalWorkId, targetChannelId)}
          >
            <Route size={14} />
            {routing ? t("Routing") : t("Route")}
          </button>
        </div>
      ) : null}

      <div className="work-board-detail-actions">
        {item.channelId ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenChannel(item.channelId as string)}>
            <ExternalLink size={14} />
            {t("Open channel")}
          </button>
        ) : null}
        {item.approvalId ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenApproval(item.approvalId as string)}>
            <Inbox size={14} />
            {t("Open approval")}
          </button>
        ) : null}
        {canHeartbeat && item.claim ? (
          <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onHeartbeatWorkItem?.(item.id, item.claim?.token as string)}>
            <RefreshCw size={14} />
            {busy ? t("Refreshing") : t("Refresh claim")}
          </button>
        ) : null}
        {canRelease && item.claim ? (
          <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onReleaseWorkItem?.(item.id, item.claim?.token as string)}>
            <XCircle size={14} />
            {busy ? t("Releasing") : t("Release claim")}
          </button>
        ) : null}
        {canComplete && item.claim ? (
          <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onCompleteWorkItem?.(item.id, item.claim?.token as string)}>
            <CheckCircle2 size={14} />
            {busy ? t("Completing") : t("Mark done")}
          </button>
        ) : null}
        {canFail && item.claim ? (
          <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onFailWorkItem?.(item.id, item.claim?.token as string)}>
            <CircleAlert size={14} />
            {busy ? t("Marking failed") : t("Mark failed")}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

function DetailDisclosure({
  title,
  icon,
  children,
}: {
  readonly title: string;
  readonly icon: JSX.Element;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <details className="work-board-detail-section work-board-detail-disclosure">
      <summary>{icon}<span>{title}</span></summary>
      <div className="work-board-detail-disclosure-body">{children}</div>
    </details>
  );
}


function DetailSection({
  title,
  icon,
  children,
}: {
  readonly title: string;
  readonly icon: JSX.Element;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="work-board-detail-section">
      <h4>{icon}{title}</h4>
      {children}
    </section>
  );
}

function DetailField({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <span className="work-board-detail-field">
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}
