import type { ReactNode } from "react";

export interface DockEmptyStateProps {
  readonly className?: string;
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
}

export function DockEmptyState({
  className = "right-dock-empty",
  icon,
  title,
  description,
}: DockEmptyStateProps): JSX.Element {
  return (
    <div className={className}>
      {icon ? <span className="right-dock-empty-icon">{icon}</span> : null}
      <strong>{title}</strong>
      {description ? <small>{description}</small> : null}
    </div>
  );
}
