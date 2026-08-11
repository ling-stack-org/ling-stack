import { Fragment, type ReactNode, type Ref, type UIEventHandler } from "react";
import { ConversationEmptyState } from "./ConversationEmptyState.js";

export interface ConversationFeedProps<TItem> {
  readonly className?: string;
  readonly emptyClassName?: string;
  readonly ariaLabel?: string;
  readonly rootRef?: Ref<HTMLDivElement>;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
  readonly items: readonly TItem[];
  readonly loading?: boolean;
  readonly dayLabel?: string;
  readonly emptyLabel: string;
  readonly emptyDescription?: string;
  readonly emptyIcon?: ReactNode;
  readonly getItemId: (item: TItem) => string;
  readonly renderItem: (item: TItem) => ReactNode;
}

export function ConversationFeed<TItem>({
  className,
  emptyClassName,
  ariaLabel,
  rootRef,
  onScroll,
  items,
  loading = false,
  dayLabel,
  emptyLabel,
  emptyDescription,
  emptyIcon,
  getItemId,
  renderItem,
}: ConversationFeedProps<TItem>): React.JSX.Element {
  const rootClassName = [className ?? "conversation-feed", items.length === 0 ? "empty" : ""].filter(Boolean).join(" ");

  return (
    <div ref={rootRef} className={rootClassName} aria-label={ariaLabel} onScroll={onScroll}>
      {dayLabel ? <div className="teammate-chat-day-separator conversation-day-separator">{dayLabel}</div> : null}
      {loading ? (
        <ConversationEmptyState className={emptyClassName} label={emptyLabel} loading />
      ) : items.length === 0 ? (
        <ConversationEmptyState className={emptyClassName} icon={emptyIcon} label={emptyLabel} description={emptyDescription} />
      ) : (
        items.map((item) => <Fragment key={getItemId(item)}>{renderItem(item)}</Fragment>)
      )}
    </div>
  );
}
