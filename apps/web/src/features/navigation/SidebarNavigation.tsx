import type { ReactNode } from "react";
import {
  Bot,
  Database,
  Hash,
  History,
  Inbox,
  Kanban,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Plus,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Workflow,
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

export interface SidebarNotification {
  readonly count?: number;
  readonly unread?: boolean;
}

export function SidebarNavigation({
  activeSidebarTarget,
  channels,
  teammates,
  approvals,
  channelNotifications = {},
  teammateNotifications = {},
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
  readonly channelNotifications?: Readonly<Record<string, SidebarNotification>>;
  readonly teammateNotifications?: Readonly<Record<string, SidebarNotification>>;
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
        <NavItem icon={<Workflow />} label={t("Threads")} active={activeSidebarTarget === "threads"} onClick={() => onOpenView("threads")} />
        <NavItem icon={<Timer />} label={t("Automations")} active={activeSidebarTarget === "automations"} onClick={() => onOpenView("automations")} />
        <NavItem icon={<Inbox />} label={t("Review Queue")} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} />
        <NavItem icon={<Kanban />} label={t("Work Board")} active={activeSidebarTarget === "work_board"} onClick={() => onOpenView("work_board")} />
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
              <span className="sidebar-hash" aria-hidden="true">#</span>
              <span>{channel.name}</span>
              {renderSidebarNotification(channelNotifications[channel.id])}
            </button>
          ))
        )}
      </SidebarSection>

      <SidebarSection title={t("AI Teammates")}>
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
              {renderSidebarNotification(teammateNotifications[teammate.id])}
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

function renderSidebarNotification(notification: SidebarNotification | undefined): JSX.Element | null {
  if (!notification) {
    return null;
  }

  const count = notification.count ?? 0;
  if (count > 0) {
    return <span className="channel-mention" aria-hidden="true">{count > 99 ? "99+" : count}</span>;
  }

  return notification.unread ? <span className="channel-unread" aria-hidden="true" /> : null;
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
        {actionLabel && onAction ? (
          <button className="sidebar-section-action" type="button" onClick={onAction} aria-label={actionLabel} title={actionLabel}>
            <Plus size={12} />
          </button>
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
