import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Archive,
  Bot,
  GitBranch,
  Hash,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Plus,
  Settings,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Icon, IconButton, InlineFeedback, Input, StatusIndicator } from "../../shared/ui/index.js";
import {
  channelSidebarTarget,
  teammateSidebarTarget,
  type SidebarTarget,
  type ViewId,
} from "../../app/view-types.js";
import type { AiTeammate, Channel, ChannelBranch } from "../../types.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { SidebarPrimaryNavigation } from "./SidebarPrimaryNavigation.js";
import { channelAvatarMeta } from "./sidebar-channel-avatar.js";
import { SidebarObjectRow } from "./SidebarObjectRow.js";
import { SidebarArchiveAllConversationsDialog } from "./SidebarArchiveAllConversationsDialog.js";
import { SidebarSection, SidebarSectionSkeleton, type SidebarSectionId } from "./SidebarSection.js";
import { SidebarTooltip } from "./SidebarTooltip.js";

export interface SidebarNotification {
  readonly count?: number;
  readonly primaryStatus?: SidebarPrimaryStatus;
  readonly unread?: boolean;
}

export type SidebarPrimaryStatus = "failed" | "paused" | "running" | "waiting";

export interface SidebarRecentConversation {
  readonly id: string;
  readonly label: string;
  readonly meta: string;
  readonly updatedAt: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly primaryStatus?: SidebarPrimaryStatus;
}

export function SidebarNavigation({
  activeSidebarTarget,
  channels,
  channelBranches = [],
  selectedChannelBranchId = "",
  teammates,
  cwd,
  channelsLoading = false,
  teammatesLoading = false,
  stale = false,
  channelNotifications = {},
  teammateNotifications = {},
  recentConversations = [],
  recentConversationsLoading = false,
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
  readonly cwd: string;
  readonly channelsLoading?: boolean;
  readonly teammatesLoading?: boolean;
  readonly stale?: boolean;
  readonly channelNotifications?: Readonly<Record<string, SidebarNotification>>;
  readonly teammateNotifications?: Readonly<Record<string, SidebarNotification>>;
  readonly recentConversations?: readonly SidebarRecentConversation[];
  readonly recentConversationsLoading?: boolean;
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
  const sidebarStatusLabels = {
    failed: t("Failed"),
    paused: t("Paused"),
    pendingApprovals: (count: number) => t("{count} pending approvals", { count }),
    running: t("Running"),
    unread: t("Unread"),
    waiting: t("Waiting for approval"),
  };
  const [branchDraftChannelId, setBranchDraftChannelId] = useState("");
  const [branchDraftName, setBranchDraftName] = useState("");
  const [archiveAllDialogOpen, setArchiveAllDialogOpen] = useState(false);
  const recentActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [openSectionMenu, setOpenSectionMenu] = useState<SidebarSectionId | "">("");
  const [collapsedSections, setCollapsedSections] = useState<Record<SidebarSectionId, boolean>>({
    channels: false,
    teammates: false,
    recent: false,
  });
  const visibleTeammates = teammates.filter((teammate) => !teammate.hidden && teammate.status !== "disabled");
  const collapsedTooltipsEnabled = channelDrawer && !channelDrawerOpen;
  const branchesByChannel = new Map<string, readonly ChannelBranch[]>();
  for (const channel of channels) {
    branchesByChannel.set(channel.id, channelBranches.filter((branch) => branch.channelId === channel.id && branch.status !== "archived"));
  }

  useEffect(() => {
    if (!collapsedTooltipsEnabled) {
      return;
    }
    setCollapsedSections({
      channels: false,
      teammates: false,
      recent: false,
    });
  }, [collapsedTooltipsEnabled]);

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

  const SidebarToggleIcon = channelDrawerOpen ? PanelLeftClose : PanelLeftOpen;

  return (
    <aside className={channelDrawer ? "left-nav channel-left-drawer" : "left-nav"} aria-label="Ling Stack navigation">
      <div className="sidebar-fixed-top">
        <div className={channelDrawer ? "sidebar-brand-row has-sidebar-switch" : "sidebar-brand-row"}>
          <SidebarTooltip label={t("New conversation")}>
            <button
              className="sidebar-command-button sidebar-command-button-top"
              type="button"
              onClick={onOpenConversationHome}
              aria-label={t("New conversation")}
            >
              <Icon icon={Plus} />
              <span>{t("New conversation")}</span>
            </button>
          </SidebarTooltip>
          {channelDrawer ? (
            <IconButton
              className="channel-sidebar-switch"
              label={channelDrawerOpen ? t("Hide navigation") : t("Show navigation")}
              icon={SidebarToggleIcon}
              onClick={() => onChannelDrawerOpenChange?.(!channelDrawerOpen)}
            />
          ) : null}
        </div>

        <SidebarPrimaryNavigation
          activeSidebarTarget={activeSidebarTarget}
          onOpenView={onOpenView}
        />
      </div>

      <div className="sidebar-scroll-region" aria-label={t("Recent")}>
      <SidebarSection
        sectionId="channels"
        title={t("Channels")}
        count={channels.length}
        loading={channelsLoading}
        loadingLabel={t("Loading channels...")}
        stale={stale}
        staleLabel={t("Stale")}
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
            icon: Plus,
            onSelect: onCreateChannel,
          },
        ]}
      >
        {channelsLoading && channels.length === 0 ? (
          <SidebarSectionSkeleton label={t("Loading channels...")} rows={3} />
        ) : channels.length === 0 ? (
          <SidebarTooltip label={t("No channel yet")}>
            <button
              className="sidebar-row muted-row"
              type="button"
              onClick={onCreateChannel}
              aria-label={t("No channel yet")}
            >
              <Hash size={14} />
              <span>{t("No channel yet")}</span>
            </button>
          </SidebarTooltip>
        ) : (
	          channels.map((channel) => {
	            const channelActive = activeSidebarTarget === channelSidebarTarget(channel.id);
	            const draftOpen = branchDraftChannelId === channel.id;
	            const branches = branchesByChannel.get(channel.id) ?? [];
	            const channelAvatar = channelAvatarMeta(channel);
	            return (
	              <div key={channel.id} className="sidebar-channel-group">
	                <SidebarObjectRow
	                  actionsLabel={t("Channel actions")}
	                  ariaLabel={channel.name}
	                  icon={<span className={`sidebar-channel-avatar ${channelAvatar.tone}`} aria-hidden="true">{channelAvatar.label}</span>}
	                  onSelect={() => onSelectChannel(channel.id)}
	                  selected={channelActive}
	                  status={renderSidebarNotification(channelNotifications[channel.id], sidebarStatusLabels)}
	                  statusId={sidebarNotificationId(channelNotifications[channel.id])}
	                  actions={(
                    <>
                    {onCreateChannelBranch ? (
                      <IconButton
                        className="sidebar-mini-action"
                        label={t("Create branch")}
                        icon={GitBranch}
                        onClick={(event) => {
                          event.stopPropagation();
                          openBranchDraft(channel.id);
                        }}
                      />
                    ) : null}
                    {onArchiveChannel ? (
                      <IconButton
                        className="sidebar-mini-action danger"
                        label={t("Archive channel")}
                        icon={Archive}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onArchiveChannel(channel.id);
                        }}
                      />
                    ) : null}
                    </>
                  )}
	                >
	                  {channel.name}
	                </SidebarObjectRow>
                {draftOpen ? (
                  <form className="sidebar-branch-create-form" onSubmit={(event) => void submitBranchDraft(event, channel.id)}>
                    <Input
                      autoFocus
                      containerClassName="sidebar-branch-name-control"
                      size="sm"
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
                    <IconButton type="submit" label={t("Create branch")} icon={Plus} />
                  </form>
                ) : null}
                {branches.length > 0 ? (
                  <div className="sidebar-branch-list" role="list" aria-label={t("Sidebar channel branches")}>
                    {branches.map((branch) => (
                      <div key={branch.id} className={selectedChannelBranchId === branch.id ? "sidebar-branch-row-shell selected" : "sidebar-branch-row-shell"}>
                        <SidebarTooltip label={branch.name}>
                          <button
                            className="sidebar-branch-row"
                            type="button"
                            aria-label={branch.name}
                            onClick={() => {
                              setBranchDraftChannelId("");
                              onSelectChannelBranch?.(channel.id, branch.id);
                            }}
                          >
                            <span>{branch.name}</span>
                          </button>
                        </SidebarTooltip>
                        {onArchiveChannelBranch ? (
                          <span className="sidebar-row-tools">
                            <IconButton
                              className="sidebar-mini-action danger"
                              label={t("Archive branch")}
                              icon={Archive}
                              onClick={(event) => {
                                event.stopPropagation();
                                void onArchiveChannelBranch(channel.id, branch.id);
                              }}
                            />
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
        count={visibleTeammates.length}
        loading={teammatesLoading}
        loadingLabel={t("Loading teammates...")}
        stale={stale}
        staleLabel={t("Stale")}
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
            icon: Plus,
            disabled: !onCreateTeammate,
            onSelect: () => onCreateTeammate?.(),
          },
        ] : [
          {
            id: "configure-teammate-model",
            label: t("Configure model"),
            icon: PlugZap,
            disabled: !onOpenTeammateModelWorkbench,
            onSelect: () => onOpenTeammateModelWorkbench?.(),
          },
        ]}
      >
        {teammatesLoading && visibleTeammates.length === 0 ? (
          <SidebarSectionSkeleton label={t("Loading teammates...")} rows={2} />
        ) : visibleTeammates.length === 0 ? (
          <SidebarTooltip label={t("No teammate yet")}>
            <button
              className="sidebar-row muted-row"
              type="button"
              onClick={onCreateTeammate ?? (() => onOpenView("teammates"))}
              aria-label={t("No teammate yet")}
            >
              <Bot size={14} />
              <span>{t("No teammate yet")}</span>
            </button>
          </SidebarTooltip>
        ) : (
          visibleTeammates.map((teammate) => (
            <SidebarObjectRow
              key={teammate.id}
              ariaLabel={teammate.displayName}
              icon={<TeammateAvatarView teammate={teammate} cwd={cwd} compact />}
              onSelect={() => onSelectTeammate(teammate.id)}
              selected={activeSidebarTarget === teammateSidebarTarget(teammate.id)}
              status={renderSidebarNotification(teammateNotifications[teammate.id], sidebarStatusLabels)}
              statusId={sidebarNotificationId(teammateNotifications[teammate.id])}
              actions={onArchiveTeammate ? (
                <IconButton
                  className="sidebar-mini-action danger"
                  label={t("Archive teammate")}
                  icon={Archive}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onArchiveTeammate(teammate.id);
                  }}
                />
              ) : undefined}
            >
              {teammate.displayName}
            </SidebarObjectRow>
          ))
        )}
      </SidebarSection>

      <SidebarSection
        sectionId="recent"
        title={t("Recent conversations")}
        count={recentConversations.length}
        loading={recentConversationsLoading}
        loadingLabel={t("Loading conversations...")}
        stale={stale}
        staleLabel={t("Stale")}
        collapsed={collapsedSections.recent}
        railCollapsed={collapsedTooltipsEnabled}
        railCollapsedPreview={renderRecentRailPreview(recentConversations)}
        onToggleCollapsed={toggleSection}
        menuLabel={t("Recent conversation actions")}
        menuOpen={openSectionMenu === "recent"}
        menuTriggerRef={recentActionsTriggerRef}
        onMenuOpenChange={(open) => setOpenSectionMenu(open ? "recent" : "")}
        menuItems={[
          {
            id: "archive-all-conversations",
            label: t("Archive all conversations"),
            icon: Archive,
            danger: true,
            disabled: !onArchiveAllRecentConversations || recentConversations.length === 0,
            disabledLabel: t("No conversations to archive"),
            onSelect: () => setArchiveAllDialogOpen(true),
          },
        ]}
      >
        {recentConversationsLoading && recentConversations.length === 0 ? (
          <SidebarSectionSkeleton label={t("Loading conversations...")} rows={2} />
        ) : recentConversations.length === 0 ? (
          <SidebarTooltip label={t("No recent conversations")}>
            <button
              className="sidebar-row muted-row"
              type="button"
              onClick={onOpenConversationHome}
              aria-label={t("No recent conversations")}
            >
              <MessageSquare size={14} />
              <span>{t("No recent conversations")}</span>
            </button>
          </SidebarTooltip>
        ) : (
          recentConversations.map((conversation, index) => (
            <SidebarObjectRow
              key={conversation.id}
              ariaLabel={t("Open recent conversation {index}", { index: index + 1 })}
              buttonClassName="sidebar-recent-row"
              icon={<MessageSquare size={14} />}
              onSelect={() => onSelectRecentConversation(conversation)}
              selected={conversation.id === selectedRecentConversationId}
              shellClassName="sidebar-recent-row-shell"
              tooltip={conversation.label}
              status={conversation.primaryStatus
                ? renderSidebarNotification({ primaryStatus: conversation.primaryStatus }, sidebarStatusLabels)
                : undefined}
              statusId={conversation.primaryStatus}
              actions={onArchiveRecentConversation ? (
                <IconButton
                  className="sidebar-mini-action danger"
                  label={t("Archive conversation")}
                  icon={Archive}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onArchiveRecentConversation(conversation);
                  }}
                />
              ) : undefined}
            >
              <span className="sidebar-recent-copy">
                <strong>{conversation.label}</strong>
                <small>{conversation.meta}</small>
              </span>
            </SidebarObjectRow>
          ))
        )}
        {recentConversationActionError ? (
          <InlineFeedback className="sidebar-section-inline-error" tone="danger">
            {recentConversationActionError}
          </InlineFeedback>
        ) : null}
      </SidebarSection>
      </div>

      <div className={channelDrawer ? "sidebar-bottom" : "sidebar-config"}>
        <SidebarTooltip label={t("Settings")}>
          <button
            className={activeSidebarTarget === "settings" ? "config-button active" : "config-button"}
            type="button"
            onClick={() => onOpenView("settings")}
            aria-label={t("Settings")}
          >
            <Icon icon={Settings} />
            <span className="config-button-label">{t("Settings")}</span>
          </button>
        </SidebarTooltip>
      </div>

      {onArchiveAllRecentConversations ? (
        <SidebarArchiveAllConversationsDialog
          open={archiveAllDialogOpen}
          returnFocusRef={recentActionsTriggerRef}
          onConfirm={onArchiveAllRecentConversations}
          onOpenChange={setArchiveAllDialogOpen}
        />
      ) : null}

    </aside>
  );
}

function renderSidebarNotification(
  notification: SidebarNotification | undefined,
  labels: {
    readonly failed: string;
    readonly paused: string;
    readonly pendingApprovals: (count: number) => string;
    readonly running: string;
    readonly unread: string;
    readonly waiting: string;
  },
): JSX.Element | null {
  if (!notification) {
    return null;
  }

  if (notification.primaryStatus) {
    const label = notification.primaryStatus === "waiting" && (notification.count ?? 0) > 0
      ? labels.pendingApprovals(notification.count ?? 0)
      : labels[notification.primaryStatus];
    const tone = notification.primaryStatus === "failed"
      ? "danger"
      : notification.primaryStatus === "paused"
        ? "neutral"
        : notification.primaryStatus === "waiting"
          ? "warning"
          : "info";
    return (
      <StatusIndicator
        aria-label={label}
        className="sidebar-object-status"
        compact
        data-sidebar-primary-status={notification.primaryStatus}
        label={label}
        role="status"
        tone={tone}
      />
    );
  }

  return notification.unread ? (
    <StatusIndicator className="channel-unread sidebar-object-status" compact label={labels.unread} tone="info" />
  ) : null;
}

function sidebarNotificationId(notification: SidebarNotification | undefined): string | undefined {
  return notification?.primaryStatus ?? (notification?.unread ? "unread" : undefined);
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
