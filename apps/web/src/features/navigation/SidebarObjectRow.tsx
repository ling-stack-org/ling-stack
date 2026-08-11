import type { ReactNode } from "react";
import { Button } from "../../shared/ui/index.js";
import { SidebarTooltip } from "./SidebarTooltip.js";

export function SidebarObjectRow({
  actions,
  actionsLabel,
  ariaLabel,
  buttonClassName,
  children,
  icon,
  onSelect,
  selected = false,
  shellClassName,
  status,
  statusId,
  tooltip = ariaLabel,
}: {
  readonly actions?: ReactNode;
  readonly actionsLabel?: string;
  readonly ariaLabel: string;
  readonly buttonClassName?: string;
  readonly children: ReactNode;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
  readonly selected?: boolean;
  readonly shellClassName?: string;
  readonly status?: ReactNode;
  readonly statusId?: string;
  readonly tooltip?: string;
}): React.JSX.Element {
  const shellClasses = ["sidebar-row-shell", shellClassName, selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  const buttonClasses = ["sidebar-row-main", buttonClassName].filter(Boolean).join(" ");

  return (
    <div className={shellClasses} data-sidebar-row-status={statusId}>
      <SidebarTooltip label={tooltip}>
        <Button
          aria-current={selected ? "page" : undefined}
          aria-label={ariaLabel}
          className={buttonClasses}
          leadingIcon={icon}
          onClick={onSelect}
          variant="ghost"
        >
          {children}
        </Button>
      </SidebarTooltip>
      {status ? <span className="sidebar-row-status">{status}</span> : null}
      {actions ? (
        <span className="sidebar-row-tools" aria-label={actionsLabel}>
          {actions}
        </span>
      ) : null}
    </div>
  );
}
