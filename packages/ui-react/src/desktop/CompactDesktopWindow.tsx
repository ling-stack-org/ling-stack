import { MoreHorizontal } from "lucide-react";
import { forwardRef, Fragment, type HTMLAttributes, type ReactNode, useRef } from "react";
import { IconButton, type IconButtonProps } from "../controls/IconButton.js";
import { Button } from "../controls/Button.js";
import { Spinner } from "../feedback/Spinner.js";
import { StatusIndicator, type StatusTone } from "../feedback/StatusIndicator.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../overlays/Menu.js";
import { Tooltip } from "../overlays/Tooltip.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type CompactWindowState = "live" | "busy" | "attention" | "terminal";

export interface CompactDesktopWindowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "content"> {
  readonly content: ReactNode;
  readonly controlsVisibility?: "hover-focus" | "persistent";
  readonly header: ReactNode;
  readonly label: string;
  readonly state: CompactWindowState;
  readonly status?: ReactNode;
  readonly visualState?: string;
}

export function CompactDesktopWindow({
  className,
  content,
  controlsVisibility = "hover-focus",
  header,
  label,
  state,
  status,
  visualState,
  ...props
}: CompactDesktopWindowProps) {
  return (
    <section
      {...props}
      aria-label={label}
      className={mergeClassNames("ling-ui-compact-window", className)}
      data-controls-visibility={controlsVisibility}
      data-state={visualState ?? state}
      data-window-state={state}
    >
      {header}
      <div className="ling-ui-compact-window-content">{content}</div>
      {status}
    </section>
  );
}

export interface CompactWindowHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "children" | "title"> {
  readonly actions?: ReactNode;
  readonly status?: ReactNode;
  readonly title: ReactNode;
}

export function CompactWindowHeader({ actions, className, status, title, ...props }: CompactWindowHeaderProps) {
  return (
    <header {...props} className={mergeClassNames("ling-ui-compact-window-header", className)}>
      <div className="ling-ui-compact-window-header-identity">
        <span className="ling-ui-compact-window-title">{title}</span>
        {status ? <span className="ling-ui-compact-window-header-status">{status}</span> : null}
      </div>
      {actions ? <div className="ling-ui-compact-window-header-actions">{actions}</div> : null}
    </header>
  );
}

export const CompactWindowIconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function CompactWindowIconButton(props, ref) {
    return (
      <IconButton
        {...props}
        ref={ref}
        className={mergeClassNames("ling-ui-compact-window-icon-button", props.className)}
      />
    );
  },
);

export interface CompactWindowStatusOverlayProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly action?: {
    readonly actionId?: string;
    readonly className?: string;
    readonly label: string;
    readonly loading?: boolean;
    readonly onClick: () => void;
  };
  readonly ariaLive?: "polite" | "assertive";
  readonly busy?: boolean;
  readonly detail?: ReactNode;
  readonly label: ReactNode;
  readonly tone?: StatusTone;
}

export function CompactWindowStatusOverlay({
  action,
  ariaLive,
  busy = false,
  className,
  detail,
  label,
  tone = "neutral",
  ...props
}: CompactWindowStatusOverlayProps) {
  return (
    <div
      {...props}
      className={mergeClassNames("ling-ui-compact-window-status", className)}
      data-tone={tone}
      aria-live={ariaLive}
      aria-atomic="true"
      role={ariaLive === "assertive" || tone === "danger" ? "alert" : "status"}
    >
      <div className="ling-ui-compact-window-status-copy">
        <StatusIndicator label={label} tone={tone} />
        {detail ? <div className="ling-ui-compact-window-status-detail">{detail}</div> : null}
      </div>
      {action ? (
        <Button
          className={action.className}
          data-action-id={action.actionId}
          loading={action.loading}
          onClick={action.onClick}
          size="sm"
          variant={tone === "danger" ? "danger" : "secondary"}
        >
          {action.label}
        </Button>
      ) : busy ? <Spinner size="sm" /> : null}
    </div>
  );
}

export interface CompactWindowMenuAction {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly separatorBefore?: boolean;
  readonly tone?: "default" | "danger";
}

export interface CompactWindowActionMenuProps {
  readonly actions: readonly CompactWindowMenuAction[];
  readonly contentClassName?: string;
  readonly label: string;
  readonly menuLabel?: string;
  readonly onOpenChange?: (open: boolean) => void;
  readonly open?: boolean;
  readonly triggerClassName?: string;
}

export function CompactWindowActionMenu({
  actions,
  contentClassName,
  label,
  menuLabel = label,
  onOpenChange,
  open,
  triggerClassName,
}: CompactWindowActionMenuProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const handleOpenChange = (nextOpen: boolean): void => {
    onOpenChange?.(nextOpen);
    if (nextOpen) {
      window.requestAnimationFrame(() => contentRef.current
        ?.querySelector<HTMLElement>("[role=menuitem]:not([data-disabled])")
        ?.focus());
    }
  };

  return (
    <Menu modal={false} onOpenChange={handleOpenChange} open={open}>
      <Tooltip content={label}>
        <MenuTrigger asChild>
          <CompactWindowIconButton
            className={triggerClassName}
            icon={MoreHorizontal}
            label={label}
            tooltip=""
          />
        </MenuTrigger>
      </Tooltip>
      <MenuContent
        align="end"
        aria-label={menuLabel}
        className={mergeClassNames("ling-ui-compact-window-menu", contentClassName)}
        loop
        ref={contentRef}
      >
        {actions.map((action) => (
          <Fragment key={action.id}>
            {action.separatorBefore ? <MenuSeparator /> : null}
            <MenuItem
              className={action.className}
              data-action-id={action.id}
              disabled={action.disabled}
              onSelect={action.onSelect}
              tone={action.tone}
            >
              {action.icon ? <span className="ling-ui-menu-item-icon" aria-hidden="true">{action.icon}</span> : null}
              <span>{action.label}</span>
            </MenuItem>
          </Fragment>
        ))}
      </MenuContent>
    </Menu>
  );
}
