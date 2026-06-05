import type { ReactNode } from "react";

export interface MessageFooterAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly className?: string;
  readonly href?: string;
  readonly target?: string;
  readonly rel?: string;
  readonly onClick?: () => void;
}

export interface MessageFooterActionsProps {
  readonly className?: string;
  readonly actions: readonly MessageFooterAction[];
}

export function MessageFooterActions({
  className,
  actions,
}: MessageFooterActionsProps): JSX.Element | null {
  const visibleActions = actions.filter((action) => action.href || action.onClick);
  if (visibleActions.length === 0) {
    return null;
  }

  const rootClassName = ["message-footer-actions", className].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      {visibleActions.map((action) => {
        const actionClassName = [
          "message-footer-action",
          action.className,
          action.danger ? "danger" : "",
        ].filter(Boolean).join(" ");
        const content = (
          <>
            {action.icon}
            <span>{action.label}</span>
          </>
        );
        if (action.href) {
          return (
            <a
              key={action.id}
              className={actionClassName}
              href={action.href}
              target={action.target}
              rel={action.rel}
              aria-label={action.label}
              title={action.label}
            >
              {content}
            </a>
          );
        }
        return (
          <button
            key={action.id}
            className={actionClassName}
            type="button"
            disabled={action.disabled}
            onClick={action.onClick}
            aria-label={action.label}
            title={action.label}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
