import type { ReactElement } from "react";
import { Tooltip } from "../../shared/ui/index.js";

export function SidebarTooltip({
  children,
  label,
}: {
  readonly children: ReactElement;
  readonly label: string;
}): React.JSX.Element {
  return (
    <Tooltip content={label} side="right" sideOffset={8}>
      {children}
    </Tooltip>
  );
}
