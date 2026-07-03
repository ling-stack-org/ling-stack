import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  readonly blockerLabel?: string;
  readonly sendReviewLabel?: string;
  readonly clearReviewLabel?: string;
  readonly detailEmptyTitle?: string;
  readonly detailEmptyDescription?: string;
  readonly detailPresentation?: "pane" | "accordion";
  readonly renderItemDetail?: (item: DockReviewItem) => ReactNode;
  readonly onSendReviewPacket?: (items: readonly DockReviewItem[]) => void;
  readonly onClearReviewPacket?: () => void;
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
  blockerLabel = "blocker",
  sendReviewLabel = "send review",
  clearReviewLabel = "clear",
  detailEmptyTitle = "No item selected",
  detailEmptyDescription,
  detailPresentation = "pane",
  renderItemDetail,
  onSendReviewPacket,
  onClearReviewPacket,
  onFilterChange,
  onOpenItem,
}: ReviewQueuePageProps): JSX.Element {
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  const visibleItems = useMemo(() => items.filter((item) => {
    if (activeFilter === "all") {
      return true;
    }
    if (activeFilter === "needs_action") {
      return item.status === "pending" || item.status === "blocked" || item.status === "failed";
    }
    return item.group === activeFilter;
  }), [activeFilter, items]);
  const pendingItems = useMemo(
    () => items.filter((item) => item.status === "pending" || item.status === "blocked" || item.status === "failed"),
    [items],
  );
  const pendingCount = pendingItems.length;
  const blockerCount = items.filter((item) => item.status === "blocked" || item.status === "failed" || item.severity === "danger").length;
  const stats = reviewStats(items);
  const selectedItem = visibleItems.find((item) => item.id === selectedItemId) ?? visibleItems[0];
  const useAccordionDetail = Boolean(renderItemDetail) && detailPresentation === "accordion";
  const usePaneDetail = Boolean(renderItemDetail) && detailPresentation === "pane";

  useEffect(() => {
    if (!usePaneDetail) {
      return;
    }
    if (!visibleItems.length) {
      setSelectedItemId(undefined);
      return;
    }
    if (!visibleItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(visibleItems[0]?.id);
    }
  }, [selectedItemId, usePaneDetail, visibleItems]);

  const rootClassName = [
    "right-dock-review-page",
    usePaneDetail ? "right-dock-review-workbench right-dock-review-page-pane" : "",
    useAccordionDetail ? "right-dock-review-page-accordion" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      <section className="right-dock-review-list-pane">
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
          <div className="right-dock-review-status-card">
            <span><strong>{pendingCount}</strong> {needsActionLabel}</span>
            {stats ? (
              <span className="right-dock-diff-stat" aria-label="Change statistics">
                <span className="add">+{stats.additions}</span>
                <span className="del">-{stats.deletions}</span>
              </span>
            ) : blockerCount > 0 ? (
              <span className="right-dock-diff-stat">
                <span className="del">{blockerCount} {blockerLabel}</span>
              </span>
            ) : (
              <span>{items.length - pendingCount} {trackedLabel}</span>
            )}
          </div>
        ) : null}
        {visibleItems.length > 0 ? (
          <div className="right-dock-section">
            {visibleItems.map((item) => {
              const selected = Boolean(renderItemDetail) && selectedItemId === item.id;
              if (useAccordionDetail) {
                return (
                  <div key={item.id} className="right-dock-review-accordion-item expanded">
                    <div className="right-dock-review-inline-detail">
                      {renderItemDetail?.(item)}
                    </div>
                  </div>
                );
              }
              return (
                <div key={item.id} className="right-dock-review-accordion-item">
                  <button
                    className={[
                      "right-dock-row",
                      "right-dock-review-row",
                      selected ? "selected" : "",
                      `right-dock-row-severity-${item.severity}`,
                      `status-${item.status}`,
                    ].filter(Boolean).join(" ")}
                    type="button"
                    title={reviewRowTitle(item)}
                    aria-current={selected ? "true" : undefined}
                    aria-expanded={renderItemDetail ? selected : undefined}
                    onClick={() => {
                      if (usePaneDetail) {
                        setSelectedItemId(item.id);
                        return;
                      }
                      onOpenItem?.(item);
                    }}
                    disabled={!renderItemDetail && !onOpenItem}
                  >
                    <span className="right-dock-row-dot" aria-hidden="true" />
                    <span className="right-dock-row-copy">
                      <strong>{item.title}</strong>
                      <small>{item.pathLabel ?? item.reason}</small>
                    </span>
                    {item.stats ? (
                      <span className="right-dock-diff-stat" title={`${item.stats.additions} additions, ${item.stats.deletions} deletions`}>
                        <span className="add">+{item.stats.additions}</span>
                        <span className="del">-{item.stats.deletions}</span>
                      </span>
                    ) : (
                      <span className={["right-dock-row-state", `tone-${reviewTone(item)}`].join(" ")} title={reviewActionLabel(item)}>
                        {reviewActionLabel(item)}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <DockEmptyState title={emptyTitle} description={emptyDescription} />
        )}
      </section>
      {usePaneDetail ? (
        <section className="right-dock-review-detail-pane">
          <div className="right-dock-review-detail-scroll">
            {selectedItem && renderItemDetail ? renderItemDetail(selectedItem) : (
              <DockEmptyState title={detailEmptyTitle} description={detailEmptyDescription} />
            )}
          </div>
          {items.length > 0 && (onClearReviewPacket || onSendReviewPacket) ? (
            <footer className="right-dock-review-action-bar">
              <span className="right-dock-review-action-copy">
                <span className="right-dock-review-action-dot" aria-hidden="true" />
                <strong>{pendingCount} {needsActionLabel}</strong>
                <small>{blockerCount} {blockerLabel}</small>
              </span>
              <span className="right-dock-review-action-buttons">
                <button type="button" disabled={!onClearReviewPacket} onClick={() => onClearReviewPacket?.()}>
                  {clearReviewLabel}
                </button>
                <button type="button" className="primary" disabled={!onSendReviewPacket || pendingItems.length === 0} onClick={() => onSendReviewPacket?.(pendingItems)}>
                  {sendReviewLabel}
                </button>
              </span>
            </footer>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function reviewActionLabel(item: DockReviewItem): string {
  if (item.actionLabel) {
    return item.actionLabel;
  }
  if (item.status === "failed") {
    return "failed";
  }
  if (item.status === "blocked") {
    return "blocked";
  }
  if (item.status === "passed") {
    return "passed";
  }
  return "pending";
}

function reviewTone(item: DockReviewItem): "info" | "warning" | "danger" | "muted" {
  if (item.severity === "danger" || item.status === "failed" || item.status === "blocked") {
    return "danger";
  }
  if (item.severity === "warning" || item.status === "pending") {
    return "warning";
  }
  if (item.severity === "info") {
    return "info";
  }
  return "muted";
}

function reviewRowTitle(item: DockReviewItem): string {
  return [
    item.sourceLabel,
    item.pathLabel ?? item.reason,
    item.timestampLabel,
  ].filter(Boolean).join(" · ");
}

function reviewStats(items: readonly DockReviewItem[]): { readonly additions: number; readonly deletions: number } | undefined {
  const additions = items.reduce((sum, item) => sum + (item.stats?.additions ?? 0), 0);
  const deletions = items.reduce((sum, item) => sum + (item.stats?.deletions ?? 0), 0);
  return additions > 0 || deletions > 0 ? { additions, deletions } : undefined;
}
