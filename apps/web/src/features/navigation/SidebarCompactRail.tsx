import {
  Bot,
  Hash,
  MessageSquare,
  Plus,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { SidebarTarget, ViewId } from "../../app/view-types.js";
import { IconButton } from "../../shared/ui/index.js";
import { SidebarPrimaryNavigation } from "./SidebarPrimaryNavigation.js";
import { SidebarTooltip } from "./SidebarTooltip.js";

export function SidebarCompactRail({
  activeSidebarTarget,
  selectedRecentConversationId,
  onExpand,
  onOpenConversationHome,
  onOpenView,
}: {
  readonly activeSidebarTarget: SidebarTarget;
  readonly selectedRecentConversationId: string;
  readonly onExpand: () => void;
  readonly onOpenConversationHome: () => void;
  readonly onOpenView: (view: ViewId) => void;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <aside
      aria-label={t("Sidebar display")}
      className="left-nav sidebar-compact-rail"
      data-sidebar-mode="compact"
    >
      <div className="sidebar-compact-rail-top">
        <RailAction
          active={activeSidebarTarget === "workspace" && !selectedRecentConversationId}
          icon={Plus}
          label={t("New conversation")}
          onClick={onOpenConversationHome}
        />
        <SidebarPrimaryNavigation
          activeSidebarTarget={activeSidebarTarget}
          compact
          onOpenView={onOpenView}
        />
      </div>

      <nav className="sidebar-compact-rail-sections" aria-label={t("Recent")}>
        <RailAction
          active={activeSidebarTarget.startsWith("channel:")}
          icon={Hash}
          label={t("Channels")}
          onClick={onExpand}
          section="channels"
        />
        <RailAction
          active={activeSidebarTarget.startsWith("teammate:")}
          icon={Bot}
          label={t("AI Teammates")}
          onClick={onExpand}
          section="teammates"
        />
        <RailAction
          active={activeSidebarTarget === "workspace" && Boolean(selectedRecentConversationId)}
          icon={MessageSquare}
          label={t("Recent conversations")}
          onClick={onExpand}
          section="recent"
        />
      </nav>

      <div className="sidebar-compact-rail-bottom">
        <RailAction
          active={activeSidebarTarget === "settings"}
          icon={Settings}
          label={t("Settings")}
          onClick={() => onOpenView("settings")}
        />
      </div>
    </aside>
  );
}

function RailAction({
  active = false,
  icon,
  label,
  onClick,
  section,
}: {
  readonly active?: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick: () => void;
  readonly section?: "channels" | "teammates" | "recent";
}): React.JSX.Element {
  return (
    <SidebarTooltip label={label}>
      <IconButton
        className={[
          "sidebar-compact-rail-action",
          section ? "sidebar-rail-launcher" : "",
          active ? "active" : "",
        ].filter(Boolean).join(" ")}
        data-sidebar-rail-launcher={section}
        icon={icon}
        label={label}
        onClick={onClick}
        pressed={active}
        tooltip=""
      />
    </SidebarTooltip>
  );
}
