import {
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  Bot,
  ChevronDown,
  Database,
  GitBranch,
  Hash,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Plus,
  Settings,
  Timer,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { ActionMenuItem } from "../../shared/components/index.js";
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

export interface SidebarRecentConversation {
  readonly id: string;
  readonly label: string;
  readonly meta: string;
  readonly updatedAt: string;
  readonly channelId?: string;
  readonly taskId?: string;
}

type SidebarTooltipState = {
  readonly label: string;
  readonly left: number;
  readonly top: number;
};

type SidebarSectionId = "channels" | "teammates" | "recent";

type SidebarTooltipBindings = {
  readonly "data-sidebar-tooltip": string;
  readonly onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
  readonly onBlur: (event: ReactFocusEvent<HTMLElement>) => void;
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
  recentConversations = [],
  recentConversationActionError = "",
  selectedRecentConversationId = "",
  onOpenView,
  onOpenConversationHome,
  onCreateChannel,
  onCreateTeammate,
  teammateCreateModelReady = true,
  onOpenTeammateModelWorkbench,
  onCreateChannelBranch,
  onArchiveChannel,
  onArchiveChannelBranch,
  onArchiveTeammate,
  onArchiveRecentConversation,
  onArchiveAllRecentConversations,
  onSelectChannel,
  onSelectChannelBranch,
  onSelectTeammate,
  onSelectRecentConversation,
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
  readonly recentConversations?: readonly SidebarRecentConversation[];
  readonly recentConversationActionError?: string;
  readonly selectedRecentConversationId?: string;
  readonly onOpenView: (view: ViewId) => void;
  readonly onOpenConversationHome: () => void;
  readonly onCreateChannel: () => void;
  readonly onCreateTeammate?: () => void;
  readonly teammateCreateModelReady?: boolean;
  readonly onOpenTeammateModelWorkbench?: () => void;
  readonly onCreateChannelBranch?: (channelId: string, name: string) => void | Promise<void>;
  readonly onArchiveChannel?: (channelId: string) => void | Promise<void>;
  readonly onArchiveChannelBranch?: (channelId: string, branchId: string) => void | Promise<void>;
  readonly onArchiveTeammate?: (teammateId: string) => void | Promise<void>;
  readonly onArchiveRecentConversation?: (conversation: SidebarRecentConversation) => void | Promise<void>;
  readonly onArchiveAllRecentConversations?: () => void | Promise<void>;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onSelectChannelBranch?: (channelId: string, branchId: string) => void;
  readonly onSelectTeammate: (teammateId: string) => void;
  readonly onSelectRecentConversation: (conversation: SidebarRecentConversation) => void;
  readonly channelDrawer?: boolean;
  readonly channelDrawerOpen?: boolean;
  readonly onChannelDrawerOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [branchDraftChannelId, setBranchDraftChannelId] = useState("");
  const [branchDraftName, setBranchDraftName] = useState("");
  const [openSectionMenu, setOpenSectionMenu] = useState<SidebarSectionId | "">("");
  const [collapsedSections, setCollapsedSections] = useState<Record<SidebarSectionId, boolean>>({
    channels: false,
    teammates: false,
    recent: false,
  });
  const [sidebarTooltip, setSidebarTooltip] = useState<SidebarTooltipState | null>(null);
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const inboxTooltip = pendingApprovalCount > 0
    ? `${t("Inbox")} · ${t("{count} pending approvals", { count: pendingApprovalCount })}`
    : t("Inbox");
  const visibleTeammates = teammates.filter((teammate) => !teammate.hidden && teammate.status !== "disabled");
  const collapsedTooltipsEnabled = channelDrawer && !channelDrawerOpen;
  const branchesByChannel = new Map<string, readonly ChannelBranch[]>();
  for (const channel of channels) {
    branchesByChannel.set(channel.id, channelBranches.filter((branch) => branch.channelId === channel.id && branch.status !== "archived"));
  }

  useEffect(() => {
    if (!collapsedTooltipsEnabled) {
      setSidebarTooltip(null);
      return;
    }
    setCollapsedSections({
      channels: false,
      teammates: false,
      recent: false,
    });
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

  function hideSidebarTooltip(event?: ReactFocusEvent<HTMLElement>): void {
    if (event?.relatedTarget instanceof HTMLElement && event.relatedTarget.closest("[data-sidebar-tooltip]")) {
      return;
    }
    setSidebarTooltip(null);
  }

  function tooltipProps(label: string): SidebarTooltipBindings {
    return {
      "data-sidebar-tooltip": label,
      onMouseEnter: (event) => showSidebarTooltip(label, event.currentTarget),
      onMouseLeave: hideSidebarTooltip,
      onFocus: (event) => showSidebarTooltip(label, event.currentTarget),
      onBlur: (event) => hideSidebarTooltip(event),
    };
  }

  function openBranchDraft(channelId: string): void {
    setBranchDraftChannelId(channelId);
    setBranchDraftName("");
  }

  function toggleSection(sectionId: SidebarSectionId): void {
    setCollapsedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
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
            onClick={onOpenConversationHome}
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

        <button
          className="sidebar-command-button"
          type="button"
          onClick={onOpenConversationHome}
          aria-label={t("New conversation")}
          title={t("New conversation")}
          {...tooltipProps(t("New conversation"))}
        >
          <Plus size={15} />
          <span>{t("New conversation")}</span>
        </button>

        <nav className="primary-nav">
          <NavItem icon={<Inbox />} label={t("Inbox")} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} tooltipProps={tooltipProps(inboxTooltip)} />
          <NavItem icon={<Database />} label={t("Image Generation")} active={activeSidebarTarget === "media"} onClick={() => onOpenView("media")} tooltipProps={tooltipProps(t("Image Generation"))} />
          <NavItem icon={<Timer />} label={t("Automations")} active={activeSidebarTarget === "automations"} onClick={() => onOpenView("automations")} tooltipProps={tooltipProps(t("Automations"))} />
        </nav>
      </div>

      <div className="sidebar-scroll-region" aria-label={t("Recent")} onScroll={() => hideSidebarTooltip()}>
      <SidebarSection
        sectionId="channels"
        title={t("Channels")}
        collapsed={collapsedSections.channels}
        railCollapsed={collapsedTooltipsEnabled}
        railCollapsedPreview={renderChannelRailPreview(channels)}
        onToggleCollapsed={toggleSection}
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
        sectionId="teammates"
        title={t("AI Teammates")}
        collapsed={collapsedSections.teammates}
        railCollapsed={collapsedTooltipsEnabled}
        railCollapsedPreview={renderTeammateRailPreview(visibleTeammates, cwd)}
        onToggleCollapsed={toggleSection}
        menuLabel={t("AI teammate actions")}
        menuOpen={openSectionMenu === "teammates"}
        onMenuOpenChange={(open) => setOpenSectionMenu(open ? "teammates" : "")}
        menuItems={teammateCreateModelReady ? [
          {
            id: "new-ai-teammate",
            label: t("New AI teammate"),
            description: t("Choose a role and model. You can adjust details before creating."),
            icon: <Plus size={14} />,
            disabled: !onCreateTeammate,
            onSelect: () => onCreateTeammate?.(),
          },
        ] : [
          {
            id: "configure-teammate-model",
            label: t("Configure model"),
            description: t("Configure a ready chat model before creating."),
            icon: <PlugZap size={14} />,
            disabled: !onOpenTeammateModelWorkbench,
            onSelect: () => onOpenTeammateModelWorkbench?.(),
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
            <div
              key={teammate.id}
              className={activeSidebarTarget === teammateSidebarTarget(teammate.id) ? "sidebar-row-shell selected" : "sidebar-row-shell"}
            >
              <button
                className="sidebar-row-main"
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
              {onArchiveTeammate ? (
                <span className="sidebar-row-tools">
                  <button
                    className="sidebar-mini-action danger"
                    type="button"
                    aria-label={t("Archive teammate")}
                    title={t("Archive teammate")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onArchiveTeammate(teammate.id);
                    }}
                  >
                    <Archive size={13} />
                  </button>
                </span>
              ) : null}
            </div>
          ))
        )}
      </SidebarSection>

      <SidebarSection
        sectionId="recent"
        title={t("Recent conversations")}
        collapsed={collapsedSections.recent}
        railCollapsed={collapsedTooltipsEnabled}
        railCollapsedPreview={renderRecentRailPreview(recentConversations)}
        onToggleCollapsed={toggleSection}
        menuLabel={t("Recent conversation actions")}
        menuOpen={openSectionMenu === "recent"}
        onMenuOpenChange={(open) => setOpenSectionMenu(open ? "recent" : "")}
        menuItems={[
          {
            id: "archive-all-conversations",
            label: t("Archive all conversations"),
            icon: <Archive size={14} />,
            danger: true,
            disabled: !onArchiveAllRecentConversations || recentConversations.length === 0,
            disabledLabel: t("No conversations to archive"),
            onSelect: () => onArchiveAllRecentConversations?.(),
          },
        ]}
      >
        {recentConversations.length === 0 ? (
          <button
            className="sidebar-row muted-row"
            type="button"
            onClick={onOpenConversationHome}
            aria-label={t("No recent conversations")}
            title={t("No recent conversations")}
            {...tooltipProps(t("No recent conversations"))}
          >
            <MessageSquare size={14} />
            <span>{t("No recent conversations")}</span>
          </button>
        ) : (
          recentConversations.map((conversation, index) => (
            <div
              key={conversation.id}
              className={conversation.id === selectedRecentConversationId ? "sidebar-row-shell sidebar-recent-row-shell selected" : "sidebar-row-shell sidebar-recent-row-shell"}
            >
              <button
                className="sidebar-row-main sidebar-recent-row"
                type="button"
                aria-label={t("Open recent conversation {index}", { index: index + 1 })}
                title={conversation.label}
                {...tooltipProps(conversation.label)}
                onClick={() => onSelectRecentConversation(conversation)}
              >
                <MessageSquare size={14} />
                <span className="sidebar-recent-copy">
                  <strong>{conversation.label}</strong>
                  <small>{conversation.meta}</small>
                </span>
              </button>
              {onArchiveRecentConversation ? (
                <span className="sidebar-row-tools">
                  <button
                    className="sidebar-mini-action danger"
                    type="button"
                    aria-label={t("Archive conversation")}
                    title={t("Archive conversation")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onArchiveRecentConversation(conversation);
                    }}
                  >
                    <Archive size={13} />
                  </button>
                </span>
              ) : null}
            </div>
          ))
        )}
        {recentConversationActionError ? (
          <div className="sidebar-section-inline-error" role="alert">
            {recentConversationActionError}
          </div>
        ) : null}
      </SidebarSection>
      </div>

      <div className={channelDrawer ? "sidebar-bottom" : "sidebar-config"}>
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
  sectionId,
  title,
  collapsed,
  railCollapsed = false,
  railCollapsedPreview,
  onToggleCollapsed,
  menuLabel,
  menuOpen,
  onMenuOpenChange,
  menuItems,
  children,
}: {
  readonly sectionId: SidebarSectionId;
  readonly title: string;
  readonly collapsed: boolean;
  readonly railCollapsed?: boolean;
  readonly railCollapsedPreview?: ReactNode;
  readonly onToggleCollapsed: (sectionId: SidebarSectionId) => void;
  readonly menuLabel?: string;
  readonly menuOpen?: boolean;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly menuItems?: readonly SidebarSectionMenuItem[];
  readonly children: ReactNode;
}): JSX.Element {
  const menuRef = useRef<HTMLSpanElement | null>(null);
  const sectionClassName = [
    "sidebar-section",
    `sidebar-section-${sectionId}`,
    railCollapsed ? "rail-collapsed" : "",
    collapsed ? "collapsed" : "expanded",
  ].filter(Boolean).join(" ");
  const hasRichMenuItems = menuItems?.some((item) => item.description) ?? false;

  useEffect(() => {
    const closeMenu = onMenuOpenChange;
    if (!menuOpen || !closeMenu || typeof document === "undefined") {
      return;
    }
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) {
        return;
      }
      closeMenu?.(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        closeMenu?.(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen, onMenuOpenChange]);

  return (
    <section className={sectionClassName}>
      <div className="sidebar-section-title">
        <button
          className="sidebar-section-toggle"
          type="button"
          aria-label={title}
          aria-expanded={!collapsed}
          title={title}
          onClick={() => onToggleCollapsed(sectionId)}
        >
          <span className="sidebar-section-heading">{title}</span>
          <ChevronDown className={collapsed ? "sidebar-section-chevron collapsed" : "sidebar-section-chevron"} size={12} aria-hidden="true" />
        </button>
        {menuItems && menuItems.length > 0 && menuLabel && onMenuOpenChange ? (
          <span
            ref={menuRef}
            className={menuOpen ? "sidebar-section-menu open" : "sidebar-section-menu"}
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
            >
              <MoreHorizontal size={14} />
            </button>
            <span className={hasRichMenuItems ? "sidebar-section-menu-popover rich" : "sidebar-section-menu-popover"} role="menu" hidden={!menuOpen}>
              {menuItems.map((item) => (
                <ActionMenuItem
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  description={item.description}
                  danger={item.danger}
                  disabled={item.disabled}
                  disabledLabel={item.disabledLabel}
                  onSelect={() => {
                    onMenuOpenChange(false);
                    item.onSelect();
                  }}
                />
              ))}
            </span>
          </span>
        ) : null}
      </div>
      {railCollapsed ? (
        <div className="sidebar-rail-section-body">
          {railCollapsedPreview ? <div className="sidebar-rail-preview" aria-hidden={!collapsed}>{railCollapsedPreview}</div> : null}
          <div className="sidebar-section-list" aria-hidden={collapsed}>{children}</div>
        </div>
      ) : collapsed ? null : <div className="sidebar-section-list">{children}</div>}
    </section>
  );
}

interface SidebarSectionMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly disabledLabel?: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

function renderChannelRailPreview(channels: readonly Channel[]): JSX.Element {
  const visibleChannels = channels.slice(0, 4);
  const previewChannels = visibleChannels.length > 0 ? visibleChannels : [];
  const extraCount = channels.length - visibleChannels.length;
  return (
    <span className="sidebar-rail-stack" aria-hidden="true">
      {previewChannels.length > 0 ? previewChannels.map((channel) => {
        const channelAvatar = channelAvatarMeta(channel);
        return (
          <span key={channel.id} className={`sidebar-channel-avatar ${channelAvatar.tone}`}>
            {channelAvatar.label}
          </span>
        );
      }) : <span className="sidebar-rail-stack-icon"><Hash size={14} /></span>}
      {extraCount > 0 ? <span className="sidebar-rail-stack-more">+{extraCount}</span> : null}
    </span>
  );
}

function renderTeammateRailPreview(teammates: readonly AiTeammate[], cwd: string): JSX.Element {
  const visibleTeammates = teammates.slice(0, 5);
  const extraCount = teammates.length - visibleTeammates.length;
  return (
    <span className="sidebar-rail-stack" aria-hidden="true">
      {visibleTeammates.length > 0 ? visibleTeammates.map((teammate) => (
        <span key={teammate.id} className="sidebar-rail-stack-avatar">
          <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
        </span>
      )) : <span className="sidebar-rail-stack-icon"><Bot size={14} /></span>}
      {extraCount > 0 ? <span className="sidebar-rail-stack-more">+{extraCount}</span> : null}
    </span>
  );
}

function renderRecentRailPreview(conversations: readonly SidebarRecentConversation[]): JSX.Element {
  const visibleConversations = conversations.slice(0, 3);
  const extraCount = conversations.length - visibleConversations.length;
  return (
    <span className="sidebar-rail-stack" aria-hidden="true">
      {(visibleConversations.length > 0 ? visibleConversations : [{ id: "empty" }]).map((conversation) => (
        <span key={conversation.id} className="sidebar-rail-stack-icon">
          <MessageSquare size={15} />
        </span>
      ))}
      {extraCount > 0 ? <span className="sidebar-rail-stack-more">+{extraCount}</span> : null}
    </span>
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
