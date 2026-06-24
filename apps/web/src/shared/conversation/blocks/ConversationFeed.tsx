import { Fragment, type ReactNode } from "react";
import { ConversationEmptyState } from "./ConversationEmptyState.js";

export interface ConversationFeedProps<TItem> {
  readonly className?: string;
  readonly emptyClassName?: string;
  readonly items: readonly TItem[];
  readonly loading?: boolean;
  readonly dayLabel?: string;
  readonly emptyLabel: string;
  readonly emptyIcon?: ReactNode;
  readonly getItemId: (item: TItem) => string;
  readonly renderItem: (item: TItem) => ReactNode;
}

export function ConversationFeed<TItem>({
  className,
  emptyClassName,
  items,
  loading = false,
  dayLabel,
  emptyLabel,
  emptyIcon,
  getItemId,
  renderItem,
}: ConversationFeedProps<TItem>): JSX.Element {
  const rootClassName = [className ?? "conversation-feed", items.length === 0 ? "empty" : ""].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      {dayLabel ? <div className="teammate-chat-day-separator conversation-day-separator">{dayLabel}</div> : null}
      {loading ? (
        <ConversationEmptyState className={emptyClassName} label={emptyLabel} loading />
      ) : items.length === 0 ? (
        <ConversationEmptyState className={emptyClassName} icon={emptyIcon} label={emptyLabel} />
      ) : (
        items.map((item) => <Fragment key={getItemId(item)}>{renderItem(item)}</Fragment>)
      )}
    </div>
  );
}
