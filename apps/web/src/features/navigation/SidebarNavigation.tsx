import { useState, type FormEvent, type ReactNode } from "react";
import {
  Archive,
  Bot,
  Database,
  GitBranch,
  Hash,
  Inbox,
  Kanban,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Plus,
  Settings,
  ShieldCheck,
  Timer,
  UserRound,
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
import type { AiTeammate, ApprovalRequest, Channel, ChannelBranch } from "../../types.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";

export interface SidebarNotification {
  readonly count?: number;
  readonly unread?: boolean;
}

export function SidebarNavigation({
  activeSidebarTarget,
  channels,
  channelBranches = [],
  selectedChannelBranchId = "",
  teammates,
  approvals,
  cwd,
  channelNotifications = {},
  teammateNotifications = {},
  onOpenView,
  onCreateChannel,
  onCreateTeammate,
  onCreateChannelBranch,
  onArchiveChannel,
  onArchiveChannelBranch,
  onSelectChannel,
  onSelectChannelBranch,
  onSelectTeammate,
  channelDrawer = false,
  channelDrawerOpen = true,
  onChannelDrawerOpenChange,
}: {
  readonly activeSidebarTarget: SidebarTarget;
  readonly channels: readonly Channel[];
  readonly channelBranches?: readonly ChannelBranch[];
  readonly selectedChannelBranchId?: string;
  readonly teammates: readonly AiTeammate[];
  readonly approvals: readonly ApprovalRequest[];
  readonly cwd: string;
  readonly channelNotifications?: Readonly<Record<string, SidebarNotification>>;
  readonly teammateNotifications?: Readonly<Record<string, SidebarNotification>>;
  readonly onOpenView: (view: ViewId) => void;
  readonly onCreateChannel: () => void;
  readonly onCreateTeammate?: () => void;
  readonly onCreateChannelBranch?: (channelId: string, name: string) => void | Promise<void>;
  readonly onArchiveChannel?: (channelId: string) => void | Promise<void>;
  readonly onArchiveChannelBranch?: (channelId: string, branchId: string) => void | Promise<void>;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onSelectChannelBranch?: (channelId: string, branchId: string) => void;
  readonly onSelectTeammate: (teammateId: string) => void;
  readonly channelDrawer?: boolean;
  readonly channelDrawerOpen?: boolean;
  readonly onChannelDrawerOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [branchDraftChannelId, setBranchDraftChannelId] = useState("");
  const [branchDraftName, setBranchDraftName] = useState("");
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const visibleTeammates = teammates.filter((teammate) => !teammate.hidden && teammate.status !== "disabled");
  const branchesByChannel = new Map<string, readonly ChannelBranch[]>();
  for (const channel of channels) {
    branchesByChannel.set(channel.id, channelBranches.filter((branch) => branch.channelId === channel.id && branch.status !== "archived"));
  }

  function openBranchDraft(channelId: string): void {
    setBranchDraftChannelId(channelId);
    setBranchDraftName("");
  }

  async function submitBranchDraft(event: FormEvent<HTMLFormElement>, channelId: string): Promise<void> {
    event.preventDefault();
    const name = branchDraftName.trim();
    if (!name || !onCreateChannelBranch) {
      return;
    }
    await onCreateChannelBranch(channelId, name);
    setBranchDraftChannelId("");
    setBranchDraftName("");
  }

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
        <NavItem icon={<Kanban />} label={t("Work Board")} active={activeSidebarTarget === "work_board"} onClick={() => onOpenView("work_board")} />
        <NavItem icon={<Timer />} label={t("Automations")} active={activeSidebarTarget === "automations"} onClick={() => onOpenView("automations")} />
        <NavItem icon={<Inbox />} label={t("Review Queue")} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} />
        <NavItem icon={<Database />} label={t("Generation")} active={activeSidebarTarget === "media"} onClick={() => onOpenView("media")} />
        <NavItem icon={<Users />} label={t("AI Teammates")} active={activeSidebarTarget === "teammates"} onClick={() => onOpenView("teammates")} />
      </nav>

      <SidebarSection title={t("Channels")} actionLabel={t("New channel")} onAction={onCreateChannel}>
        {channels.length === 0 ? (
          <button className="sidebar-row muted-row" type="button" onClick={onCreateChannel}>
            <Hash size={14} />
            <span>{t("No channel yet")}</span>
          </button>
        ) : (
	          channels.map((channel) => {
	            const channelActive = activeSidebarTarget === channelSidebarTarget(channel.id);
	            const draftOpen = branchDraftChannelId === channel.id;
	            const branches = branchesByChannel.get(channel.id) ?? [];
	            return (
	              <div key={channel.id} className="sidebar-channel-group">
	                <div className={channelActive ? "sidebar-row-shell selected" : "sidebar-row-shell"}>
	                  <button
	                    className="sidebar-row-main"
	                    type="button"
                    onClick={() => onSelectChannel(channel.id)}
                  >
                    <span className="sidebar-hash" aria-hidden="true">#</span>
                    <span>{channel.name}</span>
                    {renderSidebarNotification(channelNotifications[channel.id])}
                  </button>
                  <span className="sidebar-row-tools" aria-label={t("Channel actions")}>
                    {onCreateChannelBranch ? (
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        aria-label={t("Create branch")}
                        title={t("Create branch")}
                        onClick={(event) => {
                          event.stopPropagation();
                          openBranchDraft(channel.id);
                        }}
                      >
                        <GitBranch size={13} />
                      </button>
                    ) : null}
                    {onArchiveChannel ? (
                      <button
                        className="sidebar-mini-action danger"
                        type="button"
                        aria-label={t("Archive channel")}
                        title={t("Archive channel")}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onArchiveChannel(channel.id);
                        }}
                      >
                        <Archive size={13} />
                      </button>
                    ) : null}
                  </span>
                </div>
                {draftOpen ? (
                  <form className="sidebar-branch-create-form" onSubmit={(event) => void submitBranchDraft(event, channel.id)}>
                    <input
                      autoFocus
                      value={branchDraftName}
                      onChange={(event) => setBranchDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setBranchDraftChannelId("");
                          setBranchDraftName("");
                        }
                      }}
                      aria-label={t("Branch name")}
                      placeholder={t("Branch name")}
                    />
                    <button type="submit" aria-label={t("Create branch")} title={t("Create branch")}>
                      <Plus size={13} />
                    </button>
                  </form>
                ) : null}
                {branches.length > 0 ? (
                  <div className="sidebar-branch-list" role="list" aria-label={t("Sidebar channel branches")}>
                    {branches.map((branch) => (
                      <div key={branch.id} className={selectedChannelBranchId === branch.id ? "sidebar-branch-row-shell selected" : "sidebar-branch-row-shell"}>
                        <button
                          className="sidebar-branch-row"
                          type="button"
                          onClick={() => {
                            setBranchDraftChannelId("");
                            onSelectChannelBranch?.(channel.id, branch.id);
                          }}
                        >
                          <span>{branch.name}</span>
                        </button>
                        {onArchiveChannelBranch ? (
                          <span className="sidebar-row-tools">
                            <button
                              className="sidebar-mini-action danger"
                              type="button"
                              aria-label={t("Archive branch")}
                              title={t("Archive branch")}
                              onClick={(event) => {
                                event.stopPropagation();
                                void onArchiveChannelBranch(channel.id, branch.id);
                              }}
                            >
                              <Archive size={13} />
                            </button>
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </SidebarSection>

      <SidebarSection title={t("AI Teammates")} actionLabel={t("New teammate")} onAction={onCreateTeammate}>
        {visibleTeammates.length === 0 ? (
          <button className="sidebar-row muted-row" type="button" onClick={onCreateTeammate ?? (() => onOpenView("teammates"))}>
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
              <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
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

        <button className={activeSidebarTarget === "profile" ? "config-button active" : "config-button"} type="button" onClick={() => onOpenView("profile")} aria-label={t("Profile")} title={t("Profile")}>
          <UserRound size={15} />
          <span className="config-button-label">{t("Profile")}</span>
        </button>

        <button className={activeSidebarTarget === "settings" ? "config-button active" : "config-button"} type="button" onClick={() => onOpenView("settings")} aria-label={t("Settings")} title={t("Settings")}>
          <Settings size={15} />
          <span className="config-button-label">{t("Settings")}</span>
        </button>
      </div>
      </aside>
    </>
  );
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
