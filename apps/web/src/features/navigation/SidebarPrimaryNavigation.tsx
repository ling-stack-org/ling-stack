import type {
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { Clapperboard, Inbox, Kanban, PlugZap, Timer } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { SidebarTarget, ViewId } from "../../app/view-types.js";

export type SidebarTooltipBindings = {
  readonly "data-sidebar-tooltip": string;
  readonly onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
  readonly onBlur: (event: ReactFocusEvent<HTMLElement>) => void;
};

export function SidebarPrimaryNavigation({
  activeSidebarTarget,
  inboxTooltip,
  onOpenView,
  tooltipProps,
}: {
  readonly activeSidebarTarget: SidebarTarget;
  readonly inboxTooltip: string;
  readonly onOpenView: (view: ViewId) => void;
  readonly tooltipProps: (label: string) => SidebarTooltipBindings;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <nav className="primary-nav">
      <NavItem icon={<Inbox />} label={t("Inbox")} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} tooltipProps={tooltipProps(inboxTooltip)} />
      <NavItem icon={<Clapperboard />} label={t("Media Production")} active={activeSidebarTarget === "media"} onClick={() => onOpenView("media")} tooltipProps={tooltipProps(t("Media Production"))} />
      <NavItem icon={<Kanban />} label={t("Work Board")} active={activeSidebarTarget === "work_board"} onClick={() => onOpenView("work_board")} tooltipProps={tooltipProps(t("Work Board"))} />
      <NavItem icon={<PlugZap />} label={t("Plugin Manager")} active={activeSidebarTarget === "plugins"} onClick={() => onOpenView("plugins")} tooltipProps={tooltipProps(t("Plugin Manager"))} />
      <NavItem icon={<Timer />} label={t("Automations")} active={activeSidebarTarget === "automations"} onClick={() => onOpenView("automations")} tooltipProps={tooltipProps(t("Automations"))} />
    </nav>
  );
}
function NavItem({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
  ariaLabel,
  tooltipProps,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly ariaLabel?: string;
  readonly tooltipProps?: SidebarTooltipBindings;
}): JSX.Element {
  return (
    <button className={active ? "nav-item active" : "nav-item"} type="button" disabled={disabled} onClick={onClick} aria-label={ariaLabel ?? label} title={ariaLabel ?? label} {...tooltipProps}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
