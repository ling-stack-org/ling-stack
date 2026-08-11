import { Badge, Button, EmptyState, InlineFeedback, Select, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import { History, Route, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { ExternalActionBusyState } from "../../domains/approvals/approval-domain-types.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { Channel } from "../../types.js";
import { ApprovalCard } from "./ApprovalCard.js";
import {
  approvalRiskTone,
  approvalActionDisplayKey,
  approvalStatusTone,
  isApprovalDecisionCategory,
  type ApprovalQueueRowView,
} from "./approval-view-models.js";
import type { ApprovalResolution } from "./types.js";

export function ReviewQueueDetail({
  cwd,
  row,
  initialLoading,
  forceDecision = false,
  channels,
  routingExternalWorkId,
  externalActionBusy,
  resolvingApprovals,
  errorMessage,
  onRefresh,
  onOpenRun,
  onOpenWorkBoard,
  onRouteExternalWork,
  onSelectApproval,
  onResolve,
  onExecuteExternalAction,
  onCancelExternalAction,
}: {
  readonly cwd: string;
  readonly row?: ApprovalQueueRowView;
  readonly initialLoading: boolean;
  readonly forceDecision?: boolean;
  readonly channels?: readonly Channel[];
  readonly routingExternalWorkId?: string;
  readonly externalActionBusy: Readonly<Record<string, ExternalActionBusyState>>;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly errorMessage: string;
  readonly onRefresh: () => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenWorkBoard?: (scope?: "actionable" | "history") => void;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly onSelectApproval: (approvalId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction: (actionId: string) => void;
  readonly onCancelExternalAction: (actionId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (initialLoading) return <ReviewQueueDetailSkeleton />;
  if (!row) {
    return (
      <aside className="review-queue-detail approvals-ui2-detail empty" aria-label={t("Review item detail")}>
        <EmptyState
          compact
          description={t("Select an inbox item to see the current issue, recommended action, related run, and risk details.")}
          icon={<ShieldCheck size={20} />}
          title={t("Inbox handling panel")}
        />
      </aside>
    );
  }
  const actionId = row.approval.externalWorkActionId;
  const decisionEnabled = forceDecision || isApprovalDecisionCategory(row.category);
  return (
    <aside className="review-queue-detail approvals-ui2-detail" aria-label={t("Review item detail")} data-approval-detail-id={row.id}>
      <header className="approvals-ui2-detail-header">
        <small>{t(row.categoryLabel)}</small>
        <h3>{row.approval.title}</h3>
        <span>
          <StatusIndicator compact label={t(row.status)} tone={approvalStatusTone(row.status)} />
          {decisionEnabled ? <Badge tone={approvalRiskTone(row.approval.risk)} variant="outline">{t(row.approval.risk)}</Badge> : null}
        </span>
      </header>
      <section className="approvals-ui2-current-issue">
        <small>{t("Current issue")}</small>
        <p>{row.approval.description}</p>
        <strong>{t("Recommended action: {action}", { action: t(row.recommendedAction) })}</strong>
      </section>
      <div className="approvals-ui2-detail-meta">
        <span><small>{t("Owner")}</small><strong>{row.ownerLabel}</strong></span>
        <span><small>{t("Action")}</small><strong>{t(approvalActionDisplayKey(row.approval.actionType))}</strong></span>
        <span><small>{t("Created")}</small><strong>{formatDateTime(row.approval.createdAt)}</strong></span>
        <span><small>{t("Category")}</small><strong>{t(row.categoryLabel)}</strong></span>
      </div>
      <QueueCategoryAction
        row={row}
        channels={channels}
        routingExternalWorkId={routingExternalWorkId}
        onOpenRun={onOpenRun}
        onOpenWorkBoard={onOpenWorkBoard}
        onRouteExternalWork={onRouteExternalWork}
      />
      <ApprovalCard
        approval={row.approval}
        compact
        selected
        decisionEnabled={decisionEnabled}
        errorMessage={errorMessage}
        externalAction={row.externalAction}
        externalActionBusy={actionId ? externalActionBusy[actionId] : undefined}
        cwd={cwd}
        resolvingDecision={resolvingApprovals[row.id]}
        onSelect={onSelectApproval}
        onResolve={onResolve}
        onExecuteExternalAction={onExecuteExternalAction}
        onCancelExternalAction={onCancelExternalAction}
        onRefreshExternalAction={onRefresh}
      />
    </aside>
  );
}

function QueueCategoryAction({ row, channels, routingExternalWorkId, onOpenRun, onOpenWorkBoard, onRouteExternalWork }: {
  readonly row: ApprovalQueueRowView;
  readonly channels?: readonly Channel[];
  readonly routingExternalWorkId?: string;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenWorkBoard?: (scope?: "actionable" | "history") => void;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (row.category !== "route" && row.category !== "repair") return null;
  const externalWorkId = row.externalAction?.action.externalWorkId;
  if (row.category === "route" && externalWorkId && onRouteExternalWork && channels?.length) {
    return (
      <ReviewQueueRouteControl
        channels={channels}
        currentChannelId={row.externalAction?.action.channelId}
        externalWorkId={externalWorkId}
        routing={routingExternalWorkId === externalWorkId}
        onRouteExternalWork={onRouteExternalWork}
      />
    );
  }
  return (
    <InlineFeedback title={t(row.category === "route" ? "Route" : "Repair")} tone="warning">
      <span>{t(row.recommendedAction)}</span>
      <span className="approvals-ui2-feedback-actions">
        {row.approval.runId ? <Button leadingIcon={<History aria-hidden="true" size={14} />} size="sm" onClick={() => onOpenRun(row.approval.runId!)}>{t("Open run")}</Button> : null}
        {onOpenWorkBoard ? <Button size="sm" variant="ghost" onClick={() => onOpenWorkBoard("actionable")}>{t("Open Work Board")}</Button> : null}
      </span>
    </InlineFeedback>
  );
}

function ReviewQueueRouteControl({ channels, currentChannelId, externalWorkId, routing, onRouteExternalWork }: {
  readonly channels: readonly Channel[];
  readonly currentChannelId?: string;
  readonly externalWorkId: string;
  readonly routing: boolean;
  readonly onRouteExternalWork: (externalWorkId: string, channelId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [targetChannelId, setTargetChannelId] = useState("");
  useEffect(() => setTargetChannelId(""), [externalWorkId]);
  return (
    <div className="review-queue-route-control approvals-ui2-route-control">
      <Select aria-label={t("Route to channel")} disabled={routing} size="sm" value={targetChannelId} onChange={(event) => setTargetChannelId(event.target.value)}>
        <option value="">{t("Route to channel")}</option>
        {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
      </Select>
      <Button
        leadingIcon={<Route aria-hidden="true" size={14} />}
        loading={routing}
        loadingLabel={t("Routing")}
        size="sm"
        disabled={!targetChannelId || targetChannelId === currentChannelId}
        onClick={() => onRouteExternalWork(externalWorkId, targetChannelId)}
      >
        {t("Route")}
      </Button>
    </div>
  );
}

function ReviewQueueDetailSkeleton(): React.JSX.Element {
  return (
    <aside className="review-queue-detail approvals-ui2-detail approvals-ui2-detail-skeleton" aria-busy="true">
      <Skeleton width="35%" /><Skeleton height={28} shape="block" width="85%" /><Skeleton height={74} shape="block" width="100%" /><Skeleton height={140} shape="block" width="100%" />
    </aside>
  );
}
