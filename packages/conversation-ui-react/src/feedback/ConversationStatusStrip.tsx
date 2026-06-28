import type { ReactNode } from "react";

export interface ConversationStatusMetaItem {
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
}

export interface ConversationStatusAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onClick: () => void;
}

export interface ConversationStatusStripProps {
  readonly className?: string;
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: ReactNode;
  readonly statusNode?: ReactNode;
  readonly metaItems?: readonly ConversationStatusMetaItem[];
  readonly actions?: readonly ConversationStatusAction[];
}

export function ConversationStatusStrip({
  className,
  icon,
  title,
  description,
  statusNode,
  metaItems = [],
  actions = [],
}: ConversationStatusStripProps): JSX.Element {
  const rootClassName = ["conversation-status-strip", !icon ? "no-icon" : "", className].filter(Boolean).join(" ");

  return (
    <div className={rootClassName} role="status" aria-live="polite">
      {icon ? <span className="conversation-status-icon">{icon}</span> : null}
      <div className="conversation-status-main">
        <span className="conversation-status-title">
          <strong>{title}</strong>
          {statusNode}
        </span>
        {description ? <p>{description}</p> : null}
        {metaItems.length > 0 ? (
          <div className="conversation-status-meta">
            {metaItems.map((item) => (
              <span key={item.id}>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {actions.length > 0 ? (
        <div className="conversation-status-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              className={action.danger ? "secondary-button danger compact-button" : "secondary-button compact-button"}
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.label}
              aria-label={action.label}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
