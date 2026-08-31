import { Clapperboard, Inbox, PlugZap, Timer, type LucideIcon } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { SidebarTarget, ViewId } from "../../app/view-types.js";
import { Button, Icon, IconButton } from "../../shared/ui/index.js";
import { SidebarTooltip } from "./SidebarTooltip.js";

export function SidebarPrimaryNavigation({
  activeSidebarTarget,
  compact = false,
  onOpenView,
}: {
  readonly activeSidebarTarget: SidebarTarget;
  readonly compact?: boolean;
  readonly onOpenView: (view: ViewId) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <nav className={compact ? "primary-nav primary-nav-compact" : "primary-nav"}>
      <NavItem compact={compact} icon={Inbox} label={t("Inbox")} active={activeSidebarTarget === "approvals"} hidden pendingView="approvals" onClick={() => onOpenView("approvals")} />
      <NavItem compact={compact} icon={Clapperboard} label={t("Media Production")} active={activeSidebarTarget === "media"} onClick={() => onOpenView("media")} />
      <NavItem compact={compact} icon={PlugZap} label={t("Plugin Manager")} active={activeSidebarTarget === "plugins"} onClick={() => onOpenView("plugins")} />
      <NavItem compact={compact} icon={Timer} label={t("Automations")} active={activeSidebarTarget === "automations"} onClick={() => onOpenView("automations")} />
    </nav>
  );
}
function NavItem({
  icon,
  label,
  active = false,
  compact = false,
  disabled = false,
  onClick,
  ariaLabel,
  tooltip,
  hidden = false,
  pendingView,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active?: boolean;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly ariaLabel?: string;
  readonly tooltip?: string;
  readonly hidden?: boolean;
  readonly pendingView?: ViewId;
}): React.JSX.Element {
  if (compact) {
    return (
      <SidebarTooltip label={tooltip ?? ariaLabel ?? label}>
        <IconButton
          aria-current={active ? "page" : undefined}
          className={active ? "nav-item active" : "nav-item"}
          data-pending-primary-view={pendingView}
          disabled={disabled}
          hidden={hidden}
          icon={icon}
          label={ariaLabel ?? label}
          onClick={onClick}
          pressed={active}
          tooltip=""
        />
      </SidebarTooltip>
    );
  }

  return (
    <SidebarTooltip label={tooltip ?? ariaLabel ?? label}>
      <Button
        aria-current={active ? "page" : undefined}
        aria-label={ariaLabel ?? label}
        className={active ? "nav-item active" : "nav-item"}
        data-pending-primary-view={pendingView}
        disabled={disabled}
        hidden={hidden}
        leadingIcon={<Icon icon={icon} size="md" />}
        onClick={onClick}
        variant="ghost"
      >
        {label}
      </Button>
    </SidebarTooltip>
  );
}
