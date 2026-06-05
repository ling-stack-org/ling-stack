import type { RefObject, ReactNode, UIEventHandler } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { ConversationEmptyState } from "./ConversationEmptyState.js";

export interface ConversationVirtualFeedProps<TItem> {
  readonly scrollRef: RefObject<HTMLDivElement>;
  readonly ariaLabel: string;
  readonly className?: string;
  readonly feedClassName?: string;
  readonly emptyFeedClassName?: string;
  readonly loading?: boolean;
  readonly empty?: boolean;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly emptyIcon?: ReactNode;
  readonly totalSize: number;
  readonly virtualRows: readonly VirtualItem[];
  readonly items: readonly TItem[];
  readonly getItemId: (item: TItem) => string;
  readonly getItemKind: (item: TItem) => string;
  readonly renderItem: (item: TItem, index: number) => ReactNode;
  readonly measureElement: (node: HTMLDivElement | null) => void;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
  readonly statusNode?: ReactNode;
  readonly latestButtonNode?: ReactNode;
}

export function ConversationVirtualFeed<TItem>({
  scrollRef,
  ariaLabel,
  className = "message-feed-wrap",
  feedClassName = "message-feed",
  emptyFeedClassName = "message-feed-empty",
  loading = false,
  empty = false,
  loadingLabel,
  emptyLabel,
  emptyIcon,
  totalSize,
  virtualRows,
  items,
  getItemId,
  getItemKind,
  renderItem,
  measureElement,
  onScroll,
  statusNode,
  latestButtonNode,
}: ConversationVirtualFeedProps<TItem>): JSX.Element {
  const resolvedFeedClassName = [feedClassName, empty ? emptyFeedClassName : ""].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <div ref={scrollRef} className={resolvedFeedClassName} aria-label={ariaLabel} onScroll={onScroll}>
        {loading ? (
          <ConversationEmptyState className="client-empty-state" label={loadingLabel} loading />
        ) : empty ? (
          <ConversationEmptyState className="client-empty-state message-feed-empty-state" icon={emptyIcon} label={emptyLabel} />
        ) : (
          <div className="message-feed-virtualizer" style={{ height: `${totalSize}px` }}>
            {virtualRows.map((virtualRow) => {
              const item = items[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  ref={measureElement}
                  className="message-feed-virtual-row"
                  data-feed-item-id={item ? getItemId(item) : undefined}
                  data-feed-item-kind={item ? getItemKind(item) : undefined}
                  data-index={virtualRow.index}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {item ? renderItem(item, virtualRow.index) : null}
                </div>
              );
            })}
          </div>
        )}
        {statusNode}
      </div>
      {latestButtonNode}
    </div>
  );
}
