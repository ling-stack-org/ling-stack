import { useState } from "react";
import {
  CircleAlert,
  History,
  Loader2,
  RefreshCw,
  Route,
  ShieldCheck,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  effectiveApprovalStatus,
  highestApprovalRisk,
} from "../../lib/approvals.js";
import {
  buildReviewQueueItems,
  reviewQueueCategoryLabel,
} from "../../lib/review-queue.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import type { ApprovalRequest, Channel, ExternalWorkActionView, RunSession } from "../../types.js";
import { ApprovalCard, type ExternalActionBusyState } from "./ApprovalCard.js";
import type { ApprovalResolution } from "./types.js";

export function ApprovalsPage({
  cwd,
  approvals,
  repairRunId,
  repairRun,
  selectedApprovalId,
  externalActionDetails,
  externalActionBusy,
  isLoading,
  resolvingApprovals,
  errorMessage,
  onRefresh,
  onSelectApproval,
  onRefreshRepair,
  onResolve,
  onExecuteExternalAction,
  onCancelExternalAction,
  onOpenRun,
  onClearRepair,
  channels,
  onRouteExternalWork,
  routingExternalWorkId,
  inlineApprovalIds,
}: {
  readonly cwd: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly repairRunId: string;
  readonly repairRun: RunSession | undefined;
  readonly selectedApprovalId: string;
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalActionBusy: Readonly<Record<string, ExternalActionBusyState>>;
  readonly isLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly errorMessage: string;
  readonly onRefresh: () => void;
  readonly onSelectApproval: (approvalId: string) => void;
  readonly onRefreshRepair: (runId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction: (actionId: string) => void;
  readonly onCancelExternalAction: (actionId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClearRepair: () => void;
  readonly channels?: readonly Channel[];
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly routingExternalWorkId?: string;
  readonly inlineApprovalIds?: ReadonlySet<string>;
}): JSX.Element {
  const { t } = useI18n();
  const reviewQueueItems = buildReviewQueueItems({
    approvals,
    externalActionDetails,
    inlineApprovalIds,
    runsById: repairRun ? new Map([[repairRun.id, repairRun]]) : undefined,
  });
  const focusedApprovals = repairRunId ? approvals.filter((approval) => approval.runId === repairRunId) : reviewQueueItems.map((item) => item.approval);
  const listEmptyCopy = repairRunId ? t("No approval records for this run") : t("Review Queue is clear");

  return (
    <section className="panel approvals-panel" aria-labelledby="approvals-title">
      <div className="panel-title split">
        <span>
          <ShieldCheck size={18} />
          <h2 id="approvals-title">{repairRunId ? t("Approval requests") : t("Review Queue")}</h2>
        </span>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={repairRunId ? () => onRefreshRepair(repairRunId) : onRefresh}
          disabled={isLoading}
        >
          {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("Refresh")}
        </button>
      </div>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      {repairRunId ? (
        <ApprovalRunRepairPanel
          runId={repairRunId}
          run={repairRun}
          approvals={focusedApprovals}
          isLoading={isLoading}
          onRefresh={() => onRefreshRepair(repairRunId)}
          onOpenRun={() => onOpenRun(repairRunId)}
          onClear={onClearRepair}
        />
      ) : null}

      {!repairRunId ? (
        <div className="review-queue-summary" aria-label={t("Review Queue summary")}>
          <span>{t("{count} review items", { count: reviewQueueItems.length })}</span>
          {[...new Set(reviewQueueItems.map((item) => item.category))].map((category) => (
            <span key={category}>{t(reviewQueueCategoryLabel(category))}</span>
          ))}
        </div>
      ) : null}

      <div className="approval-list">
        {focusedApprovals.length === 0 ? (
          <div className="empty-state compact-empty">
            {isLoading ? <Loader2 className="spin" /> : <ShieldCheck />}
            <span>{isLoading ? t("Loading approvals...") : listEmptyCopy}</span>
          </div>
        ) : (
          repairRunId ? (
            focusedApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                selected={approval.id === selectedApprovalId}
                externalAction={approval.externalWorkActionId ? externalActionDetails[approval.externalWorkActionId] : undefined}
                externalActionBusy={approval.externalWorkActionId ? externalActionBusy[approval.externalWorkActionId] : undefined}
                cwd={cwd}
                resolvingDecision={resolvingApprovals[approval.id]}
                onSelect={onSelectApproval}
                onResolve={onResolve}
                onExecuteExternalAction={onExecuteExternalAction}
                onCancelExternalAction={onCancelExternalAction}
              />
            ))
          ) : (
            reviewQueueItems.map((item) => (
              <div key={item.id} className={`review-queue-item ${item.category}`}>
                <div className="review-queue-item-head">
                  <span>{t(reviewQueueCategoryLabel(item.category))}</span>
                  <span className={`approval-risk ${item.approval.risk}`}>{item.priority}</span>
                </div>
                {item.externalAction?.action.externalWorkId && onRouteExternalWork && channels && channels.length > 1 ? (
                  <ReviewQueueRouteControl
                    channels={channels}
                    currentChannelId={item.externalAction.action.channelId}
                    externalWorkId={item.externalAction.action.externalWorkId}
                    routing={routingExternalWorkId === item.externalAction.action.externalWorkId}
                    onRouteExternalWork={onRouteExternalWork}
                  />
                ) : null}
                <ApprovalCard
                  approval={item.approval}
                  selected={item.approval.id === selectedApprovalId}
                  externalAction={item.externalAction}
                  externalActionBusy={item.approval.externalWorkActionId ? externalActionBusy[item.approval.externalWorkActionId] : undefined}
                  cwd={cwd}
                  resolvingDecision={resolvingApprovals[item.approval.id]}
                  onSelect={onSelectApproval}
                  onResolve={onResolve}
                  onExecuteExternalAction={onExecuteExternalAction}
                  onCancelExternalAction={onCancelExternalAction}
                />
              </div>
            ))
          )
        )}
      </div>
    </section>
  );
}

function ReviewQueueRouteControl({
  channels,
  currentChannelId,
  externalWorkId,
  routing,
  onRouteExternalWork,
}: {
  readonly channels: readonly Channel[];
  readonly currentChannelId?: string;
  readonly externalWorkId: string;
  readonly routing?: boolean;
  readonly onRouteExternalWork: (externalWorkId: string, channelId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [targetChannelId, setTargetChannelId] = useState(currentChannelId ?? "");
  return (
    <div className="review-queue-route-control">
      <span>{t("Route")}</span>
      <select
        aria-label={t("Route to channel")}
        value={targetChannelId}
        disabled={routing}
        onChange={(event) => setTargetChannelId(event.target.value)}
      >
        {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
      </select>
      <button
        className="secondary-button compact-button"
        type="button"
        disabled={routing || !targetChannelId || targetChannelId === currentChannelId}
        onClick={() => onRouteExternalWork(externalWorkId, targetChannelId)}
      >
        {routing ? <Loader2 className="spin" size={14} /> : <Route size={14} />}
        {routing ? t("Routing") : t("Route")}
      </button>
    </div>
  );
}

function ApprovalRunRepairPanel({
  runId,
  run,
  approvals,
  isLoading,
  onRefresh,
  onOpenRun,
  onClear,
}: {
  readonly runId: string;
  readonly run: RunSession | undefined;
  readonly approvals: readonly ApprovalRequest[];
  readonly isLoading: boolean;
  readonly onRefresh: () => void;
  readonly onOpenRun: () => void;
  readonly onClear: () => void;
}): JSX.Element {
  const pendingApprovals = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending");
  const resolvedApprovals = approvals.filter((approval) => effectiveApprovalStatus(approval) !== "pending");
  const highestRisk = highestApprovalRisk(approvals);
  const actionTypes = [...new Set(approvals.map((approval) => approval.actionType))];
  const taskLabel = run ? readTaskTitle(run.taskSnapshot) || run.taskId : approvals[0]?.taskId ?? "-";

  return (
    <div className="approval-run-repair" aria-label="Approval run repair">
      <div className="approval-run-repair-head">
        <span>
          <ShieldCheck size={16} />
          <strong>Resolve run approvals</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="approval-run-repair-copy">
        <span>
          Run <code>{runId}</code> is focused for approval repair.
        </span>
        <small>Task: {taskLabel}</small>
      </div>
      <div className="approval-run-repair-meta">
        <span className="approval-state pending">{pendingApprovals.length} pending</span>
        <span className="approval-state approved">{resolvedApprovals.length} resolved</span>
        <span className={`approval-risk ${highestRisk}`}>{highestRisk}</span>
        {actionTypes.length > 0 ? <span className="approval-state">{actionTypes.join(", ")}</span> : null}
      </div>
      <div className="approval-run-repair-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          Reload
        </button>
        <button className="primary-button compact-button" type="button" onClick={onOpenRun}>
          <History size={14} />
          Back to run
        </button>
      </div>
    </div>
  );
}
