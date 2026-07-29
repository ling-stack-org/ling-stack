import { Badge, DataRow, StatusIndicator } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { approvalActionDisplayKey, approvalRiskTone, approvalStatusTone, isApprovalDecisionCategory, type ApprovalQueueRowView } from "./approval-view-models.js";

export function ReviewQueueRow({
  row,
  selected,
  onSelect,
}: {
  readonly row: ApprovalQueueRowView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <DataRow
      aria-label={row.approval.title}
      className="review-queue-row approvals-ui2-row"
      compact
      data-review-category={row.category}
      identity={(
        <span className="approvals-ui2-row-identity">
          <strong>{row.approval.title}</strong>
          <small>{t(row.categoryLabel)} · {row.ownerLabel}</small>
        </span>
      )}
      selected={selected}
      status={(
        <span className="approvals-ui2-row-status">
          <StatusIndicator compact label={t(row.status)} tone={approvalStatusTone(row.status)} />
          {isApprovalDecisionCategory(row.category) ? (
            <Badge tone={approvalRiskTone(row.approval.risk)} variant="outline">{t(row.approval.risk)}</Badge>
          ) : null}
        </span>
      )}
      summary={(
        <span className="approvals-ui2-row-summary">
          <span>{row.approval.description}</span>
          <small>{t(approvalActionDisplayKey(row.approval.actionType))} · {formatDateTime(row.approval.createdAt)}</small>
        </span>
      )}
      onClick={onSelect}
    />
  );
}
