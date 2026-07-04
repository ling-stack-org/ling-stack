import type { ReactNode } from "react";

export function OperationEmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
  className = "",
}: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly secondaryAction?: ReactNode;
  readonly compact?: boolean;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={["operation-empty-state", compact ? "compact" : "", className].filter(Boolean).join(" ")}>
      {icon ? <span className="operation-empty-state-icon" aria-hidden="true">{icon}</span> : null}
      <span className="operation-empty-state-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      {action || secondaryAction ? (
        <span className="operation-empty-state-actions">
          {secondaryAction}
          {action}
        </span>
      ) : null}
    </div>
  );
}
