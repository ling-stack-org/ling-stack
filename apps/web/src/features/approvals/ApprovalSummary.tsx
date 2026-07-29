import { Badge, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { approvalOwnerIdentity, approvalTimingLabel, effectiveApprovalStatus } from "../../lib/approvals.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { ApprovalRequest } from "../../types.js";
import { approvalActionDisplayKey, approvalRiskTone, approvalStatusTone } from "./approval-view-models.js";
import { ApprovalPayloadSummary } from "./ApprovalPayloadSummary.js";

export function ApprovalSummary({ approval }: { readonly approval: ApprovalRequest }): JSX.Element {
  const { t } = useI18n();
  const status = effectiveApprovalStatus(approval);
  const timing = approvalTimingLabel(approval);
  return (
    <div className="approval-main">
      <header className="approval-head">
        <strong>{approval.title}</strong>
        <span className="approval-summary-indicators">
          <StatusIndicator compact label={t(status)} tone={approvalStatusTone(status)} />
          <Badge tone={approvalRiskTone(approval.risk)} variant="outline">{t(approval.risk)}</Badge>
        </span>
      </header>
      <p>{approval.description}</p>
      <div className="approval-summary-meta">
        <span>{t(approvalActionDisplayKey(approval.actionType))}</span>
        <span>{approvalOwnerIdentity(approval)}</span>
        <time>{formatDateTime(approval.createdAt)}</time>
        {timing ? <time>{timing}</time> : null}
        {approval.resolvedAt ? <time>{t("resolved {time}", { time: formatDateTime(approval.resolvedAt) })}</time> : null}
      </div>
      {approval.decisionReason ? (
        <InlineFeedback className="approval-decision-reason" title={t("Decision reason")} tone={status === "approved" ? "success" : "warning"}>
          {approval.decisionReason}
        </InlineFeedback>
      ) : null}
      <ApprovalPayloadSummary approval={approval} />
    </div>
  );
}
