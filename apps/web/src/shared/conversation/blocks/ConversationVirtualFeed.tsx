import { useCallback, useEffect, type KeyboardEventHandler, type MouseEventHandler, type PointerEventHandler, type RefObject, type ReactNode, type UIEventHandler } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { ConversationEmptyState } from "./ConversationEmptyState.js";
import { conversationDeferredContentReadyEvent } from "./deferred-rendering.js";
import { useConversationViewReconciliation } from "../view-store/use-conversation-view-reconciliation.js";
import type { ConversationViewRetainKeys } from "../view-store/conversation-view-store.js";

export interface ConversationVirtualFeedProps<TItem> {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly ariaLabel: string;
  readonly className?: string;
  readonly feedClassName?: string;
  readonly emptyFeedClassName?: string;
  readonly loading?: boolean;
  readonly empty?: boolean;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly emptyDescription?: string;
  readonly emptyIcon?: ReactNode;
  readonly totalSize: number;
  readonly virtualRows: readonly VirtualItem[];
  readonly items: readonly TItem[];
  readonly getItemId: (item: TItem) => string;
  readonly getItemKind: (item: TItem) => string;
  readonly renderItem: (item: TItem, index: number) => ReactNode;
  readonly measureElement: (node: HTMLDivElement | null) => void;
  readonly viewStateRetainKeys?: ConversationViewRetainKeys;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
  readonly onUserScrollIntent?: () => void;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly onPointerDown?: PointerEventHandler<HTMLDivElement>;
  readonly onPointerMove?: PointerEventHandler<HTMLDivElement>;
  readonly onPointerUp?: PointerEventHandler<HTMLDivElement>;
  readonly onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  readonly onContextMenu?: MouseEventHandler<HTMLDivElement>;
  readonly title?: string;
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
  emptyDescription,
  emptyIcon,
  totalSize,
  virtualRows,
  items,
  getItemId,
  getItemKind,
  renderItem,
  measureElement,
  viewStateRetainKeys,
  onScroll,
  onUserScrollIntent,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onContextMenu,
  title,
  statusNode,
  latestButtonNode,
}: ConversationVirtualFeedProps<TItem>): React.JSX.Element {
  useConversationViewReconciliation(viewStateRetainKeys);

  const resolvedFeedClassName = [feedClassName, empty ? emptyFeedClassName : ""].filter(Boolean).join(" ");
  const showLoadingState = loading && items.length === 0;
  const handleMeasureElement = useCallback((node: HTMLDivElement | null) => {
    measureElement(node);
  }, [measureElement]);

  useEffect(() => {
    const feed = scrollRef.current;
    if (!feed) {
      return undefined;
    }
    const handleDeferredContentReady = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const row = target.closest<HTMLDivElement>(".message-feed-virtual-row");
      if (!row) {
        return;
      }
      measureElement(row);
    };
    feed.addEventListener(conversationDeferredContentReadyEvent, handleDeferredContentReady);
    return () => feed.removeEventListener(conversationDeferredContentReadyEvent, handleDeferredContentReady);
  }, [measureElement, scrollRef]);

  return (
    <div className={className}>
      <div
        ref={scrollRef}
        className={resolvedFeedClassName}
        aria-label={ariaLabel}
        title={title}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={onContextMenu}
        onWheel={onUserScrollIntent ? () => onUserScrollIntent() : undefined}
        onTouchMove={onUserScrollIntent ? () => onUserScrollIntent() : undefined}
      >
        {showLoadingState ? (
          <ConversationEmptyState className="client-empty-state" label={loadingLabel} loading />
        ) : empty ? (
          <ConversationEmptyState className="client-empty-state message-feed-empty-state" icon={emptyIcon} label={emptyLabel} description={emptyDescription} />
        ) : (
          <div className="message-feed-virtualizer" style={{ height: `${totalSize}px` }}>
            {virtualRows.map((virtualRow) => {
              const item = items[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  ref={handleMeasureElement}
                  className="message-feed-virtual-row"
                  tabIndex={-1}
                  data-conversation-focus-block={item ? "true" : undefined}
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
