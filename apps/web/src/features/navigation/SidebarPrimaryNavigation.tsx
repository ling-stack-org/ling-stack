import { Clapperboard, Inbox, Kanban, PlugZap, Timer, type LucideIcon } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { SidebarTarget, ViewId } from "../../app/view-types.js";
import { Button, Icon } from "../../shared/ui/index.js";
import { SidebarTooltip } from "./SidebarTooltip.js";

export function SidebarPrimaryNavigation({
  activeSidebarTarget,
  inboxTooltip,
  onOpenView,
}: {
  readonly activeSidebarTarget: SidebarTarget;
  readonly inboxTooltip: string;
  readonly onOpenView: (view: ViewId) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <nav className="primary-nav">
      <NavItem icon={Inbox} label={t("Inbox")} tooltip={inboxTooltip} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} />
      <NavItem icon={Clapperboard} label={t("Media Production")} active={activeSidebarTarget === "media"} onClick={() => onOpenView("media")} />
      <NavItem icon={Kanban} label={t("Work Board")} active={activeSidebarTarget === "work_board"} onClick={() => onOpenView("work_board")} />
      <NavItem icon={PlugZap} label={t("Plugin Manager")} active={activeSidebarTarget === "plugins"} onClick={() => onOpenView("plugins")} />
      <NavItem icon={Timer} label={t("Automations")} active={activeSidebarTarget === "automations"} onClick={() => onOpenView("automations")} />
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
  tooltip,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly ariaLabel?: string;
  readonly tooltip?: string;
}): JSX.Element {
  return (
    <SidebarTooltip label={tooltip ?? ariaLabel ?? label}>
      <Button
        aria-current={active ? "page" : undefined}
        aria-label={ariaLabel ?? label}
        className={active ? "nav-item active" : "nav-item"}
        disabled={disabled}
        leadingIcon={<Icon icon={icon} size="md" />}
        onClick={onClick}
        variant="ghost"
      >
        {label}
      </Button>
    </SidebarTooltip>
  );
}
