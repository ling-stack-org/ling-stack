import type { DockReviewGroup, DockReviewItem } from "@ling-stack/conversation-ui-core";
import { DockEmptyState } from "./DockEmptyState.js";

export type DockReviewFilter = DockReviewGroup | "all" | "needs_action";

export interface ReviewQueuePageProps {
  readonly items: readonly DockReviewItem[];
  readonly activeFilter: DockReviewFilter;
  readonly filters: readonly { readonly id: DockReviewFilter; readonly label: string }[];
  readonly emptyTitle: string;
  readonly emptyDescription?: string;
  readonly needsActionLabel?: string;
  readonly trackedLabel?: string;
  readonly onFilterChange: (filter: DockReviewFilter) => void;
  readonly onOpenItem?: (item: DockReviewItem) => void;
}

export function ReviewQueuePage({
  items,
  activeFilter,
  filters,
  emptyTitle,
  emptyDescription,
  needsActionLabel = "needs action",
  trackedLabel = "tracked",
  onFilterChange,
  onOpenItem,
}: ReviewQueuePageProps): JSX.Element {
  const visibleItems = items.filter((item) => {
    if (activeFilter === "all") {
      return true;
    }
    if (activeFilter === "needs_action") {
      return item.status === "pending" || item.status === "blocked" || item.status === "failed";
    }
    return item.group === activeFilter;
  });
  const pendingCount = items.filter((item) => item.status === "pending" || item.status === "blocked" || item.status === "failed").length;

  return (
    <div className="right-dock-review-page">
      <div className="right-dock-filter-row" role="tablist" aria-label="Review filters">
        {filters.map((filter) => (
          <button
            key={filter.id}
            className={filter.id === activeFilter ? "right-dock-filter active" : "right-dock-filter"}
            type="button"
            role="tab"
            aria-selected={filter.id === activeFilter}
            onClick={() => onFilterChange(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {items.length > 0 ? (
        <div className="right-dock-summary-row">
          <span>
            <strong>{pendingCount}</strong>
            <small>{needsActionLabel}</small>
          </span>
          <span>
            <strong>{items.length - pendingCount}</strong>
            <small>{trackedLabel}</small>
          </span>
        </div>
      ) : null}
      {visibleItems.length > 0 ? (
        <div className="right-dock-section">
          {visibleItems.map((item) => (
            <button
              key={item.id}
              className={[
                "right-dock-row",
                "right-dock-review-row",
                `right-dock-row-severity-${item.severity}`,
                `status-${item.status}`,
              ].join(" ")}
              type="button"
              onClick={() => onOpenItem?.(item)}
              disabled={!onOpenItem}
            >
              <span className="right-dock-row-dot" aria-hidden="true" />
              <span className="right-dock-row-copy">
                <strong>{item.title}</strong>
                <small>{item.reason}</small>
              </span>
              <span className="right-dock-row-meta">
                {item.sourceLabel ? <small>{item.sourceLabel}</small> : null}
                {item.actionLabel ? <strong>{item.actionLabel}</strong> : null}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <DockEmptyState title={emptyTitle} description={emptyDescription} />
      )}
    </div>
  );
}
