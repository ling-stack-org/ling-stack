import { useMemo, useState, type ReactNode } from "react";
import { CircleAlert, ClipboardList, ExternalLink, Inbox, Kanban, RefreshCw, Route, SquareTerminal, UserCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { buildWorkItemViews, workItemStatusOrder, workItemStatusLabel, type WorkItemSourceType, type WorkItemStatus, type WorkItemView, type WorkItemWaitingReason } from "../../lib/work-items.js";
import { StatusBadge } from "../../shared/components/index.js";
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

type WorkBoardScope = "global" | "channel" | "mine" | "blocked";

const workBoardScopeOrder: readonly WorkBoardScope[] = ["global", "channel", "mine", "blocked"];

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
  routingExternalWorkId,
  busyWorkItemId,
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
  readonly routingExternalWorkId?: string;
  readonly busyWorkItemId?: string;
}): JSX.Element {
  const { t } = useI18n();
  const [channelFilter, setChannelFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<WorkItemStatus | "">("");
  const [sourceFilter, setSourceFilter] = useState<WorkItemSourceType | "">("");
  const [waitingFilter, setWaitingFilter] = useState<WorkItemWaitingReason | "">("");
  const [activeScope, setActiveScope] = useState<WorkBoardScope>("global");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState("");
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
  const filteredItems = scopedItems.filter((item) =>
    (!channelFilter || item.channelId === channelFilter) &&
    (!statusFilter || item.status === statusFilter) &&
    (!sourceFilter || item.sourceType === sourceFilter) &&
    (!waitingFilter || item.waitingReason === waitingFilter)
  );
  const selectedItem = filteredItems.find((item) => item.id === selectedWorkItemId) ?? filteredItems[0];
  const sourceOptions = [...new Set(scopedItems.map((item) => item.sourceType))].sort();
  const waitingOptions = [...new Set(scopedItems.map((item) => item.waitingReason).filter(Boolean))].sort() as WorkItemWaitingReason[];
  const stats = useMemo(() => readWorkBoardStats(scopedItems), [scopedItems]);

  return (
    <section className="panel work-board-page" aria-labelledby="global-work-board-title">
      <div className="panel-title split">
        <span className="work-board-heading">
          <Kanban size={18} />
          <span>
            <h2 id="global-work-board-title">{t("Work Board")}</h2>
            <small>{t("Global work ledger")}</small>
          </span>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh}>
          <RefreshCw size={15} />
          {t("Refresh")}
        </button>
      </div>
      <div className="work-board-shell">
        <div className="work-board-list-pane">
          <div className="work-board-toolbar">
            <div className="work-board-tabs" aria-label={t("Work board views")}>
              {workBoardScopeOrder.map((scope) => (
                <button
                  key={scope}
                  type="button"
                  className={activeScope === scope ? "active" : ""}
                  aria-pressed={activeScope === scope}
                  onClick={() => {
                    setActiveScope(scope);
                    setSelectedWorkItemId("");
                  }}
                >
                  {t(scopeLabel(scope))}
                </button>
              ))}
            </div>
            <div className="work-board-count-line">
              <span>{t("{count} visible work items", { count: filteredItems.length })}</span>
              <span>{t("{count} unassigned", { count: stats.unassigned })}</span>
              <span>{t("{count} waiting", { count: stats.waiting })}</span>
              <span>{t("{count} blocked", { count: stats.blocked })}</span>
            </div>
          </div>

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

          {filteredItems.length === 0 ? (
            <div className="client-empty-state compact-empty"><Kanban /><span>{t("No work items match these filters")}</span></div>
          ) : (
            <div className="work-board-groups">
              {workItemStatusOrder.map((status) => {
                const group = filteredItems.filter((item) => item.status === status);
                if (group.length === 0) {
                  return null;
                }
                return (
                  <section key={status} className="work-board-group">
                    <div className="work-board-group-head">
                      <strong>{t(workItemStatusLabel(status))}</strong>
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
        />
      </div>
    </section>
  );
}

function filterByScope(items: readonly WorkItemView[], scope: WorkBoardScope): WorkItemView[] {
  if (scope === "channel") {
    return items.filter((item) => Boolean(item.channelId));
  }
  if (scope === "mine") {
    return items.filter((item) => Boolean(item.assigneeTeammateId || item.claim));
  }
  if (scope === "blocked") {
    return items.filter((item) => item.status === "blocked" || item.status === "waiting");
  }
  return [...items];
}

function scopeLabel(scope: WorkBoardScope): string {
  if (scope === "channel") {
    return "Channel scope";
  }
  if (scope === "mine") {
    return "Mine";
  }
  if (scope === "blocked") {
    return "Blocked work";
  }
  return "Global";
}

function readWorkBoardStats(items: readonly WorkItemView[]): {
  readonly unassigned: number;
  readonly waiting: number;
  readonly blocked: number;
} {
  return {
    unassigned: items.filter((item) => !item.channelId && !item.assigneeTeammateId && !item.claim).length,
    waiting: items.filter((item) => item.status === "waiting").length,
    blocked: items.filter((item) => item.status === "blocked").length,
  };
}

function WorkItemDetailDrawer({
  item,
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
}: {
  readonly item?: WorkItemView;
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
}): JSX.Element {
  const { t } = useI18n();
  const [routeChannelId, setRouteChannelId] = useState("");

  if (!item) {
    return (
      <aside className="work-board-detail empty" aria-label={t("Work detail")}>
        <ClipboardList size={22} />
        <strong>{t("No work item selected")}</strong>
        <p>{t("Select a row to inspect its linked run, approval, channel, and diagnostics.")}</p>
      </aside>
    );
  }

  const targetChannelId = routeChannelId || item.channelId || "";
  const canRoute = Boolean(item.externalWorkId && onRouteExternalWork && channels.length > 1);
  const busy = busyWorkItemId === item.id;
  const canClaim = Boolean(item.durable && !item.claim && !isTerminalWorkItem(item) && onClaimWorkItem);
  const canHeartbeat = Boolean(item.durable && item.claim?.token && onHeartbeatWorkItem);
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

      <div className="work-board-detail-meta">
        <DetailField label={t("Owner")} value={owner} />
        <DetailField label={t("Channel")} value={channelName ?? item.channelId ?? "-"} />
        <DetailField label={t("Source")} value={t(item.sourceType)} />
        <DetailField label={t("Updated")} value={formatDateTime(item.updatedAt)} />
      </div>

      <DetailSection title={t("Current status")} icon={<CircleAlert size={14} />}>
        <p>{item.subtitle || t("No status summary available")}</p>
      </DetailSection>

      <DetailSection title={t("Linked objects")} icon={<ExternalLink size={14} />}>
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
      </DetailSection>

      <DetailSection title={t("Diagnostics")} icon={<ClipboardList size={14} />}>
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
      </DetailSection>

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
        {item.runId ? (
          <button className="primary-button compact-button" type="button" onClick={() => onOpenRun(item.runId as string)}>
            <SquareTerminal size={14} />
            {t("View run")}
          </button>
        ) : null}
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
        {canClaim ? (
          <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onClaimWorkItem?.(item.id)}>
            <UserCheck size={14} />
            {busy ? t("Claiming") : t("Claim")}
          </button>
        ) : null}
        {canHeartbeat && item.claim ? (
          <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onHeartbeatWorkItem?.(item.id, item.claim?.token as string)}>
            <RefreshCw size={14} />
            {busy ? t("Refreshing") : t("Heartbeat")}
          </button>
        ) : null}
      </div>
    </aside>
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

function isTerminalWorkItem(item: WorkItemView): boolean {
  return item.status === "done" || item.status === "archived";
}
