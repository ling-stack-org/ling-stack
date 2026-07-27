import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Brain, FileText, Folder, Loader2, MessageSquare, Settings } from "lucide-react";
import type { SkillPack } from "@ling-stack/core/skill-types";
import {
  cancelTeammateDirectIntervention,
  cancelTeammateDirectReply,
  createTeammateDirectLinkPreview,
  createTeammateDirectIntervention,
  deleteAttachment,
  getSkillSourceHealth,
  getTeammateDirectRuntime,
  getTeammateDirectWorkspace,
  listSkills,
  listTeammateActivity,
  listTeammateDirectLinkPreviews,
  listTeammateDirectMessages,
  listTeammatePrivateAttachments,
  listMcpServers,
  listMcpTools,
  listExecutionActions,
  listTeammateMcpBindings,
  listTeammateSkills,
  listTerminalReports,
  promoteTeammateDirectIntervention,
  streamTeammateDirectMessage,
  uploadTeammatePrivateAttachment,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { providerPreflightReady } from "../../lib/providers.js";
import { readSseResponse } from "../../sse.js";
import {
  composerWorkspaceFileParts,
  createAttachmentPreviewUrl,
  createLocalComposerAssetId,
  parseComposerInputParts,
  removeComposerInputRawToken,
  revokeObjectUrl,
  revokePendingAttachmentPreview,
  revokePendingAttachmentPreviews,
  serializeComposerInputParts,
  type PendingAttachmentItem,
} from "../../shared/components/index.js";
import type {
  AuthorizationMode,
  ApprovalPolicy,
  AiTeammate,
  Channel,
  ExecutionAction,
  McpServer,
  McpTool,
  ProviderPreset,
  PermissionPreset,
  PermissionConfirmation,
  RunSession,
  SessionPermissionMode,
  Task,
  TeammatePersonaDraft,
  TeammateActivityItem,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammateDirectReplyIntervention,
  TeammateDirectRuntimeResponse,
  DirectWorkspaceResponse,
  TeammateMcpBinding,
  TeammatePrivateAttachment,
  TeammateDirectMessageStreamBlockedEvent,
  TeammateDirectMessageStreamDeltaEvent,
  TeammateDirectMessageStreamRunLinkedEvent,
  TeammateDirectMessageStreamDoneEvent,
  TeammateDirectMessageStreamErrorEvent,
  TeammateDirectMessageStreamReadyEvent,
  UpdateAiTeammateRequest,
  UserProfile,
  WorkspaceAccessMode,
  TerminalReportDto,
} from "../../types.js";
import { resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../../lib/conversation-authorization.js";
import { TeammateActivityTab } from "./TeammateActivityTab.js";
import { TeammateChatHeader } from "./TeammateChatHeader.js";
import { type ConversationSummaryRow, type WorkspaceRightDockFileTarget, type WorkspaceRightDockPageRequest, type WorkspaceRightDockReviewTarget } from "../workspace/right-dock/index.js";
import { buildTeammatePrivateDockViewModel } from "./teammate-private-dock.js";
import { TeammateChannelsTab } from "./TeammateChannelsTab.js";
import { TeammateDangerTab } from "./TeammateDangerTab.js";
import { TeammateMemoryTab } from "./TeammateMemoryTab.js";
import { TeammateMcpTab, type McpToolFilter as TeammateMcpToolFilter } from "./TeammateMcpTab.js";
import { TeammateModelTab } from "./TeammateModelTab.js";
import { TeammatePermissionsTab } from "./TeammatePermissionsTab.js";
import { TeammateProfileTab } from "./TeammateProfileTab.js";
import { TeammatePrivateChatSurface } from "./TeammatePrivateChatSurface.js";
import { TeammateSettingsHeader } from "./TeammateSettingsHeader.js";
import { TeammateSettingsNavigation } from "./TeammateSettingsNavigation.js";
import { TeammateSettingsSummaryPanel } from "./TeammateSettingsSummaryPanel.js";
import { TeammateSkillsTab } from "./TeammateSkillsTab.js";
import { TeammateTasksTab } from "./TeammateTasksTab.js";
import { useWorkspaceRightDockController } from "../workspace/useWorkspaceRightDockController.js";
import { useConversationHeaderController } from "../workspace/useConversationHeaderController.js";
import { teammatePrivateMessageSearchText } from "./teammate-private-chat-view-models.js";
import {
  directComposerFileRefs,
  directWorkspacePathLabel,
  directWorkspaceStatusLabel,
  directGuidanceDraftText,
  extractUrls,
  pendingAttachmentItemsFromIds,
  summarizeDirectGuidancePayload,
  teammateToSettingsForm,
  truncateText,
  uniqueDirectLinkPreviews,
  upsertDirectMessages,
  type TeammateSettingsForm,
} from "./teammate-workspace-utils.js";
import { useTeammateProfileController } from "./useTeammateProfileController.js";
import { useTeammateActivityController } from "./useTeammateActivityController.js";
import { useTeammateModelController } from "./useTeammateModelController.js";
import { useTeammateSkillsController } from "./useTeammateSkillsController.js";
import { useTeammateTasksController } from "./useTeammateTasksController.js";
import { useTeammateMemoryController } from "./useTeammateMemoryController.js";
import { useTeammateChannelsController } from "./useTeammateChannelsController.js";
import { useTeammateDangerController } from "./useTeammateDangerController.js";
import { useTeammateMcpFeedbackController } from "./useTeammateMcpFeedbackController.js";

type TeammateWorkspaceView = "chat" | "settings";
type TeammateWorkspaceTab = "profile" | "model" | "permissions" | "channels" | "skills" | "memory" | "mcp" | "danger" | "tasks" | "activity";
type McpToolFilter = TeammateMcpToolFilter;

type MaybePromise<T> = T | Promise<T>;

export function TeammateWorkspace({
  cwd,
  teammate,
  userProfile,
  providers,
  channels,
  runs,
  skillPack,
  onUpdateTeammate,
  onTeammateUpdated,
  onDisableTeammate,
  onHardDeleteTeammate,
  onOpenProviders,
  onRefreshTeammates,
  onRefreshChannels,
  onTaskCreated,
  onOpenRun,
  onOpenTaskInWorkBoard,
  onOpenWorkBoard,
  defaultAuthorizationMode,
  defaultWorkspaceAccessMode,
  workspaceDefaultsAvailable = false,
  onOpenAuthorizationSettings,
  onDirectConversationChange,
  onConfirmFullAccess,
  defaultPermissionMode,
  defaultPermissionPreset,
  workspacePolicy,
  workspacePolicyLoading = false,
  workspacePolicyError,
  onRefreshWorkspacePolicy,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly userProfile?: UserProfile;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly runs: readonly RunSession[];
  readonly skillPack: SkillPack | undefined;
  readonly onUpdateTeammate: (teammateId: string, input: UpdateAiTeammateRequest) => Promise<AiTeammate>;
  readonly onTeammateUpdated?: (teammate: AiTeammate) => void;
  readonly onDisableTeammate: (teammateId: string) => Promise<void>;
  readonly onHardDeleteTeammate?: (teammateId: string, reason?: string) => Promise<void>;
  readonly onOpenProviders: () => void;
  readonly onRefreshTeammates?: () => MaybePromise<void>;
  readonly onRefreshChannels?: () => MaybePromise<void>;
  readonly onTaskCreated?: (task: Task) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenTaskInWorkBoard?: (task: Task) => void;
  readonly onOpenWorkBoard?: () => void;
  readonly defaultAuthorizationMode?: AuthorizationMode;
  readonly defaultWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly workspaceDefaultsAvailable?: boolean;
  readonly onOpenAuthorizationSettings?: () => void;
  readonly onDirectConversationChange?: (threadId?: string) => void;
  readonly onConfirmFullAccess?: () => Promise<PermissionConfirmation | undefined>;
  readonly defaultPermissionMode?: SessionPermissionMode;
  readonly defaultPermissionPreset?: PermissionPreset;
  readonly workspacePolicy?: ApprovalPolicy;
  readonly workspacePolicyLoading?: boolean;
  readonly workspacePolicyError?: string;
  readonly onRefreshWorkspacePolicy?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [workspaceView, setWorkspaceView] = useState<TeammateWorkspaceView>("chat");
  const [activeTab, setActiveTab] = useState<TeammateWorkspaceTab>("profile");
  const [messages, setMessages] = useState<readonly TeammateDirectMessage[]>([]);
  const [selectedWorkspaceAccessMode, setSelectedWorkspaceAccessMode] = useState<WorkspaceAccessMode>(() => resolveWorkspaceAccessMode(
    defaultWorkspaceAccessMode,
    defaultPermissionMode,
    defaultPermissionPreset,
  ));
  const [hasMoreDirectMessages, setHasMoreDirectMessages] = useState(false);
  const [nextDirectBeforeMessageId, setNextDirectBeforeMessageId] = useState<string | undefined>();
  const [loadingOlderDirectMessages, setLoadingOlderDirectMessages] = useState(false);
  const [terminalReports, setTerminalReports] = useState<readonly TerminalReportDto[]>([]);
  const [directExecutionActions, setDirectExecutionActions] = useState<readonly ExecutionAction[]>([]);
  const [directRuntime, setDirectRuntime] = useState<TeammateDirectRuntimeResponse | undefined>();
  const [directWorkspace, setDirectWorkspace] = useState<DirectWorkspaceResponse | undefined>();

  useEffect(() => {
    onDirectConversationChange?.(workspaceView === "chat" ? directWorkspace?.threadId : undefined);
  }, [directWorkspace?.threadId, onDirectConversationChange, workspaceView]);

  useEffect(() => () => onDirectConversationChange?.(undefined), [onDirectConversationChange]);
  const [directReplyOptimisticActive, setDirectReplyOptimisticActive] = useState(false);
  const [directGuidanceSubmitting, setDirectGuidanceSubmitting] = useState<"queue_followup" | "interrupt_redirect" | "stop" | "">("");
  const [directGuidanceCancelingId, setDirectGuidanceCancelingId] = useState("");
  const [directGuidancePromotingId, setDirectGuidancePromotingId] = useState("");
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const [chatDockOpen, setChatDockOpen] = useState(false);
  const [chatDockPageRequest, setChatDockPageRequest] = useState<WorkspaceRightDockPageRequest>();
  const [chatSummaryOpen, setChatSummaryOpen] = useState(false);
  const [chatTerminalOpen, setChatTerminalOpen] = useState(false);
  const [privateAttachments, setPrivateAttachments] = useState<readonly TeammatePrivateAttachment[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachmentItem<TeammatePrivateAttachment>[]>([]);
  const [directLinkPreviews, setDirectLinkPreviews] = useState<readonly TeammateDirectLinkPreview[]>([]);
  const [pendingDirectLinkPreviewIds, setPendingDirectLinkPreviewIds] = useState<readonly string[]>([]);
  const [mcpServers, setMcpServers] = useState<readonly McpServer[]>([]);
  const [mcpTools, setMcpTools] = useState<readonly McpTool[]>([]);
  const [mcpBindings, setMcpBindings] = useState<readonly TeammateMcpBinding[]>([]);
  const [activityItems, setActivityItems] = useState<readonly TeammateActivityItem[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [settingsForm, setSettingsForm] = useState<TeammateSettingsForm>(() => teammateToSettingsForm(teammate));
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [privateFeedLatestButtonVisible, setPrivateFeedLatestButtonVisible] = useState(false);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [expandedMcpServerIds, setExpandedMcpServerIds] = useState<ReadonlySet<string>>(() => new Set());
  const [mcpToolSearchByServerId, setMcpToolSearchByServerId] = useState<Readonly<Record<string, string>>>({});
  const [mcpToolFilterByServerId, setMcpToolFilterByServerId] = useState<Readonly<Record<string, McpToolFilter>>>({});
  const [workspaceError, setWorkspaceError] = useState("");
  const chatHeaderController = useConversationHeaderController({
    identityKey: teammate.id,
    onRefresh: cwd.trim() ? () => refreshTeammateWorkspace(false) : undefined,
    onSearchChange: setMessageSearchQuery,
  });
  const privateFeedRef = useRef<HTMLDivElement | null>(null);
  const privateFeedPinnedToLatestRef = useRef(true);
  const privateFeedAutoFollowUntilRef = useRef(0);
  const privateFeedUserScrollIntentRef = useRef(false);
  const directGuidanceOperationSeqRef = useRef(0);
  const attachmentPreviewUrlsRef = useRef(new Set<string>());
  const teammateIdentityRef = useRef(teammate.id);
  teammateIdentityRef.current = teammate.id;
  const provider = teammate.providerPresetId ? providers.find((item) => item.id === teammate.providerPresetId) : undefined;
  const isProtectedSystemTeammate = Boolean(teammate.protectedProfile || teammate.kind === "system_teammate" || teammate.systemRole === "ling_agent");
  const dangerController = useTeammateDangerController({
    teammate,
    onDisableTeammate,
    onHardDeleteTeammate,
  });
  const profileController = useTeammateProfileController({
    cwd,
    teammate,
    settingsForm,
    setSettingsForm,
    isProtectedSystemTeammate,
    onUpdateTeammate,
    onTeammateUpdated,
    onRefreshTeammates,
  });
  const modelController = useTeammateModelController({
    teammate,
    providers,
    settingsForm,
    setSettingsForm,
    isProtectedSystemTeammate,
    onUpdateTeammate,
    onTeammateUpdated,
    onRefreshDirectRuntime: refreshDirectRuntime,
  });
  const channelsController = useTeammateChannelsController({
    channels,
    cwd,
    protectedTeammate: isProtectedSystemTeammate,
    teammate,
    onRefreshChannels,
  });
  const skillsController = useTeammateSkillsController({
    cwd,
    fallbackDefinitions: skillPack?.skills ?? [],
    teammateId: teammate.id,
  });
  const memoryController = useTeammateMemoryController({ cwd, teammate, channels });
  const mcpFeedbackController = useTeammateMcpFeedbackController({
    bindings: mcpBindings,
    cwd,
    onBindingsReplaced: setMcpBindings,
    teammateId: teammate.id,
  });
  const effectiveSkills = skillsController.effectiveSkills;
  const skillStats = skillsController.stats;
  const memoryById = memoryController.memoryById;
  const memoryScopes = memoryController.snapshot?.scopes ?? [];
  const usedMemoryEvents = memoryController.snapshot?.usedEvents ?? [];
  const privateAttachmentById = useMemo(() => new Map(privateAttachments.map((attachment) => [attachment.id, attachment])), [privateAttachments]);
  const directLinkPreviewById = useMemo(() => new Map(directLinkPreviews.map((preview) => [preview.id, preview])), [directLinkPreviews]);
  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const readyAttachmentIds = pendingAttachments.flatMap((item) => item.attachment ? [item.attachment.id] : []);
  const privateSlashCommands = useMemo(
    () => effectiveSkills.map((skill) => ({ id: skill.skillId, label: skill.skill.name })),
    [effectiveSkills],
  );
  const composerInputParts = parseComposerInputParts(messageDraft, {
    cwd: cwd.trim(),
    attachments: readyAttachmentIds.map((attachmentId) => ({ attachmentId })),
    skills: effectiveSkills.map((skill) => ({ id: skill.skillId, label: skill.skill.name })),
    slashCommands: privateSlashCommands,
  });
  const composerFileReferenceParts = composerWorkspaceFileParts(composerInputParts);
  const composerFileReferenceTokens = composerFileReferenceParts.map((part, index) => ({
    part,
    occurrenceIndex: composerFileReferenceParts.slice(0, index).filter((candidate) => candidate.raw === part.raw).length,
  }));
  const channelsById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const effectiveMemberships = channelsController.effectiveMemberships;
  const tasksController = useTeammateTasksController({
    cwd,
    teammate,
    channels,
    memberships: effectiveMemberships,
    skills: effectiveSkills,
    onOpenTask: openAssignedTask,
    onOpenWorkBoard,
    onTaskCreated: handleTaskCreated,
  });
  const activityController = useTeammateActivityController({
    cwd,
    enabled: workspaceView === "settings" && activeTab === "activity",
    teammateId: teammate.id,
  });
  const mcpToolsByServerId = useMemo(() => {
    const grouped = new Map<string, McpTool[]>();
    for (const tool of mcpTools) {
      grouped.set(tool.serverId, [...(grouped.get(tool.serverId) ?? []), tool]);
    }
    return grouped;
  }, [mcpTools]);
  const mcpBindingByServerId = useMemo(() => new Map(mcpBindings.map((binding) => [binding.serverId, binding])), [mcpBindings]);
  const settingsSections: readonly { readonly id: TeammateWorkspaceTab; readonly label: string; readonly count?: number; readonly danger?: boolean }[] = [
    { id: "profile", label: t("Profile") },
    { id: "model", label: t("Model") },
    { id: "permissions", label: t("Permissions") },
    { id: "channels", label: t("Channels"), count: channelsController.stats.joined },
    { id: "tasks", label: t("Tasks"), count: tasksController.stats.total },
    { id: "activity", label: t("Activity") },
    { id: "memory" as const, label: t("Memory"), count: memoryController.snapshot?.inbox.length || memoryScopes.length },
    ...(isProtectedSystemTeammate ? [] : [
      { id: "skills" as const, label: t("Skills"), count: skillStats.bound },
      { id: "mcp" as const, label: t("MCP") },
    ]),
    { id: "danger" as const, label: t("Danger zone"), danger: true },
  ];
  const normalizedMessageSearchQuery = messageSearchQuery.trim().toLowerCase();
  const visibleMessages = useMemo(() => {
    if (!normalizedMessageSearchQuery) {
      return messages;
    }
    return messages.filter((message) => teammatePrivateMessageSearchText({
      message,
      attachmentById: privateAttachmentById,
      linkPreviewById: directLinkPreviewById,
      runById,
    }).includes(normalizedMessageSearchQuery));
  }, [directLinkPreviewById, messages, normalizedMessageSearchQuery, privateAttachmentById, runById]);
  const directReplyActive = Boolean(directRuntime?.activeReply || directReplyOptimisticActive);
  const hasDirectRuntimeActivity = Boolean(directRuntime?.activeReply || directReplyOptimisticActive || (directRuntime?.interventions.length ?? 0) > 0);

  useEffect(() => {
    const workspaceCwd = cwd.trim();
    const runThreadIdById = new Map(runs.map((run) => [run.id, run.threadId]));
    const threadIds = [...new Set(visibleMessages.flatMap((message) => [
      message.threadId,
      message.linkedRunId ? runThreadIdById.get(message.linkedRunId) : undefined,
    ]).filter((threadId): threadId is string => Boolean(threadId)))];
    if (!workspaceCwd || threadIds.length === 0) {
      setTerminalReports([]);
      return;
    }
    let cancelled = false;
    void Promise.all(threadIds.map((threadId) => listTerminalReports(workspaceCwd, { threadId, limit: 100 })))
      .then((responses) => {
        if (!cancelled) {
          setTerminalReports(responses.flatMap((response) => response.reports));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTerminalReports([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, runs, visibleMessages]);

  const visibleDirectRunIds = useMemo(() => {
    const teammateRunIds = new Set(runs.filter((run) => !run.teammateId || run.teammateId === teammate.id).map((run) => run.id));
    return [...new Set(visibleMessages
      .map((message) => message.linkedRunId)
      .filter((runId): runId is string => Boolean(runId && teammateRunIds.has(runId))))];
  }, [runs, teammate.id, visibleMessages]);
  const visibleDirectRunKey = visibleDirectRunIds.join("|");
  const hasActiveVisibleDirectRun = useMemo(() => {
    const visibleRunIds = new Set(visibleDirectRunIds);
    return runs.some((run) => visibleRunIds.has(run.id) && (
      run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval"
    ));
  }, [runs, visibleDirectRunKey]);

  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || visibleDirectRunIds.length === 0) {
      setDirectExecutionActions([]);
      return undefined;
    }
    let cancelled = false;
    let loading = false;
    const refresh = async (): Promise<void> => {
      if (loading) {
        return;
      }
      loading = true;
      try {
        const responses = await Promise.all(visibleDirectRunIds.map((runId) =>
          listExecutionActions(workspaceCwd, { runId, limit: 100 }),
        ));
        if (!cancelled) {
          const byId = new Map(responses.flatMap((response) => response.actions).map((action) => [action.id, action]));
          setDirectExecutionActions([...byId.values()]);
        }
      } catch {
        // Preserve the last persisted snapshot across transient polling failures.
      } finally {
        loading = false;
      }
    };
    void refresh();
    const interval = directReplyActive || hasDirectRuntimeActivity || hasActiveVisibleDirectRun
      ? window.setInterval(() => {
          if (document.visibilityState === "visible") {
            void refresh();
          }
        }, 750)
      : undefined;
    return () => {
      cancelled = true;
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, [cwd, directReplyActive, hasActiveVisibleDirectRun, hasDirectRuntimeActivity, visibleDirectRunKey]);

  useEffect(() => {
    if (isProtectedSystemTeammate && (activeTab === "skills" || activeTab === "mcp")) {
      setActiveTab("profile");
    }
  }, [activeTab, isProtectedSystemTeammate]);
  const latestVisiblePrivateMessageId = visibleMessages.at(-1)?.id ?? "";
  const latestVisiblePrivateMessage = visibleMessages.at(-1);
  const latestVisiblePrivateMessageSignature = latestVisiblePrivateMessage
    ? [
        latestVisiblePrivateMessage.id,
        latestVisiblePrivateMessage.status,
        latestVisiblePrivateMessage.updatedAt,
        latestVisiblePrivateMessage.body,
        latestVisiblePrivateMessage.attachmentIds.join(","),
      ].join("|")
    : "";
  const privateMessageFeedVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => privateFeedRef.current,
    estimateSize: () => 112,
    overscan: 8,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
  });
  const privateMessageFeedVirtualRows = privateMessageFeedVirtualizer.getVirtualItems();
  const directAttachments = useMemo(
    () => privateAttachments.filter((attachment) => attachment.scope === "teammate_direct_thread"),
    [privateAttachments],
  );
  const privateDockViewModel = useMemo(
    () => buildTeammatePrivateDockViewModel({
      teammate,
      messages,
      attachments: directAttachments,
      runs,
      executionActions: directExecutionActions,
      terminalReports,
      directWorkspace,
      usedMemoryEvents,
      memoryById,
      activityItems,
      refreshing: chatHeaderController.refreshing,
      t,
    }),
    [
      activityItems,
      chatHeaderController.refreshing,
      directAttachments,
      directExecutionActions,
      directWorkspace,
      memoryById,
      messages,
      runs,
      t,
      teammate,
      terminalReports,
      usedMemoryEvents,
    ],
  );
  const privateSummaryRows = useMemo<readonly ConversationSummaryRow[]>(() => [
    {
      id: "teammate",
      icon: <Brain size={18} />,
      primary: t("AI teammate"),
      secondary: `${teammate.displayName} · ${t(`role.${teammate.roleKey}`)}`,
    },
    {
      id: "workspace",
      icon: <Folder size={18} />,
      tone: privateDockViewModel.context.workspace.error ? "failed" : "neutral",
      primary: t("Private workspace"),
      secondary: `${directWorkspacePathLabel(directWorkspace, t)} · ${directWorkspaceStatusLabel(directWorkspace, t)}`,
      onOpen: () => openChatDockPage("context"),
    },
    {
      id: "latest-reply",
      icon: <MessageSquare size={18} />,
      primary: t("Latest reply"),
      secondary: privateDockViewModel.context.latestReply?.summary ?? t("No AI reply summary yet."),
      onOpen: () => openChatDockPage("context"),
    },
    {
      id: "files",
      icon: <FileText size={18} />,
      primary: t("Files"),
      secondary: t("{count} files", { count: privateDockViewModel.fileItems.length }),
      onOpen: () => openChatDockPage("files"),
    },
    {
      id: "memory",
      icon: <Brain size={18} />,
      primary: t("Memory"),
      secondary: privateDockViewModel.context.memoryEventCount === 1 ? t("1 item") : t("{count} items", { count: privateDockViewModel.context.memoryEventCount }),
      onOpen: () => openChatDockPage("context"),
    },
  ], [
    directWorkspace,
    privateDockViewModel,
    t,
    teammate.displayName,
    teammate.roleKey,
  ]);
  const chatDockController = useWorkspaceRightDockController({
    initialOpen: false,
    intentOpen: chatDockOpen,
    resizeObserverKey: `${teammate.id}:${cwd.trim()}`,
  });
  const chatSummaryDockOffset = chatDockController.expanded
    ? chatDockController.width + 8
    : 0;
  const chatSummaryDockMotion = chatDockOpen
    ? "header->main"
    : chatDockController.visible
      ? "main->header"
      : undefined;

  function openChatDockPage(page: WorkspaceRightDockPageRequest["page"], workspaceFile?: WorkspaceRightDockFileTarget, workspaceReview?: WorkspaceRightDockReviewTarget): void {
    setChatSummaryOpen(false);
    setChatDockOpen(true);
    setChatDockPageRequest({ page, nonce: Date.now(), workspaceFile, workspaceReview });
  }
  const pendingDirectLinkPreviews = useMemo(
    () => pendingDirectLinkPreviewIds.map((id) => directLinkPreviewById.get(id)).filter((preview): preview is TeammateDirectLinkPreview => Boolean(preview)),
    [directLinkPreviewById, pendingDirectLinkPreviewIds],
  );
  const providerReady = Boolean(provider && providerPreflightReady(provider));
  const providerRecovered = providerReady && Boolean(provider);
  const openDirectInterventions = directRuntime?.interventions ?? [];
  const hasQueuedDirectGuidance = openDirectInterventions.some((intervention) => intervention.status === "queued");
  const privateComposerPayload = useMemo(() => {
    const serializedInput = serializeComposerInputParts(composerInputParts);
    const fileRefs = directComposerFileRefs(composerFileReferenceParts);
    return {
      body: serializedInput.body.trim(),
      attachmentIds: [...serializedInput.attachmentIds],
      linkPreviewIds: [...pendingDirectLinkPreviewIds],
      fileRefs,
    };
  }, [composerFileReferenceParts, composerInputParts, pendingDirectLinkPreviewIds]);
  const privateComposerHasGuidancePayload =
    privateComposerPayload.body.length > 0 ||
    privateComposerPayload.attachmentIds.length > 0 ||
    privateComposerPayload.linkPreviewIds.length > 0 ||
    privateComposerPayload.fileRefs.length > 0;
  const privateAttachmentOperationPending = pendingAttachments.some((item) => item.state === "uploading");
  const privateComposerSendDisabled = directReplyActive
    ? Boolean(directGuidanceSubmitting || privateAttachmentOperationPending)
    : hasQueuedDirectGuidance || privateAttachmentOperationPending || (!messageDraft.trim() && readyAttachmentIds.length === 0 && pendingDirectLinkPreviewIds.length === 0 && composerFileReferenceParts.length === 0);
  const privateComposerSending = directReplyActive ? Boolean(directGuidanceSubmitting) : sending;
  const privateComposerSendLabel = directReplyActive
    ? privateComposerHasGuidancePayload
      ? t("Queue guidance")
      : t("Stop reply")
    : t("Send");
  const privateComposerSendingLabel = directReplyActive
    ? directGuidanceSubmitting === "queue_followup"
      ? t("Queueing guidance...")
      : t("Stop reply")
    : t("Sending...");
  const privateComposerPlaceholder = directReplyActive
    ? t("Type guidance, then press Enter to queue it")
    : hasQueuedDirectGuidance
      ? t("Guidance is queued. Wait for it to run, or run it now.")
      : t("Message this AI teammate privately");
  const directAuthorizationMode = resolveAuthorizationMode(
    defaultAuthorizationMode,
    defaultPermissionMode,
    defaultPermissionPreset,
  );

  useEffect(() => {
    setSelectedWorkspaceAccessMode(resolveWorkspaceAccessMode(
      defaultWorkspaceAccessMode,
      defaultPermissionMode,
      defaultPermissionPreset,
    ));
  }, [defaultPermissionMode, defaultPermissionPreset, defaultWorkspaceAccessMode]);

  useEffect(() => {
    setSettingsForm(teammateToSettingsForm(teammate));
  }, [teammate]);

  useEffect(() => {
    setWorkspaceView("chat");
    setActiveTab("profile");
    setExpandedMcpServerIds(new Set());
    setMcpToolSearchByServerId({});
    setMcpToolFilterByServerId({});
    setMessageSearchQuery("");
    setChatDockOpen(false);
    setChatDockPageRequest(undefined);
    setChatSummaryOpen(false);
    setChatTerminalOpen(false);
    setMessages([]);
    setHasMoreDirectMessages(false);
    setNextDirectBeforeMessageId(undefined);
    setLoadingOlderDirectMessages(false);
    revokePendingAttachmentPreviews(pendingAttachments, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
    setPendingAttachments([]);
    setPendingDirectLinkPreviewIds([]);
    setDirectLinkPreviews([]);
    setDirectWorkspace(undefined);
    setDirectRuntime(undefined);
    setDirectReplyOptimisticActive(false);
    setDirectGuidanceSubmitting("");
    setDirectGuidanceCancelingId("");
    setDirectGuidancePromotingId("");
    privateFeedPinnedToLatestRef.current = true;
    privateFeedUserScrollIntentRef.current = false;
    setPrivateFeedLatestButtonVisible(false);
  }, [teammate.id]);

  useEffect(() => () => {
    for (const previewUrl of attachmentPreviewUrlsRef.current) {
      revokeObjectUrl(previewUrl);
    }
    attachmentPreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    void refreshTeammateWorkspace();
  }, [cwd, teammate.id]);

  useEffect(() => {
    privateFeedPinnedToLatestRef.current = true;
    privateFeedUserScrollIntentRef.current = false;
    setPrivateFeedLatestButtonVisible(false);
  }, [normalizedMessageSearchQuery]);

  useEffect(() => {
    if (loading || workspaceView !== "chat" || !privateFeedPinnedToLatestRef.current) {
      return undefined;
    }
    const feed = privateFeedRef.current;
    if (!feed) {
      return undefined;
    }
    const frameIds: number[] = [];
    const scrollToLatest = (attempt: number): void => {
      privateFeedAutoFollowUntilRef.current = Date.now() + 1_000;
      privateFeedUserScrollIntentRef.current = false;
      if (visibleMessages.length > 0) {
        privateMessageFeedVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: "end" });
      }
      feed.scrollTop = feed.scrollHeight;
      privateFeedPinnedToLatestRef.current = true;
      setPrivateFeedLatestButtonVisible(false);
      if (attempt < 4) {
        const frameId = globalThis.requestAnimationFrame(() => scrollToLatest(attempt + 1));
        frameIds.push(frameId);
      }
    };
    const frameId = globalThis.requestAnimationFrame(() => scrollToLatest(0));
    frameIds.push(frameId);
    return () => {
      frameIds.forEach((scheduledFrameId) => globalThis.cancelAnimationFrame(scheduledFrameId));
    };
  }, [latestVisiblePrivateMessageId, latestVisiblePrivateMessageSignature, loading, privateMessageFeedVirtualizer, visibleMessages.length, workspaceView]);

  useEffect(() => {
    if (workspaceView !== "chat" || !hasDirectRuntimeActivity || !cwd.trim()) {
      return undefined;
    }
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        await refreshDirectRuntime();
      } catch {
        // Runtime polling is opportunistic; primary send errors still surface through workspaceError.
      }
    };
    const intervalId = globalThis.setInterval(() => {
      if (!cancelled) {
        void refresh();
      }
    }, 1500);
    return () => {
      cancelled = true;
      globalThis.clearInterval(intervalId);
    };
  }, [cwd, hasDirectRuntimeActivity, teammate.id, workspaceView]);

  async function refreshTeammateWorkspace(showLoading = true): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setWorkspaceError(t("Workspace path is required."));
      return;
    }
    const skillSnapshotRequestId = skillsController.beginSnapshotRequest(teammate.id);
    if (showLoading) setLoading(true);
    try {
      setWorkspaceError("");
      const [
        directResponse,
        directRuntimeResponse,
        directWorkspaceResponse,
        directLinkPreviewsResponse,
        privateAttachmentsResponse,
        skillRegistryResponse,
        skillSourceHealthResponse,
        skillResponse,
        mcpServersResponse,
        mcpToolsResponse,
        mcpBindingsResponse,
        activityResponse,
      ] = await Promise.all([
        listTeammateDirectMessages(workspaceCwd, teammate.id),
        getTeammateDirectRuntime(workspaceCwd, teammate.id),
        getTeammateDirectWorkspace(workspaceCwd, teammate.id),
        listTeammateDirectLinkPreviews(workspaceCwd, teammate.id),
        listTeammatePrivateAttachments(workspaceCwd, teammate.id),
        listSkills(workspaceCwd),
        getSkillSourceHealth(workspaceCwd, { limit: 100 }),
        listTeammateSkills(workspaceCwd, teammate.id),
        listMcpServers(workspaceCwd),
        listMcpTools(workspaceCwd),
        listTeammateMcpBindings(workspaceCwd, teammate.id),
        listTeammateActivity(workspaceCwd, teammate.id),
      ]);
      setMessages(directResponse.messages);
      setHasMoreDirectMessages(Boolean(directResponse.hasMore));
      setNextDirectBeforeMessageId(directResponse.nextBeforeMessageId);
      setDirectRuntime(directRuntimeResponse);
      setDirectWorkspace(directWorkspaceResponse);
      setDirectLinkPreviews(directLinkPreviewsResponse.linkPreviews);
      setPrivateAttachments(privateAttachmentsResponse.attachments);
      skillsController.applySnapshot(teammate.id, skillSnapshotRequestId, {
        registryEntries: skillRegistryResponse.skills,
        sourceSnapshots: skillSourceHealthResponse.snapshots,
        bindings: skillResponse.bindings,
        effectiveSkills: skillResponse.effectiveSkills ?? [],
      });
      setMcpServers(mcpServersResponse.servers);
      setMcpTools(mcpToolsResponse.tools);
      setMcpBindings(mcpBindingsResponse.bindings);
      setActivityItems(activityResponse.items);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function refreshDirectRuntime(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      return;
    }
    const [directResponse, runtimeResponse, directWorkspaceResponse, linkPreviewsResponse, privateAttachmentsResponse] = await Promise.all([
      listTeammateDirectMessages(workspaceCwd, teammate.id),
      getTeammateDirectRuntime(workspaceCwd, teammate.id),
      getTeammateDirectWorkspace(workspaceCwd, teammate.id),
      listTeammateDirectLinkPreviews(workspaceCwd, teammate.id),
      listTeammatePrivateAttachments(workspaceCwd, teammate.id),
    ]);
    setMessages((current) => current.length > directResponse.messages.length
      ? upsertDirectMessages(current, directResponse.messages)
      : directResponse.messages);
    setHasMoreDirectMessages(Boolean(directResponse.hasMore));
    setNextDirectBeforeMessageId(directResponse.nextBeforeMessageId);
    setDirectRuntime(runtimeResponse);
    setDirectWorkspace(directWorkspaceResponse);
    setDirectLinkPreviews(linkPreviewsResponse.linkPreviews);
    setPrivateAttachments(privateAttachmentsResponse.attachments);
    setDirectReplyOptimisticActive(Boolean(runtimeResponse.activeReply));
  }

  async function loadOlderDirectMessages(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (
      !workspaceCwd ||
      loadingOlderDirectMessages ||
      !hasMoreDirectMessages ||
      !nextDirectBeforeMessageId ||
      normalizedMessageSearchQuery
    ) {
      return;
    }
    const feed = privateFeedRef.current;
    const previousScrollHeight = feed?.scrollHeight ?? 0;
    const previousScrollTop = feed?.scrollTop ?? 0;
    setLoadingOlderDirectMessages(true);
    privateFeedPinnedToLatestRef.current = false;
    try {
      const response = await listTeammateDirectMessages(workspaceCwd, teammate.id, {
        beforeMessageId: nextDirectBeforeMessageId,
      });
      setMessages((current) => upsertDirectMessages(current, response.messages));
      setHasMoreDirectMessages(Boolean(response.hasMore));
      setNextDirectBeforeMessageId(response.nextBeforeMessageId);
      globalThis.requestAnimationFrame(() => {
        globalThis.requestAnimationFrame(() => {
          const nextFeed = privateFeedRef.current;
          if (!nextFeed) {
            return;
          }
          nextFeed.scrollTop = nextFeed.scrollHeight - previousScrollHeight + previousScrollTop;
        });
      });
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingOlderDirectMessages(false);
    }
  }

  async function resolveActiveDirectReply() {
    if (directRuntime?.activeReply) {
      return directRuntime.activeReply;
    }
    const runtimeResponse = await getTeammateDirectRuntime(cwd.trim(), teammate.id);
    setDirectRuntime(runtimeResponse);
    setDirectReplyOptimisticActive(Boolean(runtimeResponse.activeReply));
    return runtimeResponse.activeReply;
  }

  async function ensureDirectLinkPreviewsForBody(body: string): Promise<readonly TeammateDirectLinkPreview[]> {
    const existing = [...pendingDirectLinkPreviews];
    const created: TeammateDirectLinkPreview[] = [];
    for (const url of extractUrls(body)) {
      if (existing.some((preview) => preview.url === url || preview.normalizedUrl === url) || created.some((preview) => preview.url === url || preview.normalizedUrl === url)) {
        continue;
      }
      const response = await createTeammateDirectLinkPreview(cwd.trim(), teammate.id, { url });
      created.push(response.linkPreview);
      setDirectLinkPreviews((current) => [
        response.linkPreview,
        ...current.filter((preview) => preview.id !== response.linkPreview.id),
      ]);
    }
    return uniqueDirectLinkPreviews([...existing, ...created]);
  }

  async function sendPrivateMessage(authorization: {
    readonly permissionPreset: PermissionPreset;
    readonly permissionConfirmation?: PermissionConfirmation;
  }): Promise<void> {
    const serializedInput = serializeComposerInputParts(composerInputParts);
    const body = serializedInput.body.trim();
    const attachmentIds = [...serializedInput.attachmentIds];
    const fileRefs = directComposerFileRefs(composerFileReferenceParts);
    if ((!body && attachmentIds.length === 0 && pendingDirectLinkPreviewIds.length === 0 && fileRefs.length === 0) || sending) {
      return;
    }
    let permissionConfirmation = authorization.permissionConfirmation;
    if (authorization.permissionPreset === "full_access" && !permissionConfirmation) {
      permissionConfirmation = await onConfirmFullAccess?.();
      if (!permissionConfirmation) return;
    }
    const draftSnapshot = messageDraft;
    const attachmentsSnapshot = pendingAttachments;
    const linkPreviewIdsSnapshot = pendingDirectLinkPreviewIds;
    setSending(true);
    try {
      setWorkspaceError("");
      const linkPreviews = await ensureDirectLinkPreviewsForBody(body);
      setMessageDraft("");
      setPendingAttachments([]);
      setPendingDirectLinkPreviewIds([]);
      privateFeedPinnedToLatestRef.current = true;
      privateFeedAutoFollowUntilRef.current = Date.now() + 3_000;
      privateFeedUserScrollIntentRef.current = false;
      setPrivateFeedLatestButtonVisible(false);
      const response = await streamTeammateDirectMessage(cwd.trim(), teammate.id, {
        body,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs,
        providerPresetId: teammate.providerPresetId,
        authorizationMode: directAuthorizationMode,
        workspaceAccessMode: selectedWorkspaceAccessMode,
        permissionPreset: authorization.permissionPreset,
        permissionConfirmation,
      });
      await readSseResponse(response, (event) => {
        if (event.event === "ready") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamReadyEvent;
          setMessages((current) => upsertDirectMessages(current, [data.message, data.aiReply]));
          setDirectReplyOptimisticActive(true);
          setSending(false);
          void refreshDirectRuntime();
          return;
        }
        if (event.event === "delta") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamDeltaEvent;
          setMessages((current) => current.map((message) => message.id === data.messageId ? {
            ...message,
            body: data.body,
            status: "pending",
          } : message));
          return;
        }
        if (event.event === "run_linked") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamRunLinkedEvent;
          setMessages((current) => current.map((message) => message.id === data.messageId ? {
            ...message,
            linkedRunId: data.linkedRunId ?? message.linkedRunId,
          } : message));
          return;
        }
        if (event.event === "done") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamDoneEvent;
          setMessages((current) => upsertDirectMessages(current, [data.message, data.aiReply]));
          setDirectReplyOptimisticActive(false);
          return;
        }
        if (event.event === "blocked") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamBlockedEvent;
          setMessages((current) => upsertDirectMessages(current, [data.message, data.aiReply]));
          setDirectReplyOptimisticActive(false);
          setSending(false);
          return;
        }
        if (event.event === "error") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamErrorEvent;
          const nextMessages = [data.message, data.aiReply].filter((message): message is TeammateDirectMessage => Boolean(message));
          if (nextMessages.length > 0) {
            setMessages((current) => upsertDirectMessages(current, nextMessages));
          }
          if (data.error) {
            setWorkspaceError(data.error);
          }
          setDirectReplyOptimisticActive(false);
          setSending(false);
        }
      });
      const [activityResponse] = await Promise.all([
        listTeammateActivity(cwd.trim(), teammate.id),
        memoryController.refresh("background"),
      ]);
      setActivityItems(activityResponse.items);
      revokePendingAttachmentPreviews(attachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      await refreshDirectRuntime();
    } catch (error) {
      setMessageDraft(draftSnapshot);
      setPendingAttachments(attachmentsSnapshot);
      setPendingDirectLinkPreviewIds(linkPreviewIdsSnapshot);
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  async function stopDirectReply(): Promise<void> {
    if (directGuidanceSubmitting) {
      return;
    }
    setDirectGuidanceSubmitting("stop");
    try {
      setWorkspaceError("");
      const activeReply = await resolveActiveDirectReply();
      if (!activeReply) {
        setDirectReplyOptimisticActive(false);
        setWorkspaceError(t("There is no active private reply right now."));
        return;
      }
      const response = await cancelTeammateDirectReply(cwd.trim(), activeReply.workUnitId, { reason: "user_requested" });
      if (response.message) {
        setMessages((current) => upsertDirectMessages(current, [response.message!]));
      }
      setDirectReplyOptimisticActive(false);
      await refreshDirectRuntime();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setDirectGuidanceSubmitting("");
    }
  }

  async function submitDirectGuidance(mode: "queue_followup" | "interrupt_redirect"): Promise<boolean> {
    const payload = privateComposerPayload;
    if ((!payload.body && payload.attachmentIds.length === 0 && payload.linkPreviewIds.length === 0 && payload.fileRefs.length === 0) || directGuidanceSubmitting) {
      return false;
    }
    const draftSnapshot = messageDraft;
    const attachmentsSnapshot = pendingAttachments;
    const linkPreviewIdsSnapshot = pendingDirectLinkPreviewIds;
    setDirectGuidanceSubmitting(mode);
    try {
      setWorkspaceError("");
      const activeReply = await resolveActiveDirectReply();
      if (!activeReply) {
        setDirectReplyOptimisticActive(false);
        setWorkspaceError(t("There is no active private reply right now."));
        return false;
      }
      const linkPreviews = await ensureDirectLinkPreviewsForBody(payload.body);
      const completePayload = {
        ...payload,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
      };
      const instruction = summarizeDirectGuidancePayload(completePayload, t);
      const operationId = directGuidanceOperationSeqRef.current + 1;
      directGuidanceOperationSeqRef.current = operationId;
      const response = await createTeammateDirectIntervention(cwd.trim(), teammate.id, {
        mode,
        instruction,
        messagePayload: completePayload,
        idempotencyKey: `direct-guidance:${activeReply.workUnitId}:${mode}:${operationId}:${instruction}`,
      });
      setDirectRuntime(response.runtime);
      setMessageDraft("");
      setPendingAttachments([]);
      setPendingDirectLinkPreviewIds([]);
      revokePendingAttachmentPreviews(attachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      await refreshDirectRuntime();
      return true;
    } catch (error) {
      setMessageDraft(draftSnapshot);
      setPendingAttachments(attachmentsSnapshot);
      setPendingDirectLinkPreviewIds(linkPreviewIdsSnapshot);
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setDirectGuidanceSubmitting("");
    }
  }

  async function cancelDirectGuidance(interventionId: string): Promise<void> {
    if (directGuidanceCancelingId) {
      return;
    }
    setDirectGuidanceCancelingId(interventionId);
    try {
      setWorkspaceError("");
      await cancelTeammateDirectIntervention(cwd.trim(), interventionId, { reason: "cancelled_by_user" });
      await refreshDirectRuntime();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setDirectGuidanceCancelingId("");
    }
  }

  async function editDirectGuidance(intervention: TeammateDirectReplyIntervention): Promise<void> {
    if (intervention.status !== "queued" || directGuidanceCancelingId) {
      return;
    }
    revokePendingAttachmentPreviews(pendingAttachments, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
    setMessageDraft(intervention.messagePayload ? directGuidanceDraftText(intervention.messagePayload) : intervention.instruction);
    setPendingAttachments(pendingAttachmentItemsFromIds(intervention.messagePayload?.attachmentIds ?? [], privateAttachmentById));
    setPendingDirectLinkPreviewIds(intervention.messagePayload?.linkPreviewIds ?? []);
    await cancelDirectGuidance(intervention.id);
  }

  async function promoteDirectGuidance(interventionId: string): Promise<void> {
    if (directGuidancePromotingId || directGuidanceSubmitting) {
      return;
    }
    setDirectGuidancePromotingId(interventionId);
    try {
      setWorkspaceError("");
      const response = await promoteTeammateDirectIntervention(cwd.trim(), interventionId, { reason: "user_requested" });
      setDirectRuntime(response.runtime);
      if (response.message) {
        setWorkspaceError(response.message);
      }
      await refreshDirectRuntime();
      const directMessagesResponse = await listTeammateDirectMessages(cwd.trim(), teammate.id);
      setMessages(directMessagesResponse.messages);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setDirectGuidancePromotingId("");
    }
  }

  function handlePrivateComposerSubmit(authorization: {
    readonly permissionPreset: PermissionPreset;
    readonly permissionConfirmation?: PermissionConfirmation;
  }): void {
    if (directReplyActive) {
      if (privateComposerHasGuidancePayload) {
        void submitDirectGuidance("queue_followup");
        return;
      }
      void stopDirectReply();
      return;
    }
    void sendPrivateMessage(authorization);
  }

  function handlePrivateComposerKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    authorization: {
      readonly permissionPreset: PermissionPreset;
      readonly permissionConfirmation?: PermissionConfirmation;
    },
  ): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (directReplyActive) {
      if (privateComposerHasGuidancePayload) {
        void submitDirectGuidance("queue_followup");
      }
      return;
    }
    if (hasQueuedDirectGuidance) {
      setWorkspaceError(t("Guidance is already queued. Run or delete the queued message first."));
      return;
    }
    void sendPrivateMessage(authorization);
  }

  function handlePrivateComposerPaste(event: ClipboardEvent<HTMLDivElement>): void {
    if (event.clipboardData.files.length === 0) {
      return;
    }
    event.preventDefault();
    void uploadPrivateFiles(Array.from(event.clipboardData.files));
  }

  function handlePrivateComposerDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setComposerDragActive(true);
  }

  function handlePrivateComposerDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setComposerDragActive(false);
  }

  function handlePrivateComposerDrop(event: DragEvent<HTMLDivElement>): void {
    if (event.dataTransfer.files.length === 0) {
      setComposerDragActive(false);
      return;
    }
    event.preventDefault();
    setComposerDragActive(false);
    void uploadPrivateFiles(Array.from(event.dataTransfer.files));
  }

  async function uploadPrivateFiles(files: readonly File[]): Promise<void> {
    const selectedFiles = Array.from(files).slice(0, Math.max(0, 10 - pendingAttachments.length));
    if (selectedFiles.length === 0 || uploadingAttachments) {
      return;
    }
    const uploadItems = selectedFiles.map((file) => {
      const previewUrl = createAttachmentPreviewUrl(file);
      if (previewUrl) {
        attachmentPreviewUrlsRef.current.add(previewUrl);
      }
      return {
        localId: createLocalComposerAssetId("attachment"),
        fileName: file.name,
        sizeBytes: file.size,
        state: "uploading" as const,
        previewUrl,
        deleteOnRemove: true,
      };
    });
    setPendingAttachments((current) => [...current, ...uploadItems]);
    setUploadingAttachments(true);
    try {
      setWorkspaceError("");
      const responses = await Promise.all(selectedFiles.map((file) => uploadTeammatePrivateAttachment(cwd.trim(), teammate.id, file)));
      const uploaded = responses.map((response) => response.attachment);
      setPrivateAttachments((current) => [...uploaded, ...current.filter((attachment) => !uploaded.some((item) => item.id === attachment.id))]);
      const uploadedByLocalId = new Map(uploadItems.map((item, index) => [item.localId, uploaded[index]]));
      setPendingAttachments((current) => current.map((item) => {
        if (!uploadedByLocalId.has(item.localId)) {
          return item;
        }
        const attachment = uploadedByLocalId.get(item.localId);
        return attachment
          ? { ...item, state: "ready", attachment }
          : { ...item, state: "failed", error: t("Upload failed") };
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingAttachments((current) => current.map((item) =>
        uploadItems.some((upload) => upload.localId === item.localId)
          ? { ...item, state: "failed", error: message }
          : item,
      ));
      setWorkspaceError(message);
    } finally {
      setUploadingAttachments(false);
    }
  }

  async function removePendingAttachment(localId: string): Promise<void> {
    const removed = pendingAttachments.find((item) => item.localId === localId);
    revokePendingAttachmentPreview(removed, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
    setPendingAttachments((current) => current.filter((item) => item.localId !== localId));
    if (!removed?.attachment || !removed.deleteOnRemove) {
      return;
    }
    try {
      await deleteAttachment(cwd.trim(), removed.attachment.id);
      setPrivateAttachments((current) => current.filter((attachment) => attachment.id !== removed?.attachment?.id));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }

  function removeComposerFileReference(raw: string, occurrenceIndex: number): void {
    setMessageDraft((current) => removeComposerInputRawToken(current, raw, occurrenceIndex));
  }

  function handlePrivateFeedScroll(_event: UIEvent<HTMLDivElement>): void {
    const feed = privateFeedRef.current;
    if (!feed) {
      return;
    }
    if (feed.scrollTop <= 80 && hasMoreDirectMessages && nextDirectBeforeMessageId && !loadingOlderDirectMessages && !normalizedMessageSearchQuery) {
      void loadOlderDirectMessages();
    }
    const maxScrollTop = feed.scrollHeight - feed.clientHeight;
    const pinnedToLatest = maxScrollTop <= 0 || maxScrollTop - feed.scrollTop <= 24;
    const latestMessage = visibleMessages.at(-1);
    const latestMessagePending = latestMessage?.authorType === "ai-teammate" && latestMessage.status === "pending";
    const preserveAutoFollow =
      !pinnedToLatest &&
      !privateFeedUserScrollIntentRef.current &&
      privateFeedPinnedToLatestRef.current &&
      (Date.now() < privateFeedAutoFollowUntilRef.current || latestMessagePending);
    if (preserveAutoFollow) {
      privateFeedPinnedToLatestRef.current = true;
      setPrivateFeedLatestButtonVisible(false);
      return;
    }
    privateFeedPinnedToLatestRef.current = pinnedToLatest;
    setPrivateFeedLatestButtonVisible((visible) => {
      const nextVisible = !pinnedToLatest && maxScrollTop > 0;
      return visible === nextVisible ? visible : nextVisible;
    });
  }

  function cancelPrivateFeedAutoFollow(): void {
    privateFeedAutoFollowUntilRef.current = 0;
    privateFeedUserScrollIntentRef.current = true;
  }

  function scrollPrivateFeedToLatest(): void {
    const feed = privateFeedRef.current;
    if (!feed) {
      return;
    }
    privateFeedAutoFollowUntilRef.current = Date.now() + 1_000;
    privateFeedUserScrollIntentRef.current = false;
    if (visibleMessages.length > 0) {
      privateMessageFeedVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: "end" });
    }
    feed.scrollTop = feed.scrollHeight;
    privateFeedPinnedToLatestRef.current = true;
    setPrivateFeedLatestButtonVisible(false);
  }

  function copyMessageText(text: string): void {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  function openAssignedTask(task: Task): void {
    if (task.currentRunId && onOpenRun) {
      onOpenRun(task.currentRunId);
      return;
    }
    if (onOpenTaskInWorkBoard) {
      onOpenTaskInWorkBoard(task);
      return;
    }
    onOpenWorkBoard?.();
  }

  async function handleTaskCreated(task: Task): Promise<void> {
    onTaskCreated?.(task);
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) return;
    const activityTeammateId = teammate.id;
    const response = await listTeammateActivity(workspaceCwd, activityTeammateId);
    if (teammateIdentityRef.current === activityTeammateId) {
      setActivityItems(response.items);
    }
  }

  function toggleMcpTool(serverId: string, toolName: string): void {
    setMcpBindings((current) => {
      const existing = current.find((binding) => binding.serverId === serverId);
      const currentTools = new Set(existing?.mode === "all_current_tools"
        ? (mcpToolsByServerId.get(serverId) ?? []).map((tool) => tool.rawName)
        : existing?.selectedToolNames ?? []);
      if (currentTools.has(toolName)) {
        currentTools.delete(toolName);
      } else {
        currentTools.add(toolName);
      }
      const nextBinding: TeammateMcpBinding | undefined = currentTools.size > 0
        ? {
          teammateId: teammate.id,
          serverId,
          mode: "selected",
          selectedToolNames: [...currentTools].sort(),
          approvalOverrides: existing?.approvalOverrides ?? {},
          enabled: true,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        : undefined;
      return [
        ...current.filter((binding) => binding.serverId !== serverId),
        ...(nextBinding ? [nextBinding] : []),
      ];
    });
  }

  function setMcpServerSelectedTools(serverId: string, toolNames: readonly string[]): void {
    const nextToolNames = [...new Set(toolNames)].sort();
    setMcpBindings((current) => {
      const existing = current.find((binding) => binding.serverId === serverId);
      const nextBinding: TeammateMcpBinding | undefined = nextToolNames.length > 0
        ? {
          teammateId: teammate.id,
          serverId,
          mode: "selected",
          selectedToolNames: nextToolNames,
          approvalOverrides: existing?.approvalOverrides ?? {},
          enabled: true,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        : undefined;
      return [
        ...current.filter((binding) => binding.serverId !== serverId),
        ...(nextBinding ? [nextBinding] : []),
      ];
    });
  }

  function toggleMcpServerExpanded(serverId: string): void {
    setExpandedMcpServerIds((current) => {
      const next = new Set(current);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return next;
    });
  }

  function updateMcpToolSearch(serverId: string, value: string): void {
    setMcpToolSearchByServerId((current) => ({ ...current, [serverId]: value }));
  }

  function updateMcpToolFilter(serverId: string, filter: McpToolFilter): void {
    setMcpToolFilterByServerId((current) => ({ ...current, [serverId]: filter }));
  }

  return (
    <div className={[
      "teammate-workspace",
      `right-dock-motion-${chatDockController.motionState}`,
      workspaceView === "settings" ? "settings-mode" : "chat-mode",
    ].filter(Boolean).join(" ")}>
      {workspaceView === "chat" ? (
        <TeammateChatHeader
          cwd={cwd}
          teammate={teammate}
          providerReady={providerReady}
          memoryScopeCount={memoryScopes.length}
          attachmentCount={directAttachments.length}
          refreshing={chatHeaderController.refreshing}
          refreshDisabled={loading || !cwd.trim()}
          searchInputRef={chatHeaderController.searchInputRef}
          searchOpen={chatHeaderController.searchOpen}
          searchQuery={messageSearchQuery}
          searchTriggerRef={chatHeaderController.searchTriggerRef}
          summaryOpen={chatSummaryOpen}
          summaryDockOffset={chatSummaryDockOffset}
          summaryDockResizing={chatDockController.resizing}
          summaryDockMotion={chatSummaryDockMotion}
          summaryDockState={chatDockController.motionState}
          summaryRows={privateSummaryRows}
          terminalOpen={chatTerminalOpen}
          terminalDisabled={!cwd.trim()}
          detailsOpen={chatDockOpen}
          onToggleSearch={() => {
            setChatSummaryOpen(false);
            chatHeaderController.toggleSearch();
          }}
          onCloseSearch={() => chatHeaderController.closeSearch(true)}
          onSearchQueryChange={setMessageSearchQuery}
          onClearSearch={chatHeaderController.clearSearch}
          onRefresh={chatHeaderController.refresh}
          onToggleSummary={() => {
            chatHeaderController.closeSearch();
            setChatSummaryOpen((current) => !current);
          }}
          onCloseSummary={() => setChatSummaryOpen(false)}
          onToggleTerminal={() => {
            setChatTerminalOpen((current) => !current);
          }}
          onToggleDetails={() => {
            setChatDockOpen((current) => !current);
          }}
        />
      ) : (
        <TeammateSettingsHeader
          title={t("{name} settings", { name: settingsForm.displayName.trim() || teammate.displayName })}
          profileActive={activeTab === "profile"}
          profileDirty={profileController.profileDirty}
          savingProfile={profileController.savingProfile}
          modelActive={activeTab === "model" && !isProtectedSystemTeammate}
          modelDirty={modelController.modelDirty}
          savingModel={modelController.savingModel}
          onBack={() => setWorkspaceView("chat")}
          onResetProfile={profileController.resetProfile}
          onSaveProfile={() => void profileController.saveProfile()}
          onResetModel={modelController.resetModel}
          onSaveModel={() => void modelController.saveModel()}
        />
      )}

      {workspaceError ? <div className="inline-error">{workspaceError}</div> : null}
      {loading ? (
        <div className="client-empty-state teammate-empty">
          <Loader2 className="spin" />
          <span>{t("Loading teammate workspace...")}</span>
        </div>
      ) : null}

      {workspaceView === "settings" ? (
        <TeammateSettingsNavigation
          activeTab={activeTab}
          label={t("Settings sections")}
          sections={settingsSections}
          onChange={setActiveTab}
        />
      ) : null}

      {workspaceView === "chat" ? (
        <TeammatePrivateChatSurface
          cwd={cwd}
          teammate={teammate}
          userProfile={userProfile}
          loading={loading}
          visibleMessages={visibleMessages}
          normalizedMessageSearchQuery={normalizedMessageSearchQuery}
          privateFeedRef={privateFeedRef}
          privateMessageFeedVirtualizer={privateMessageFeedVirtualizer}
          privateMessageFeedVirtualRows={privateMessageFeedVirtualRows}
          usedMemoryEvents={usedMemoryEvents}
          memoryById={memoryById}
          runs={runs}
          executionActions={directExecutionActions}
          terminalReports={terminalReports}
          dockViewModel={privateDockViewModel}
          providerRecovered={providerRecovered}
          privateAttachmentById={privateAttachmentById}
          taskCreateBusyKeys={tasksController.busyKeys}
          taskCreateErrors={tasksController.messageErrors}
          taskChannelOptions={tasksController.taskChannels}
          latestButtonVisible={privateFeedLatestButtonVisible}
          hasDirectRuntimeActivity={hasDirectRuntimeActivity}
          directReplyActive={directReplyActive}
          directGuidanceSubmitting={directGuidanceSubmitting}
          directGuidanceCancelingId={directGuidanceCancelingId}
          directGuidancePromotingId={directGuidancePromotingId}
          openDirectInterventions={openDirectInterventions}
          directLinkPreviewById={directLinkPreviewById}
          messageDraft={messageDraft}
          privateComposerSending={privateComposerSending}
          privateComposerSendDisabled={privateComposerSendDisabled}
          privateComposerSendLabel={privateComposerSendLabel}
          privateComposerSendingLabel={privateComposerSendingLabel}
          privateComposerHasGuidancePayload={privateComposerHasGuidancePayload}
          privateComposerPlaceholder={privateComposerPlaceholder}
          uploadingAttachments={uploadingAttachments}
          pendingAttachments={pendingAttachments}
          pendingDirectLinkPreviews={pendingDirectLinkPreviews}
          slashCommands={privateSlashCommands}
          composerInputParts={composerInputParts}
          composerFileReferenceParts={composerFileReferenceParts}
          composerFileReferenceTokens={composerFileReferenceTokens}
          composerDragActive={composerDragActive}
          onPrivateFeedScroll={handlePrivateFeedScroll}
          onCancelPrivateFeedAutoFollow={cancelPrivateFeedAutoFollow}
          onScrollToLatest={scrollPrivateFeedToLatest}
          onCopyMessageText={copyMessageText}
          onOpenRun={onOpenRun}
          onOpenFiles={(target) => openChatDockPage("files", target)}
          onOpenReview={(target) => openChatDockPage("review", undefined, target)}
          onCreateTaskFromMessage={tasksController.createFromMessage}
          onPromoteDirectGuidance={promoteDirectGuidance}
          onCancelDirectGuidance={cancelDirectGuidance}
          onEditDirectGuidance={editDirectGuidance}
          onRefreshMessages={refreshTeammateWorkspace}
          onMessageDraftChange={setMessageDraft}
          onComposerSubmit={handlePrivateComposerSubmit}
          onComposerKeyDown={handlePrivateComposerKeyDown}
          onComposerPaste={handlePrivateComposerPaste}
          onComposerDragOver={handlePrivateComposerDragOver}
          onComposerDragLeave={handlePrivateComposerDragLeave}
          onComposerDrop={handlePrivateComposerDrop}
          onUploadPrivateFiles={uploadPrivateFiles}
          onRemoveComposerFileReference={removeComposerFileReference}
          onRemovePendingLinkPreview={(previewId) => setPendingDirectLinkPreviewIds((current) => current.filter((id) => id !== previewId))}
          onRemovePendingAttachment={removePendingAttachment}
          workspaceAccessMode={selectedWorkspaceAccessMode}
          onWorkspaceAccessModeChange={setSelectedWorkspaceAccessMode}
          dockOpen={chatDockOpen}
          dockController={chatDockController}
          dockPageRequest={chatDockPageRequest}
          dockActions={(
            <button
              className="right-dock-icon-button"
              type="button"
              onClick={() => {
                setWorkspaceView("settings");
                setActiveTab("profile");
              }}
              aria-label={t("Settings")}
              title={t("Settings")}
            >
              <Settings size={15} />
            </button>
          )}
          terminalOpen={chatTerminalOpen}
          summaryOpen={chatSummaryOpen}
          onDockPageRequestConsumed={(nonce) => {
            setChatDockPageRequest((current) => current?.nonce === nonce ? undefined : current);
          }}
          onDockClose={() => setChatDockOpen(false)}
          onTerminalClose={() => setChatTerminalOpen(false)}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "tasks" ? (
        <TeammateTasksTab
          controller={tasksController}
          skills={effectiveSkills}
          onOpenChannels={() => setActiveTab("channels")}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "activity" ? (
        <TeammateActivityTab controller={activityController} onOpenRun={onOpenRun} />
      ) : null}

      {workspaceView === "settings" && activeTab === "model" ? (
        <TeammateModelTab
          modelError={modelController.modelError}
          savingModel={modelController.savingModel}
          viewModel={modelController.viewModel}
          onOpenProviders={onOpenProviders}
          onSelectProvider={modelController.selectProvider}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "permissions" ? (
        <TeammatePermissionsTab
          teammate={teammate}
          workspaceDefaultsAvailable={workspaceDefaultsAvailable}
          defaultAuthorizationMode={defaultAuthorizationMode}
          defaultWorkspaceAccessMode={defaultWorkspaceAccessMode}
          defaultPermissionMode={defaultPermissionMode}
          defaultPermissionPreset={defaultPermissionPreset}
          workspacePolicy={workspacePolicy}
          workspacePolicyLoading={workspacePolicyLoading}
          workspacePolicyError={workspacePolicyError}
          onRefreshWorkspacePolicy={onRefreshWorkspacePolicy}
          onOpenAuthorizationSettings={onOpenAuthorizationSettings}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "channels" ? (
        <TeammateChannelsTab controller={channelsController} />
      ) : null}

      {workspaceView === "settings" && activeTab === "skills" ? (
        <TeammateSkillsTab controller={skillsController} />
      ) : null}

      {workspaceView === "settings" && activeTab === "memory" ? (
        <TeammateMemoryTab
          controller={memoryController}
          isProtectedSystemTeammate={isProtectedSystemTeammate}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "profile" ? (
        <TeammateProfileTab
          avatarCropSource={profileController.avatarCropSource}
          avatarTriggerRef={profileController.avatarTriggerRef}
          cwd={cwd}
          teammate={teammate}
          settingsForm={settingsForm}
          personaImportForm={profileController.personaImportForm}
          personaDraft={profileController.personaDraft}
          profileError={profileController.profileError}
          isProtectedSystemTeammate={isProtectedSystemTeammate}
          uploadingAvatar={profileController.uploadingAvatar}
          importingPersona={profileController.importingPersona}
          onSettingsFormChange={setSettingsForm}
          onPersonaImportFormChange={profileController.setPersonaImportForm}
          onSelectAvatarFile={profileController.selectAvatarFile}
          onRemoveAvatar={profileController.removeAvatar}
          onCancelAvatarCrop={profileController.cancelAvatarCrop}
          onConfirmAvatarCrop={profileController.confirmAvatarCrop}
          onPreviewPersonaImport={profileController.previewPersonaImport}
          onApplyPersonaDraft={profileController.applyPersonaDraft}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "danger" ? (
        <TeammateDangerTab
          controller={dangerController}
          teammate={teammate}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "mcp" ? (
        <TeammateMcpTab
          mcpServers={mcpServers}
          mcpToolsByServerId={mcpToolsByServerId}
          mcpBindingByServerId={mcpBindingByServerId}
          expandedMcpServerIds={expandedMcpServerIds}
          mcpToolSearchByServerId={mcpToolSearchByServerId}
          mcpToolFilterByServerId={mcpToolFilterByServerId}
          savingMcp={mcpFeedbackController.saving}
          saveError={mcpFeedbackController.error}
          onSave={mcpFeedbackController.save}
          onSetServerSelectedTools={setMcpServerSelectedTools}
          onToggleServerExpanded={toggleMcpServerExpanded}
          onUpdateToolSearch={updateMcpToolSearch}
          onUpdateToolFilter={updateMcpToolFilter}
          onToggleTool={toggleMcpTool}
        />
      ) : null}

      {workspaceView === "settings" ? (
        <TeammateSettingsSummaryPanel
          teammate={teammate}
          modelLabel={modelController.viewModel.modelLabel}
          modelProviderLabel={modelController.viewModel.providerLabel}
          channelCount={channelsController.stats.joined}
          executableSkillCount={skillStats.executable}
          memoryReady={memoryScopes.length > 0}
          mcpBindingCount={mcpBindings.length}
        />
      ) : null}
    </div>
  );
}
