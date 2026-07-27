import { Badge, InlineFeedback } from "../../shared/ui/index.js";
import type { ExternalActionBusyState } from "../../domains/approvals/approval-domain-types.js";
import { useI18n } from "../../i18n.js";
import type { ApprovalRequest, Channel, ExternalWorkActionView, RunSession } from "../../types.js";
import { ApprovalRunRepairPanel } from "./ApprovalRunRepairPanel.js";
import { ApprovalsHeader } from "./ApprovalsHeader.js";
import { ApprovalToolbar } from "./ApprovalToolbar.js";
import { ReviewQueueDetail } from "./ReviewQueueDetail.js";
import { ReviewQueueList } from "./ReviewQueueList.js";
import type { ApprovalResolution } from "./types.js";
import { useApprovalsPageController } from "./useApprovalsPageController.js";

export function ApprovalsPage({
  cwd, approvals, repairRunId, repairRun, selectedApprovalId, externalActionDetails, externalActionBusy,
  isLoading, resolvingApprovals, errorMessage, onRefresh, onSelectApproval, onRefreshRepair, onResolve,
  onExecuteExternalAction, onCancelExternalAction, onOpenRun, onOpenWorkBoard, onClearRepair, channels,
  onRouteExternalWork, routingExternalWorkId, inlineApprovalIds,
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
  readonly onOpenWorkBoard?: (scope?: "actionable" | "history") => void;
  readonly onClearRepair: () => void;
  readonly channels?: readonly Channel[];
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly routingExternalWorkId?: string;
  readonly inlineApprovalIds?: ReadonlySet<string>;
}): JSX.Element {
  const { t } = useI18n();
  const controller = useApprovalsPageController({ approvals, repairRun, repairRunId, externalActionDetails, inlineApprovalIds, selectedApprovalId, isLoading, errorMessage, onSelectApproval });
  const refresh = repairRunId ? () => onRefreshRepair(repairRunId) : onRefresh;
  const runRefresh = () => controller.runRefresh(refresh);
  const initialLoading = isLoading && approvals.length === 0;
  const visiblePageError = approvals.length === 0 ? errorMessage : controller.refreshError;
  const repairApprovals = repairRunId ? approvals.filter((approval) => approval.runId === repairRunId) : [];
  return (
    <section className="panel approvals-panel approvals-ui2-page" data-approvals-ui2-page aria-labelledby="approvals-title">
      <ApprovalsHeader isLoading={isLoading} pendingCount={controller.pendingCount} repairScoped={Boolean(repairRunId)} onRefresh={runRefresh} />
      {visiblePageError ? (
        <InlineFeedback className="approvals-ui2-page-feedback" data-approval-stale={approvals.length > 0 || undefined} title={t("Refresh")} tone={approvals.length > 0 ? "warning" : "danger"}>
          {visiblePageError}
        </InlineFeedback>
      ) : null}
      {repairRunId ? (
        <ApprovalRunRepairPanel runId={repairRunId} run={repairRun} approvals={repairApprovals} isLoading={isLoading} onRefresh={runRefresh} onOpenRun={() => onOpenRun(repairRunId)} onClear={onClearRepair} />
      ) : (
        <>
          <ApprovalToolbar
            mode={controller.mode}
            category={controller.category}
            risk={controller.risk}
            search={controller.search}
            categoryOptions={controller.categoryOptions}
            filtersActive={controller.filtersActive}
            onModeChange={controller.setMode}
            onCategoryChange={controller.setCategory}
            onRiskChange={controller.setRisk}
            onSearchChange={controller.setSearch}
            onClear={controller.clearFilters}
          />
          <div className="review-queue-summary approvals-ui2-summary" aria-label={t("Inbox summary")}>
            <Badge variant="outline">{t("{count} review items", { count: controller.visibleRows.length })}</Badge>
            {controller.categoryOptions.map((category) => <Badge key={category} variant="outline">{t(controller.allRows.find((row) => row.category === category)?.categoryLabel ?? category)}</Badge>)}
          </div>
        </>
      )}
      <div className="review-queue-layout approval-list approvals-ui2-layout">
        <ReviewQueueList
          rows={controller.visibleRows}
          selectedId={controller.selectedRow?.id}
          initialLoading={initialLoading}
          filtersActive={!repairRunId && controller.filtersActive}
          repairScoped={Boolean(repairRunId)}
          onSelect={onSelectApproval}
          onRefresh={runRefresh}
          onClearFilters={controller.clearFilters}
          onOpenWorkBoard={onOpenWorkBoard}
        />
        <ReviewQueueDetail
          cwd={cwd}
          row={controller.selectedRow}
          initialLoading={initialLoading}
          forceDecision={Boolean(repairRunId)}
          channels={channels}
          routingExternalWorkId={routingExternalWorkId}
          externalActionBusy={externalActionBusy}
          resolvingApprovals={resolvingApprovals}
          errorMessage={errorMessage}
          onRefresh={runRefresh}
          onOpenRun={onOpenRun}
          onOpenWorkBoard={onOpenWorkBoard}
          onRouteExternalWork={onRouteExternalWork}
          onSelectApproval={onSelectApproval}
          onResolve={onResolve}
          onExecuteExternalAction={onExecuteExternalAction}
          onCancelExternalAction={onCancelExternalAction}
        />
      </div>
    </section>
  );
}
