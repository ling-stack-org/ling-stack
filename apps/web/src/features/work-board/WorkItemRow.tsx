import { CircleAlert, Clock3, ExternalLink, GitPullRequest, ShieldCheck, SquareTerminal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { WorkItemView } from "../../lib/work-items.js";
import { StatusBadge } from "../../shared/components/index.js";

export function WorkItemRow({
  item,
  channelName,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
  onOpenExternalWork,
}: {
  readonly item: WorkItemView;
  readonly channelName?: string;
  readonly onOpenTask?: (taskId: string) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenApproval?: (approvalId: string) => void;
  readonly onOpenExternalWork?: (externalWorkId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const primaryAction = primaryOpenAction(item, { onOpenTask, onOpenRun, onOpenApproval, onOpenExternalWork });
  return (
    <article className={`work-item-row ${item.status}`} aria-label={item.title}>
      <div className="work-item-main">
        <div className="work-item-title-row">
          {workItemIcon(item)}
          <strong>{item.title}</strong>
          <StatusBadge status={item.status} />
        </div>
        {item.subtitle ? <p>{item.subtitle}</p> : null}
        <div className="provider-meta-line">
          <span>{item.sourceType}</span>
          {channelName ? <span>#{channelName}</span> : null}
          {item.waitingReason ? <span>{t("waiting: {reason}", { reason: item.waitingReason })}</span> : null}
          <span>{item.priority}</span>
          <time>{formatDateTime(item.updatedAt)}</time>
        </div>
        {item.labels.length > 0 ? (
          <div className="work-item-labels">
            {item.labels.slice(0, 5).map((label) => <span key={label}>{label}</span>)}
          </div>
        ) : null}
      </div>
      <div className="work-item-actions">
        {primaryAction ? (
          <button className="secondary-button compact-button" type="button" onClick={primaryAction.onClick}>
            {primaryAction.icon}
            {primaryAction.label}
          </button>
        ) : null}
      </div>
    </article>
  );
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
