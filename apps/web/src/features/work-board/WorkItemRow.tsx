import { useState } from "react";
import { CircleAlert, Clock3, ExternalLink, GitPullRequest, Loader2, Route, ShieldCheck, SquareTerminal, UserCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { WorkItemView } from "../../lib/work-items.js";
import type { Channel } from "../../types.js";
import { StatusBadge } from "../../shared/components/index.js";

export function WorkItemRow({
  item,
  channelName,
  routeChannels = [],
  selected = false,
  routing,
  onSelect,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
  onOpenExternalWork,
  onRouteExternalWork,
  onClaimWorkItem,
  onHeartbeatWorkItem,
  busyWorkItemId,
}: {
  readonly item: WorkItemView;
  readonly channelName?: string;
  readonly routeChannels?: readonly Channel[];
  readonly selected?: boolean;
  readonly routing?: boolean;
  readonly onSelect?: (workItemId: string) => void;
  readonly onOpenTask?: (taskId: string) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenApproval?: (approvalId: string) => void;
  readonly onOpenExternalWork?: (externalWorkId: string) => void;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly onClaimWorkItem?: (workItemId: string) => void;
  readonly onHeartbeatWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly busyWorkItemId?: string;
}): JSX.Element {
  const { t } = useI18n();
  const [routeChannelId, setRouteChannelId] = useState("");
  const primaryAction = primaryOpenAction(item, { onOpenTask, onOpenRun, onOpenApproval, onOpenExternalWork });
  const canRoute = Boolean(item.externalWorkId && onRouteExternalWork && routeChannels.length > 1);
  const targetChannelId = routeChannelId || item.channelId || "";
  const busy = busyWorkItemId === item.id;
  const canClaim = Boolean(item.durable && !item.claim && !isTerminalWorkItem(item) && onClaimWorkItem);
  const canHeartbeat = Boolean(item.durable && item.claim?.token && onHeartbeatWorkItem);
  const handleSelect = (): void => onSelect?.(item.id);
  return (
    <article
      className={`work-item-row ${item.status}${selected ? " selected" : ""}${onSelect ? " selectable" : ""}`}
      aria-label={item.title}
      aria-pressed={selected}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={handleSelect}
      onKeyDown={(event) => {
        if (!onSelect || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        event.preventDefault();
        handleSelect();
      }}
    >
      <div className="work-item-main">
        <div className="work-item-title-row">
          {workItemIcon(item)}
          <strong>{item.title}</strong>
          <StatusBadge status={item.status} />
        </div>
        {item.subtitle ? <p>{item.subtitle}</p> : null}
        <div className="provider-meta-line">
          <span>{t(item.sourceType)}</span>
          {item.durable ? <span>{t("durable")}</span> : null}
          {channelName ? <span>#{channelName}</span> : null}
          {item.waitingReason ? <span>{t("waiting: {reason}", { reason: t(item.waitingReason) })}</span> : null}
          <span>{t(item.priority)}</span>
          {item.claim ? <span>{t("claimed by {owner}", { owner: item.claim.ownerId })}</span> : null}
          {item.attemptCount !== undefined && item.retryBudget !== undefined ? (
            <span>{t("attempt {count}/{budget}", { count: item.attemptCount, budget: item.retryBudget })}</span>
          ) : null}
          <time>{formatDateTime(item.updatedAt)}</time>
        </div>
        {item.labels.length > 0 ? (
          <div className="work-item-labels">
            {item.labels.slice(0, 5).map((label) => <span key={label}>{label}</span>)}
          </div>
        ) : null}
      </div>
      <div
        className="work-item-actions"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {canClaim ? (
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={busy}
            onClick={() => onClaimWorkItem?.(item.id)}
          >
            {busy ? <Loader2 className="spin" size={14} /> : <UserCheck size={14} />}
            {busy ? t("Claiming") : t("Claim")}
          </button>
        ) : null}
        {canHeartbeat && item.claim ? (
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={busy}
            onClick={() => onHeartbeatWorkItem?.(item.id, item.claim?.token as string)}
          >
            {busy ? <Loader2 className="spin" size={14} /> : <Clock3 size={14} />}
            {busy ? t("Refreshing") : t("Heartbeat")}
          </button>
        ) : null}
        {canRoute ? (
          <div className="work-item-route-control">
            <select
              aria-label={t("Route to channel")}
              value={targetChannelId}
              disabled={routing}
              onChange={(event) => setRouteChannelId(event.target.value)}
            >
              {routeChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
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
        {primaryAction ? (
          <button className="secondary-button compact-button" type="button" onClick={primaryAction.onClick}>
            {primaryAction.icon}
            {t(primaryAction.label)}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function isTerminalWorkItem(item: WorkItemView): boolean {
  return item.status === "done" || item.status === "archived";
}

function primaryOpenAction(
  item: WorkItemView,
  actions: {
    readonly onOpenTask?: (taskId: string) => void;
    readonly onOpenRun?: (runId: string) => void;
    readonly onOpenApproval?: (approvalId: string) => void;
    readonly onOpenExternalWork?: (externalWorkId: string) => void;
  },
): { readonly label: string; readonly icon: JSX.Element; readonly onClick: () => void } | undefined {
  if (item.approvalId && actions.onOpenApproval) {
    return { label: "Review", icon: <ShieldCheck size={14} />, onClick: () => actions.onOpenApproval?.(item.approvalId as string) };
  }
  if (item.runId && actions.onOpenRun) {
    return { label: "Open run", icon: <SquareTerminal size={14} />, onClick: () => actions.onOpenRun?.(item.runId as string) };
  }
  if (item.taskId && actions.onOpenTask) {
    return { label: "Open task", icon: <ExternalLink size={14} />, onClick: () => actions.onOpenTask?.(item.taskId as string) };
  }
  if (item.externalWorkId && actions.onOpenExternalWork) {
    return { label: "Open work", icon: <ExternalLink size={14} />, onClick: () => actions.onOpenExternalWork?.(item.externalWorkId as string) };
  }
  return undefined;
}

function workItemIcon(item: WorkItemView): JSX.Element {
  if (item.waitingReason === "approval") {
    return <ShieldCheck size={15} />;
  }
  if (item.status === "blocked") {
    return <CircleAlert size={15} />;
  }
  if (item.sourceType.startsWith("external")) {
    return <GitPullRequest size={15} />;
  }
  return <Clock3 size={15} />;
}
