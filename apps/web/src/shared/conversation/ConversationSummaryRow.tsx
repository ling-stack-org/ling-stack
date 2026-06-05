import type { ReactNode } from "react";

export interface ConversationSummaryMetaItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ConversationSummaryRowProps {
  readonly className?: string;
  readonly icon?: ReactNode;
  readonly title: string;
  readonly statusNode?: ReactNode;
  readonly body: ReactNode;
  readonly metaItems?: readonly ConversationSummaryMetaItem[];
  readonly evidenceNode?: ReactNode;
  readonly actionsNode?: ReactNode;
}

export function ConversationSummaryRow({
  className,
  icon,
  title,
  statusNode,
  body,
  metaItems = [],
  evidenceNode,
  actionsNode,
}: ConversationSummaryRowProps): JSX.Element {
  const rootClassName = ["conversation-summary-row", className].filter(Boolean).join(" ");

  return (
    <article className={rootClassName}>
      {icon ? <span className="conversation-summary-icon">{icon}</span> : null}
      <div className="conversation-summary-body">
        <header>
          <strong>{title}</strong>
          {statusNode}
        </header>
        <div className="conversation-summary-copy">{body}</div>
        {metaItems.length > 0 ? (
          <div className="conversation-summary-meta">
            {metaItems.map((item) => (
              <span key={item.id}>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
              </span>
            ))}
          </div>
        ) : null}
        {evidenceNode}
        {actionsNode}
      </div>
    </article>
  );
}
