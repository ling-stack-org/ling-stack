import type { ReactNode } from "react";
import { EmptyState } from "@ling-stack/ui-react";

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
    <EmptyState
      className={className}
      compact
      icon={icon}
      title={title}
      description={description}
    />
  );
}
