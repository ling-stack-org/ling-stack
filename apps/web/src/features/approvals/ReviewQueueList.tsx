import { Button, EmptyState, Skeleton } from "../../shared/ui/index.js";
import { History, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ApprovalQueueRowView } from "./approval-view-models.js";
import { ReviewQueueRow } from "./ReviewQueueRow.js";

export function ReviewQueueList({
  rows,
  selectedId,
  initialLoading,
  filtersActive,
  repairScoped,
  onSelect,
  onRefresh,
  onClearFilters,
  onOpenWorkBoard,
}: {
  readonly rows: readonly ApprovalQueueRowView[];
  readonly selectedId?: string;
  readonly initialLoading: boolean;
  readonly filtersActive: boolean;
  readonly repairScoped: boolean;
  readonly onSelect: (approvalId: string) => void;
  readonly onRefresh: () => void;
  readonly onClearFilters: () => void;
  readonly onOpenWorkBoard?: (scope?: "actionable" | "history") => void;
}): JSX.Element {
  const { t } = useI18n();
  if (initialLoading) return <ReviewQueueSkeleton />;
  if (rows.length === 0) {
    return (
      <div className="review-queue-list approvals-ui2-list empty" role="listbox" aria-label={t("Inbox")}>
        <EmptyState
          action={filtersActive ? (
            <Button leadingIcon={<X aria-hidden="true" size={14} />} size="sm" onClick={onClearFilters}>{t("Clear filters")}</Button>
          ) : (
            <Button leadingIcon={<RefreshCw aria-hidden="true" size={14} />} size="sm" onClick={onRefresh}>{t("Refresh")}</Button>
          )}
          compact
          description={filtersActive ? t("No activity matches these filters") : undefined}
          icon={<ShieldCheck size={20} />}
          secondaryAction={!filtersActive && onOpenWorkBoard ? (
            <Button leadingIcon={<History aria-hidden="true" size={14} />} size="sm" variant="ghost" onClick={() => onOpenWorkBoard("actionable")}>
              {t("Open Work Board")}
            </Button>
          ) : undefined}
          title={filtersActive
            ? t("No activity matches these filters")
            : repairScoped ? t("No approval records for this run") : t("Review queue is clear")}
        />
      </div>
    );
  }
  return (
    <div className="review-queue-list approvals-ui2-list" role="listbox" aria-label={t("Inbox")}>
      {rows.map((row) => (
        <ReviewQueueRow key={row.id} row={row} selected={selectedId === row.id} onSelect={() => onSelect(row.id)} />
      ))}
    </div>
  );
}

function ReviewQueueSkeleton(): JSX.Element {
  return (
    <div className="review-queue-list approvals-ui2-list approvals-ui2-list-skeleton" aria-busy="true">
      {Array.from({ length: 6 }, (_, index) => (
        <span className="approvals-ui2-skeleton-row" key={index}>
          <Skeleton width={`${70 - index * 4}%`} />
          <Skeleton width="92%" />
          <Skeleton width="45%" />
        </span>
      ))}
    </div>
  );
}
