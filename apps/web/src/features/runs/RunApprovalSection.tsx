import { RefreshCw, ShieldCheck } from "lucide-react";
import { ApprovalCard } from "../approvals/ApprovalCard.js";
import type { ApprovalResolution } from "../approvals/types.js";
import { useI18n } from "../../i18n.js";
import { Button, EmptyState, InlineFeedback, InspectorSection } from "../../shared/ui/index.js";
import type { ApprovalRequest } from "../../types.js";

export function RunApprovalSection({ approvals, loading, resolvingApprovals, onRefresh, onResolve }: {
  readonly approvals: readonly ApprovalRequest[];
  readonly loading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onRefresh: () => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const pending = approvals.filter((approval) => approval.status === "pending");
  return (
    <InspectorSection
      action={<Button leadingIcon={<RefreshCw size={14} />} loading={loading} onClick={onRefresh} size="sm">{t("Refresh")}</Button>}
      open={pending.length > 0}
      summary={t("{count} approval events", { count: approvals.length })}
      title={t("Approval state")}
    >
      {pending.length ? <InlineFeedback tone="warning">{t(pending.length === 1 ? "Waiting for {count} approval: {actions}" : "Waiting for {count} approvals: {actions}", { count: pending.length, actions: pending.map((approval) => approval.actionType).join(", ") })}</InlineFeedback> : null}
      {approvals.length === 0 ? <EmptyState compact icon={<ShieldCheck />} title={t("No approval gates recorded for this run.")} /> : <div className="run-approval-list">{approvals.map((approval) => <ApprovalCard approval={approval} compact key={approval.id} resolvingDecision={resolvingApprovals[approval.id]} onResolve={onResolve} />)}</div>}
    </InspectorSection>
  );
}
