import type { ReactNode } from "react";
import {
  Bot,
  Database,
  Hash,
  History,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Plus,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  channelSidebarTarget,
  teammateSidebarTarget,
  type SidebarTarget,
  type ViewId,
} from "../../app/view-types.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { AvatarInitial } from "../../shared/components/index.js";
import type { AiTeammate, ApprovalRequest, Channel } from "../../types.js";

export function SidebarNavigation({
  activeSidebarTarget,
  channels,
  teammates,
  approvals,
  onOpenView,
  onCreateChannel,
  onSelectChannel,
  onSelectTeammate,
  channelDrawer = false,
  channelDrawerOpen = true,
  onChannelDrawerOpenChange,
}: {
  readonly activeSidebarTarget: SidebarTarget;
  readonly channels: readonly Channel[];
  readonly teammates: readonly AiTeammate[];
  readonly approvals: readonly ApprovalRequest[];
  readonly onOpenView: (view: ViewId) => void;
  readonly onCreateChannel: () => void;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onSelectTeammate: (teammateId: string) => void;
  readonly channelDrawer?: boolean;
  readonly channelDrawerOpen?: boolean;
  readonly onChannelDrawerOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const visibleTeammates = teammates.filter((teammate) => !teammate.hidden && teammate.status !== "disabled");

  return (
    <>
      {channelDrawer ? (
        <div className="channel-sidebar-toolbar">
          <button
            className="channel-sidebar-switch"
            type="button"
            aria-label={channelDrawerOpen ? t("Hide navigation") : t("Show navigation")}
            title={channelDrawerOpen ? t("Hide navigation") : t("Show navigation")}
            onClick={() => onChannelDrawerOpenChange?.(!channelDrawerOpen)}
          >
            {channelDrawerOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
        </div>
      ) : null}
      <aside className={channelDrawer ? "left-nav channel-left-drawer" : "left-nav"} aria-label="Ling Stack navigation">
      <nav className="primary-nav">
        <NavItem icon={<PlugZap />} label={t("Model Workbench")} active={activeSidebarTarget === "providers"} onClick={() => onOpenView("providers")} />
        <NavItem icon={<History />} label={t("Runs")} active={activeSidebarTarget === "runs"} onClick={() => onOpenView("runs")} />
        <NavItem icon={<Inbox />} label={t("Inbox")} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} />
        <NavItem icon={<Database />} label={t("Media Jobs")} active={activeSidebarTarget === "media"} onClick={() => onOpenView("media")} />
        <NavItem icon={<Users />} label={t("AI Teammates")} active={activeSidebarTarget === "teammates"} onClick={() => onOpenView("teammates")} />
      </nav>

      <SidebarSection title={t("Channels")} actionLabel={t("New channel")} onAction={onCreateChannel}>
        {channels.length === 0 ? (
          <button className="sidebar-row muted-row" type="button" onClick={onCreateChannel}>
            <Hash size={14} />
            <span>{t("No channel yet")}</span>
          </button>
        ) : (
          channels.map((channel) => (
            <button
              key={channel.id}
              className={activeSidebarTarget === channelSidebarTarget(channel.id) ? "sidebar-row selected" : "sidebar-row"}
              type="button"
              onClick={() => onSelectChannel(channel.id)}
            >
              <Hash size={14} />
              <span>{channel.name}</span>
            </button>
          ))
        )}
      </SidebarSection>

      <SidebarSection title={t("AI Teammates")} actionLabel={visibleTeammates.length === 0 ? t("Create") : undefined}>
        {visibleTeammates.length === 0 ? (
          <button className="sidebar-row muted-row" type="button" onClick={() => onOpenView("teammates")}>
            <Bot size={14} />
            <span>{t("No teammate yet")}</span>
          </button>
        ) : (
          visibleTeammates.map((teammate) => (
            <button
              key={teammate.id}
              className={activeSidebarTarget === teammateSidebarTarget(teammate.id) ? "sidebar-row selected" : "sidebar-row"}
              type="button"
              onClick={() => onSelectTeammate(teammate.id)}
            >
              <AvatarInitial label={teammateInitial(teammate.displayName)} tone="gray" />
              <span>{teammate.displayName}</span>
              {teammate.status === "active" ? <span className="status-dot green" aria-hidden="true" /> : null}
            </button>
          ))
        )}
      </SidebarSection>

      <div className={channelDrawer ? "sidebar-bottom" : "sidebar-config"}>
        {pendingApprovalCount > 0 ? (
          <button className="sidebar-inbox-alert" type="button" onClick={() => onOpenView("approvals")}>
            {channelDrawer ? <span className="status-dot red" aria-hidden="true" /> : <ShieldCheck size={15} />}
            <span>{t("{count} pending approvals", { count: pendingApprovalCount })}</span>
          </button>
        ) : null}

        <button className={activeSidebarTarget === "settings" ? "config-button active" : "config-button"} type="button" onClick={() => onOpenView("settings")} aria-label={t("Settings")} title={t("Settings")}>
          <Settings size={15} />
          <span className="config-button-label">{t("Settings")}</span>
        </button>
      </div>
      </aside>
    </>
  );
}

function teammateInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "A";
}

function SidebarSection({
  title,
  actionLabel,
  onAction,
  children,
}: {
  readonly title: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="sidebar-section">
      <div className="sidebar-section-title">
        <span>{title}</span>
        {actionLabel ? (
          onAction ? (
            <button className="sidebar-section-action" type="button" onClick={onAction} aria-label={actionLabel} title={actionLabel}>
              <Plus size={12} />
            </button>
          ) : (
            <small>{actionLabel}</small>
          )
        ) : null}
      </div>
      <div className="sidebar-section-list">{children}</div>
    </section>
  );
}

function NavItem({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}): JSX.Element {
  return (
    <button className={active ? "nav-item active" : "nav-item"} type="button" disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
