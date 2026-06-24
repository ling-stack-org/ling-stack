import type { ReactNode } from "react";

export interface RightDrawerNavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export interface RightDrawerProps {
  readonly className?: string;
  readonly ariaLabel: string;
  readonly title: string;
  readonly icon?: ReactNode;
  readonly actions?: ReactNode;
  readonly navLabel?: string;
  readonly navItems?: readonly RightDrawerNavItem[];
  readonly children: ReactNode;
}

export function RightDrawer({
  className = "right-drawer",
  ariaLabel,
  title,
  icon,
  actions,
  navLabel,
  navItems = [],
  children,
}: RightDrawerProps): JSX.Element {
  return (
    <aside className={className} aria-label={ariaLabel}>
      <div className="right-drawer-head">
        <span className="right-drawer-title">
          {icon}
          <strong>{title}</strong>
        </span>
        {actions ? <div className="right-drawer-actions">{actions}</div> : null}
      </div>
      {navItems.length > 0 ? (
        <div className="right-drawer-nav" aria-label={navLabel ?? title}>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={item.active ? "right-drawer-nav-item active" : "right-drawer-nav-item"}
              type="button"
              onClick={item.onSelect}
              disabled={item.disabled}
              aria-label={item.label}
              title={item.label}
            >
              {item.icon}
            </button>
          ))}
        </div>
      ) : null}
      <div className="right-drawer-body">{children}</div>
    </aside>
  );
}
