import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface WorkspaceTopRightToolbarProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function WorkspaceTopRightToolbar({
  ariaLabel,
  className,
  children,
}: WorkspaceTopRightToolbarProps): JSX.Element {
  return (
    <div className={joinClassNames("workspace-top-right-toolbar", className)} aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export interface WorkspaceToolbarCountBadgeProps {
  readonly count: number | string;
  readonly className?: string;
}

export function WorkspaceToolbarCountBadge({
  count,
  className,
}: WorkspaceToolbarCountBadgeProps): JSX.Element {
  return <span className={joinClassNames("workspace-toolbar-count-badge", className)}>{count}</span>;
}

export interface WorkspaceToolbarIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly active?: boolean;
  readonly count?: number;
  readonly icon: ReactNode;
  readonly label: string;
}

export const WorkspaceToolbarIconButton = forwardRef<HTMLButtonElement, WorkspaceToolbarIconButtonProps>(function WorkspaceToolbarIconButton(
  {
    active = false,
    className,
    count,
    icon,
    label,
    title,
    type = "button",
    ...buttonProps
  },
  ref,
) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      className={joinClassNames("workspace-toolbar-icon-button", active && "active", className)}
      type={type}
      aria-label={buttonProps["aria-label"] ?? label}
      title={title ?? label}
    >
      <span className="workspace-toolbar-icon" aria-hidden="true">
        {icon}
      </span>
      {typeof count === "number" && count > 0 ? <WorkspaceToolbarCountBadge count={count} /> : null}
    </button>
  );
});

export interface WorkspaceToolbarActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly active?: boolean;
  readonly count?: number;
  readonly icon: ReactNode;
  readonly label: string;
  readonly visibleLabel: string;
}

export const WorkspaceToolbarActionButton = forwardRef<HTMLButtonElement, WorkspaceToolbarActionButtonProps>(function WorkspaceToolbarActionButton(
  {
    active = false,
    className,
    count,
    icon,
    label,
    title,
    type = "button",
    visibleLabel,
    ...buttonProps
  },
  ref,
) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      className={joinClassNames("workspace-toolbar-action-button", active && "active", className)}
      type={type}
      aria-label={buttonProps["aria-label"] ?? label}
      title={title ?? label}
    >
      <span className="workspace-toolbar-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="workspace-toolbar-action-label">{visibleLabel}</span>
      {typeof count === "number" && count > 0 ? <WorkspaceToolbarCountBadge className="inline" count={count} /> : null}
    </button>
  );
});
