import { CircleAlert, Clock3, GitPullRequest, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { workItemNextActionLabel, workItemStatusLabel, type WorkItemView } from "../../lib/work-items.js";
import { Badge, Button, DataRow, StatusIndicator } from "../../shared/ui/index.js";
import { derivePrimaryWorkBoardAction, workItemStatusTone } from "./work-board-view-models.js";
import type { WorkBoardMutation } from "./work-board-types.js";

export function WorkItemRow(props: {
  readonly item: WorkItemView;
  readonly channelName?: string;
  readonly selected?: boolean;
  readonly compact?: boolean;
  readonly busy?: WorkBoardMutation;
  readonly onSelect?: (workItemId: string) => void;
  readonly onOpenTask?: (taskId: string) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenApproval?: (approvalId: string) => void;
  readonly onOpenChannel?: (channelId: string) => void;
  readonly onClaimWorkItem?: (workItemId: string) => void;
  readonly onHeartbeatWorkItem?: (workItemId: string, claimToken: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const action = derivePrimaryWorkBoardAction(props.item, {
    busy: props.busy, canClaim: Boolean(props.onClaimWorkItem), canOpenTask: Boolean(props.onOpenTask),
    canOpenRun: Boolean(props.onOpenRun), canOpenApproval: Boolean(props.onOpenApproval), canOpenChannel: Boolean(props.onOpenChannel),
    canHeartbeat: Boolean(props.onHeartbeatWorkItem), preferClaimControl: true,
  });
  const invokeAction = (): void => {
    const item = props.item;
    if (action?.target === "claim") props.onClaimWorkItem?.(item.id);
    else if (action?.target === "heartbeat" && item.claim?.token) props.onHeartbeatWorkItem?.(item.id, item.claim.token);
    else if (action?.target === "approval" && item.approvalId) props.onOpenApproval?.(item.approvalId);
    else if (action?.target === "run" && item.runId) props.onOpenRun?.(item.runId);
    else if (action?.target === "task" && item.taskId) props.onOpenTask?.(item.taskId);
    else if (action?.target === "channel" && item.channelId) props.onOpenChannel?.(item.channelId);
  };
  return (
    <DataRow
      aria-label={props.item.title}
      className={`work-item-row ${props.item.status}`}
      compact={props.compact}
      data-work-item-id={props.item.id}
      identity={<span className="work-item-identity" dir="auto">{workItemIcon(props.item)}<strong title={props.item.title}>{props.item.title}</strong>{props.item.labels.length > 0 ? <Badge className="work-item-label-count">+{props.item.labels.length} {t("labels")}</Badge> : null}</span>}
      summary={<span className="work-item-summary"><strong>{t(workItemNextActionLabel(props.item))}</strong><span>{[props.item.durable ? t("durable") : undefined, props.channelName ? `#${props.channelName}` : undefined, props.item.claim ? t("claimed by {owner}", { owner: props.item.claim.ownerId }) : props.item.assigneeTeammateId, formatDateTime(props.item.updatedAt)].filter(Boolean).join(" · ")}</span></span>}
      status={<StatusIndicator compact label={t(workItemStatusLabel(props.item.status))} tone={workItemStatusTone(props.item.status)} />}
      actions={action ? <Button disabled={action.disabled} loading={action.loading} loadingLabel={t(action.label)} size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); invokeAction(); }}>{t(action.label)}</Button> : undefined}
      selected={props.selected}
      onClick={props.onSelect ? () => props.onSelect?.(props.item.id) : undefined}
    />
  );
}

function workItemIcon(item: WorkItemView): JSX.Element {
  if (item.waitingReason === "approval") return <ShieldCheck aria-hidden="true" size={15} />;
  if (item.status === "blocked") return <CircleAlert aria-hidden="true" size={15} />;
  if (item.sourceType.startsWith("external")) return <GitPullRequest aria-hidden="true" size={15} />;
  return <Clock3 aria-hidden="true" size={15} />;
}
