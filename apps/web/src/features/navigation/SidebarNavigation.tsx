import {
  useEffect,
  useState,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  Bot,
  Database,
  GitBranch,
  Hash,
  Inbox,
  Network,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  ShieldCheck,
  Timer,
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

type SidebarTooltipState = {
  readonly label: string;
  readonly left: number;
  readonly top: number;
};

type SidebarTooltipBindings = {
  readonly "data-sidebar-tooltip": string;
  readonly onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
};

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
  onArchiveAllChannels,
  onArchiveAllTeammateChats,
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
  readonly onArchiveAllChannels?: () => void | Promise<void>;
  readonly onArchiveAllTeammateChats?: () => void | Promise<void>;
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
  const [openSectionMenu, setOpenSectionMenu] = useState<"channels" | "teammates" | "">("");
  const [sidebarTooltip, setSidebarTooltip] = useState<SidebarTooltipState | null>(null);
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const visibleTeammates = teammates.filter((teammate) => !teammate.hidden && teammate.status !== "disabled");
  const collapsedTooltipsEnabled = channelDrawer && !channelDrawerOpen;
  const branchesByChannel = new Map<string, readonly ChannelBranch[]>();
  for (const channel of channels) {
    branchesByChannel.set(channel.id, channelBranches.filter((branch) => branch.channelId === channel.id && branch.status !== "archived"));
  }

  useEffect(() => {
    if (!collapsedTooltipsEnabled) {
      setSidebarTooltip(null);
    }
  }, [collapsedTooltipsEnabled]);

  function showSidebarTooltip(label: string, element: HTMLElement): void {
    if (!collapsedTooltipsEnabled) {
      return;
    }
    const rect = element.getBoundingClientRect();
    setSidebarTooltip({
      label,
      left: Math.round(rect.right + 8),
      top: Math.round(rect.top + rect.height / 2),
    });
  }

  function hideSidebarTooltip(): void {
    setSidebarTooltip(null);
  }

  function tooltipProps(label: string): SidebarTooltipBindings {
    return {
      "data-sidebar-tooltip": label,
      onMouseEnter: (event) => showSidebarTooltip(label, event.currentTarget),
      onMouseLeave: hideSidebarTooltip,
      onFocus: (event) => showSidebarTooltip(label, event.currentTarget),
      onBlur: hideSidebarTooltip,
    };
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
    <aside className={channelDrawer ? "left-nav channel-left-drawer" : "left-nav"} aria-label="Ling Stack navigation">
      <div className="sidebar-fixed-top">
        <div className="sidebar-brand-row">
          <button
            className="sidebar-brand-button"
            type="button"
            onClick={() => onOpenView("workspace")}
            aria-label="Ling Stack"
            title="Ling Stack"
          >
            <span className="sidebar-brand-mark" aria-hidden="true">L</span>
            <span className="sidebar-brand-copy">
              <strong>Ling Stack</strong>
              <small>{t("AI teammate workspace")}</small>
            </span>
          </button>
          {channelDrawer ? (
            <button
              className="channel-sidebar-switch"
              type="button"
              aria-label={channelDrawerOpen ? t("Hide navigation") : t("Show navigation")}
              title={channelDrawerOpen ? t("Hide navigation") : t("Show navigation")}
              onClick={() => onChannelDrawerOpenChange?.(!channelDrawerOpen)}
            >
              {channelDrawerOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
          ) : null}
        </div>

        <nav className="primary-nav">
          <NavItem icon={<Inbox />} label={t("Review Queue")} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} tooltipProps={tooltipProps(t("Review Queue"))} />
          <NavItem icon={<Database />} label={t("Image Generation")} active={activeSidebarTarget === "media"} onClick={() => onOpenView("media")} tooltipProps={tooltipProps(t("Image Generation"))} />
          <NavItem icon={<Timer />} label={t("Automations")} active={activeSidebarTarget === "automations"} onClick={() => onOpenView("automations")} tooltipProps={tooltipProps(t("Automations"))} />
          <NavItem icon={<Network />} label={t("AI Councils")} active={activeSidebarTarget === "councils"} onClick={() => onOpenView("councils")} tooltipProps={tooltipProps(t("AI Councils"))} />
        </nav>
      </div>

      <div className="sidebar-scroll-region" aria-label={t("Recent")} onScroll={hideSidebarTooltip}>
      <SidebarSection
        title={t("Channels")}
        menuLabel={t("Channel actions")}
        menuOpen={openSectionMenu === "channels"}
        onMenuOpenChange={(open) => setOpenSectionMenu(open ? "channels" : "")}
        menuItems={[
          {
            id: "new-channel",
            label: t("New channel"),
            icon: <Plus size={14} />,
            onSelect: onCreateChannel,
          },
          {
            id: "archive-all-channels",
            label: t("Archive all channels"),
            icon: <Archive size={14} />,
            disabled: channels.length === 0 || !onArchiveAllChannels,
            disabledLabel: t("No channels to archive"),
            danger: true,
            onSelect: () => void onArchiveAllChannels?.(),
          },
        ]}
      >
        {channels.length === 0 ? (
          <button
            className="sidebar-row muted-row"
            type="button"
            onClick={onCreateChannel}
            aria-label={t("No channel yet")}
            title={t("No channel yet")}
            {...tooltipProps(t("No channel yet"))}
          >
            <Hash size={14} />
            <span>{t("No channel yet")}</span>
          </button>
        ) : (
	          channels.map((channel) => {
	            const channelActive = activeSidebarTarget === channelSidebarTarget(channel.id);
	            const draftOpen = branchDraftChannelId === channel.id;
	            const branches = branchesByChannel.get(channel.id) ?? [];
	            const channelAvatar = channelAvatarMeta(channel);
	            return (
	              <div key={channel.id} className="sidebar-channel-group">
	                <div className={channelActive ? "sidebar-row-shell selected" : "sidebar-row-shell"}>
	                  <button
	                    className="sidebar-row-main"
	                    type="button"
                    aria-label={channel.name}
                    title={channel.name}
                    onClick={() => onSelectChannel(channel.id)}
                    {...tooltipProps(channel.name)}
                  >
                    <span className={`sidebar-channel-avatar ${channelAvatar.tone}`} aria-hidden="true">{channelAvatar.label}</span>
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
                          aria-label={branch.name}
                          title={branch.name}
                          {...tooltipProps(branch.name)}
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

      <SidebarSection
        title={t("AI Teammates")}
        menuLabel={t("AI teammate actions")}
        menuOpen={openSectionMenu === "teammates"}
        onMenuOpenChange={(open) => setOpenSectionMenu(open ? "teammates" : "")}
        menuItems={[
          {
            id: "new-teammate",
            label: t("New teammate"),
            icon: <Plus size={14} />,
            disabled: !onCreateTeammate,
            onSelect: () => onCreateTeammate?.(),
          },
          {
            id: "archive-all-chats",
            label: t("Archive all chats"),
            icon: <Archive size={14} />,
            disabled: visibleTeammates.length === 0 || !onArchiveAllTeammateChats,
            disabledLabel: t("No chats to archive"),
            danger: true,
            onSelect: () => void onArchiveAllTeammateChats?.(),
          },
        ]}
      >
        {visibleTeammates.length === 0 ? (
          <button
            className="sidebar-row muted-row"
            type="button"
            onClick={onCreateTeammate ?? (() => onOpenView("teammates"))}
            aria-label={t("No teammate yet")}
            title={t("No teammate yet")}
            {...tooltipProps(t("No teammate yet"))}
          >
            <Bot size={14} />
            <span>{t("No teammate yet")}</span>
          </button>
        ) : (
          visibleTeammates.map((teammate) => (
            <button
              key={teammate.id}
              className={activeSidebarTarget === teammateSidebarTarget(teammate.id) ? "sidebar-row selected" : "sidebar-row"}
              type="button"
              aria-label={teammate.displayName}
              title={teammate.displayName}
              {...tooltipProps(teammate.displayName)}
              onClick={() => onSelectTeammate(teammate.id)}
            >
              <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
              <span>{teammate.displayName}</span>
              {renderSidebarNotification(teammateNotifications[teammate.id])}
            </button>
          ))
        )}
      </SidebarSection>
      </div>

      <div className={channelDrawer ? "sidebar-bottom" : "sidebar-config"}>
        {pendingApprovalCount > 0 ? (
          <button
            className="sidebar-inbox-alert"
            type="button"
            onClick={() => onOpenView("approvals")}
            aria-label={t("{count} pending approvals", { count: pendingApprovalCount })}
            title={t("{count} pending approvals", { count: pendingApprovalCount })}
            {...tooltipProps(t("{count} pending approvals", { count: pendingApprovalCount }))}
          >
            {channelDrawer ? <span className="status-dot red" aria-hidden="true" /> : <ShieldCheck size={15} />}
            <span>{t("{count} pending approvals", { count: pendingApprovalCount })}</span>
          </button>
        ) : null}

        <button
          className={activeSidebarTarget === "settings" ? "config-button active" : "config-button"}
          type="button"
          onClick={() => onOpenView("settings")}
          aria-label={t("Settings")}
          title={t("Settings")}
          {...tooltipProps(t("Settings"))}
        >
          <Settings size={15} />
          <span className="config-button-label">{t("Settings")}</span>
        </button>
      </div>

      {sidebarTooltip ? (
        <span className="sidebar-hover-tooltip" role="tooltip" style={{ left: sidebarTooltip.left, top: sidebarTooltip.top }}>
          {sidebarTooltip.label}
        </span>
      ) : null}
    </aside>
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
  menuLabel,
  menuOpen,
  onMenuOpenChange,
  menuItems,
  children,
}: {
  readonly title: string;
  readonly menuLabel: string;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly menuItems: readonly SidebarSectionMenuItem[];
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="sidebar-section">
      <div className="sidebar-section-title">
        <span>{title}</span>
        <span
          className={menuOpen ? "sidebar-section-menu open" : "sidebar-section-menu"}
          onMouseEnter={() => onMenuOpenChange(true)}
          onMouseLeave={() => onMenuOpenChange(false)}
          onFocus={() => onMenuOpenChange(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              onMenuOpenChange(false);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onMenuOpenChange(false);
            }
          }}
        >
          <button
            className="sidebar-section-action"
            type="button"
            aria-label={menuLabel}
            title={menuLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => onMenuOpenChange(!menuOpen)}
            onMouseDown={(event) => event.preventDefault()}
          >
            <MoreHorizontal size={14} />
          </button>
          <span className="sidebar-section-menu-popover" role="menu" hidden={!menuOpen}>
            {menuItems.map((item) => (
              <button
                key={item.id}
                className={item.danger ? "danger" : undefined}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.disabled ? item.disabledLabel ?? item.label : item.label}
                onClick={() => {
                  if (item.disabled) {
                    return;
                  }
                  onMenuOpenChange(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </span>
        </span>
      </div>
      <div className="sidebar-section-list">{children}</div>
    </section>
  );
}

interface SidebarSectionMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly disabledLabel?: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

function NavItem({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
  tooltipProps,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly tooltipProps?: SidebarTooltipBindings;
}): JSX.Element {
  return (
    <button className={active ? "nav-item active" : "nav-item"} type="button" disabled={disabled} onClick={onClick} aria-label={label} title={label} {...tooltipProps}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

const channelAvatarTones = ["tone-slate", "tone-blue", "tone-teal", "tone-amber", "tone-rose", "tone-violet"] as const;

function channelAvatarMeta(channel: Channel): { readonly label: string; readonly tone: (typeof channelAvatarTones)[number] } {
  const seed = channel.id || channel.name;
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return {
    label: channelInitialsFromName(channel.name),
    tone: channelAvatarTones[hash % channelAvatarTones.length] ?? "tone-slate",
  };
}

function channelInitialsFromName(name: string): string {
  const value = name.trim();
  if (!value) {
    return "#";
  }
  const compact = Array.from(value.replace(/\s+/g, ""));
  const firstChar = compact[0] ?? "#";
  if (isCjkCharacter(firstChar)) {
    return firstChar;
  }
  const tokens = value.match(/[A-Za-z0-9]+/g) ?? [];
  if (tokens.length >= 2) {
    return `${tokens[0]?.[0] ?? ""}${tokens[1]?.[0] ?? ""}`.toUpperCase();
  }
  const token = tokens[0] ?? compact.join("");
  return Array.from(token).slice(0, 2).join("").toUpperCase() || firstChar.toUpperCase();
}

function isCjkCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df)
  );
}
