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
  approvalOwnerLabels,
  approvalTimingLabel,
  effectiveApprovalStatus,
  highestApprovalRisk,
} from "../../lib/approvals.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  buildReviewQueueItems,
  reviewQueueCategoryLabel,
  type ReviewQueueItem,
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
  const selectedReviewQueueItem = reviewQueueItems.find((item) => item.approval.id === selectedApprovalId) ?? reviewQueueItems[0];
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

      {repairRunId ? (
        <div className="approval-list">
          {focusedApprovals.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <ShieldCheck />}
              <span>{isLoading ? t("Loading approvals...") : listEmptyCopy}</span>
            </div>
          ) : (
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
          )}
        </div>
      ) : (
        <ReviewQueueLayout
          cwd={cwd}
          items={reviewQueueItems}
          selectedItem={selectedReviewQueueItem}
          isLoading={isLoading}
          listEmptyCopy={listEmptyCopy}
          channels={channels}
          routingExternalWorkId={routingExternalWorkId}
          externalActionBusy={externalActionBusy}
          resolvingApprovals={resolvingApprovals}
          onSelectApproval={onSelectApproval}
          onRouteExternalWork={onRouteExternalWork}
          onResolve={onResolve}
          onExecuteExternalAction={onExecuteExternalAction}
          onCancelExternalAction={onCancelExternalAction}
        />
      )}
    </section>
  );
}

function ReviewQueueLayout({
  cwd,
  items,
  selectedItem,
  isLoading,
  listEmptyCopy,
  channels,
  routingExternalWorkId,
  externalActionBusy,
  resolvingApprovals,
  onSelectApproval,
  onRouteExternalWork,
  onResolve,
  onExecuteExternalAction,
  onCancelExternalAction,
}: {
  readonly cwd: string;
  readonly items: readonly ReviewQueueItem[];
  readonly selectedItem?: ReviewQueueItem;
  readonly isLoading: boolean;
  readonly listEmptyCopy: string;
  readonly channels?: readonly Channel[];
  readonly routingExternalWorkId?: string;
  readonly externalActionBusy: Readonly<Record<string, ExternalActionBusyState>>;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onSelectApproval: (approvalId: string) => void;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction: (actionId: string) => void;
  readonly onCancelExternalAction: (actionId: string) => void;
}): JSX.Element {
  const { t } = useI18n();

  if (items.length === 0) {
    return (
      <div className="review-queue-layout approval-list empty">
        <div className="empty-state compact-empty">
          {isLoading ? <Loader2 className="spin" /> : <ShieldCheck />}
          <span>{isLoading ? t("Loading approvals...") : listEmptyCopy}</span>
        </div>
        <ReviewQueueDetailPanel
          cwd={cwd}
          item={undefined}
          channels={channels}
          routingExternalWorkId={routingExternalWorkId}
          externalActionBusy={externalActionBusy}
          resolvingApprovals={resolvingApprovals}
          onRouteExternalWork={onRouteExternalWork}
          onSelectApproval={onSelectApproval}
          onResolve={onResolve}
          onExecuteExternalAction={onExecuteExternalAction}
          onCancelExternalAction={onCancelExternalAction}
        />
      </div>
    );
  }

  return (
    <div className="review-queue-layout approval-list">
      <div className="review-queue-list" aria-label={t("Review Queue")}>
        {items.map((item) => (
          <ReviewQueueRow
            key={item.id}
            item={item}
            selected={selectedItem?.id === item.id}
            onSelect={() => onSelectApproval(item.approval.id)}
          />
        ))}
      </div>
      <ReviewQueueDetailPanel
        cwd={cwd}
        item={selectedItem}
        channels={channels}
        routingExternalWorkId={routingExternalWorkId}
        externalActionBusy={externalActionBusy}
        resolvingApprovals={resolvingApprovals}
        onRouteExternalWork={onRouteExternalWork}
        onSelectApproval={onSelectApproval}
        onResolve={onResolve}
        onExecuteExternalAction={onExecuteExternalAction}
        onCancelExternalAction={onCancelExternalAction}
      />
    </div>
  );
}

function ReviewQueueRow({
  item,
  selected,
  onSelect,
}: {
  readonly item: ReviewQueueItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const status = effectiveApprovalStatus(item.approval);
  const ownerLabels = approvalOwnerLabels(item.approval);
  const timing = translateReviewQueueTimingLabel(approvalTimingLabel(item.approval), t);

  return (
    <button
      className={`review-queue-row ${item.category}${selected ? " selected" : ""}`}
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="review-queue-row-top">
        <strong>{item.title}</strong>
        <span className={`approval-state ${status}`}>{t(status)}</span>
      </span>
      <span className="review-queue-row-description">{item.description}</span>
      <span className="provider-meta-line">
        <span>{t(reviewQueueCategoryLabel(item.category))}</span>
        <span>{t(item.priority)}</span>
        <span>{t(item.approval.risk)}</span>
        <span>{t(item.approval.actionType)}</span>
        {ownerLabels.slice(0, 3).map((label) => <span key={label}>{t(label)}</span>)}
        <time>{formatDateTime(item.createdAt)}</time>
        {timing ? <time>{timing}</time> : null}
      </span>
    </button>
  );
}

function translateReviewQueueTimingLabel(timing: string, t: (key: string, values?: Readonly<Record<string, string | number>>) => string): string {
  if (timing.startsWith("expired ")) {
    return t("expired {time}", { time: timing.slice("expired ".length) });
  }
  if (timing.startsWith("expires in ")) {
    return t("expires in {duration}", { duration: timing.slice("expires in ".length) });
  }
  return timing;
}

function ReviewQueueDetailPanel({
  cwd,
  item,
  channels,
  routingExternalWorkId,
  externalActionBusy,
  resolvingApprovals,
  onRouteExternalWork,
  onSelectApproval,
  onResolve,
  onExecuteExternalAction,
  onCancelExternalAction,
}: {
  readonly cwd: string;
  readonly item?: ReviewQueueItem;
  readonly channels?: readonly Channel[];
  readonly routingExternalWorkId?: string;
  readonly externalActionBusy: Readonly<Record<string, ExternalActionBusyState>>;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly onSelectApproval: (approvalId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction: (actionId: string) => void;
  readonly onCancelExternalAction: (actionId: string) => void;
}): JSX.Element {
  const { t } = useI18n();

  if (!item) {
    return (
      <aside className="review-queue-detail empty" aria-label={t("Review item detail")}>
        <ShieldCheck size={22} />
        <strong>{t("No review item selected")}</strong>
        <p>{t("Select a queue item to inspect its approval payload, target, and available actions.")}</p>
      </aside>
    );
  }

  const status = effectiveApprovalStatus(item.approval);
  const ownerLabels = approvalOwnerLabels(item.approval);
  return (
    <aside className="review-queue-detail" aria-label={t("Review item detail")}>
      <div className="review-queue-detail-head">
        <span>{t(reviewQueueCategoryLabel(item.category))}</span>
        <h3>{item.title}</h3>
        <div className="review-queue-detail-badges">
          <span className={`approval-state ${status}`}>{t(status)}</span>
          <span className={`approval-risk ${item.approval.risk}`}>{t(item.approval.risk)}</span>
          <span>{t(item.priority)}</span>
        </div>
      </div>

      <div className="review-queue-detail-meta">
        <span>
          <small>{t("Owner")}</small>
          <strong>{ownerLabels.join(", ") || t("Unassigned")}</strong>
        </span>
        <span>
          <small>{t("Action")}</small>
          <strong>{t(item.approval.actionType)}</strong>
        </span>
        <span>
          <small>{t("Created")}</small>
          <strong>{formatDateTime(item.createdAt)}</strong>
        </span>
        <span>
          <small>{t("Priority")}</small>
          <strong>{t(item.priority)}</strong>
        </span>
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
        compact
        selected
        externalAction={item.externalAction}
        externalActionBusy={item.approval.externalWorkActionId ? externalActionBusy[item.approval.externalWorkActionId] : undefined}
        cwd={cwd}
        resolvingDecision={resolvingApprovals[item.approval.id]}
        onSelect={onSelectApproval}
        onResolve={onResolve}
        onExecuteExternalAction={onExecuteExternalAction}
        onCancelExternalAction={onCancelExternalAction}
      />
    </aside>
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
