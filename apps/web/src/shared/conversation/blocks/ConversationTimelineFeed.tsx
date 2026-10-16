import type {
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
  ReactNode,
  RefObject,
  UIEventHandler,
} from "react";
import { ConversationFeed } from "@ling-stack/conversation-ui-react";
import { ConversationViewProvider } from "../view-store/conversation-view-provider.js";

export interface ConversationTimelineFeedProps {
  readonly surfaceId: string;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly ariaLabel: string;
  readonly timelineId: string;
  readonly timelineNode: ReactNode;
  readonly frameClassName?: string;
  readonly feedClassName?: string;
  readonly emptyFeedClassName?: string;
  readonly loading?: boolean;
  readonly empty?: boolean;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly emptyDescription?: string;
  readonly emptyIcon?: ReactNode;
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

/**
 * Shared scroll viewport for normal, private, and channel transcripts.
 * ConversationTimeline is the only display-row virtualizer rendered inside it;
 * this shell owns empty/loading chrome and never creates a second row window.
 */
export function ConversationTimelineFeed({
  ariaLabel,
  empty = false,
  emptyDescription,
  emptyFeedClassName,
  emptyIcon,
  emptyLabel,
  feedClassName = "message-feed",
  frameClassName = "message-feed-wrap",
  latestButtonNode,
  loading = false,
  loadingLabel,
  onContextMenu,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onScroll,
  onUserScrollIntent,
  scrollRef,
  statusNode,
  surfaceId,
  timelineId,
  timelineNode,
  title,
}: ConversationTimelineFeedProps): React.JSX.Element {
  const showLoading = loading && empty;
  const feedItems = empty ? [] : [{ id: timelineId, node: timelineNode }];
  const resolvedFeedClassName = [feedClassName, empty ? emptyFeedClassName : ""].filter(Boolean).join(" ");

  return (
    <ConversationViewProvider surfaceId={surfaceId}>
      <div className={frameClassName}>
        <ConversationFeed
          rootRef={scrollRef}
          rootProps={{
            "data-conversation-feed-viewport": "true",
            "data-conversation-feed-window-owner": "timeline",
            title,
            tabIndex: 0,
            onKeyDown: event => {
              onKeyDown?.(event);
              if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
              const target = event.target;
              if (target instanceof Element && target !== event.currentTarget && target.closest(
                'button, input, textarea, select, a[href], [contenteditable], [role="button"], [role="textbox"], [role="menu"]',
              )) return;
              if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
                onUserScrollIntent?.();
              }
            },
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            onContextMenu,
            onWheel: onUserScrollIntent ? () => onUserScrollIntent() : undefined,
            onTouchMove: onUserScrollIntent ? () => onUserScrollIntent() : undefined,
          }}
          onScroll={onScroll}
          className={resolvedFeedClassName}
          emptyClassName={showLoading ? "client-empty-state" : "client-empty-state message-feed-empty-state"}
          ariaLabel={ariaLabel}
          items={feedItems}
          loading={showLoading}
          emptyLabel={showLoading ? loadingLabel : emptyLabel}
          emptyDescription={emptyDescription}
          emptyIcon={emptyIcon}
          getItemId={(item) => item.id}
          renderItem={(item) => item.node}
          afterNode={statusNode}
        />
        {latestButtonNode}
      </div>
    </ConversationViewProvider>
  );
}
