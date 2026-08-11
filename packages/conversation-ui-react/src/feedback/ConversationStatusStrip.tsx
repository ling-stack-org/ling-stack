import { Button } from "@ling-stack/ui-react";
import type { ReactNode } from "react";

export interface ConversationStatusMetaItem {
  readonly id: string;
  readonly label?: string;
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
}: ConversationStatusStripProps): React.JSX.Element {
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
                {item.label ? <small>{item.label}</small> : null}
                <strong>{item.value}</strong>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {actions.length > 0 ? (
        <div className="conversation-status-actions">
          {actions.map((action) => (
            <Button
              key={action.id}
              className="conversation-status-action"
              disabled={action.disabled}
              leadingIcon={action.icon}
              onClick={action.onClick}
              size="sm"
              title={action.label}
              aria-label={action.label}
              variant={action.danger ? "danger" : "secondary"}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
