import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "../../shared/ui/index.js";

export function SidebarTooltip({
  children,
  className,
  label,
}: {
  readonly children: ReactElement;
  readonly className?: string;
  readonly label: ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip className={className} content={label} side="right" sideOffset={8}>
      {children}
    </Tooltip>
  );
}
