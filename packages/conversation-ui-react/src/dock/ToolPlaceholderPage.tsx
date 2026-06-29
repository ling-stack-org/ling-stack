import type { ReactNode } from "react";
import { DockEmptyState } from "./DockEmptyState.js";

export interface ToolPlaceholderPageProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}

export function ToolPlaceholderPage({
  icon,
  title,
  description,
  children,
}: ToolPlaceholderPageProps): JSX.Element {
  return (
    <div className="right-dock-tool-page">
      {children ?? <DockEmptyState icon={icon} title={title} description={description} />}
    </div>
  );
}
