import { Badge, Button, StatusIndicator } from "../../shared/ui/index.js";
import { History, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus, highestApprovalRisk } from "../../lib/approvals.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import type { ApprovalRequest, RunSession } from "../../types.js";
import { approvalRiskTone } from "./approval-view-models.js";

export function ApprovalRunRepairPanel({
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
  const { t } = useI18n();
  const pendingCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const highestRisk = highestApprovalRisk(approvals);
  const taskLabel = run ? readTaskTitle(run.taskSnapshot) || run.taskId : approvals[0]?.taskId ?? "-";
  return (
    <section className="approval-run-repair approvals-ui2-run-repair" aria-label="Approval run repair">
      <span className="approvals-ui2-run-repair-copy">
        <span><ShieldCheck aria-hidden="true" size={16} /><strong>{t("Resolve run approvals")}</strong></span>
        <small>{t("Run {runId} is focused for approval repair.", { runId })}</small>
        <small>{t("Task")}: {taskLabel}</small>
      </span>
      <span className="approvals-ui2-run-repair-status">
        <StatusIndicator compact label={t("{count} pending", { count: pendingCount })} tone={pendingCount ? "warning" : "success"} />
        <Badge tone={approvalRiskTone(highestRisk)} variant="outline">{t(highestRisk)}</Badge>
      </span>
      <span className="approvals-ui2-run-repair-actions">
        <Button leadingIcon={<RefreshCw aria-hidden="true" size={14} />} loading={isLoading} size="sm" onClick={onRefresh}>{t("Refresh")}</Button>
        <Button leadingIcon={<History aria-hidden="true" size={14} />} size="sm" variant="primary" onClick={onOpenRun}>{t("Back to run")}</Button>
        <Button size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button>
      </span>
    </section>
  );
}
