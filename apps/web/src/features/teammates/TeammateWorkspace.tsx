import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type UIEvent } from "react";
import {
  Bot,
  Brain,
  FileText,
  Folder,
  Hash,
  Loader2,
  MessageSquare,
  Settings,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
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
import {
  DesktopTitlebarSurface,
  useDesktopTitlebarPlacement,
} from "../../app/DesktopTitlebarSurface.js";
import { buildInlineApprovalViews } from "../../lib/inline-approvals.js";
import { readSseResponse } from "../../sse.js";
import { useFocusRevalidationToken } from "../../shared/hooks/use-focus-revalidation-token.js";
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
  ConversationGeneratedMedia,
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
  WorkUnit,
  WorkspaceAccessMode,
  TerminalReportDto,
} from "../../types.js";
import { resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../../lib/conversation-authorization.js";
import { useConversationSendLifecycle } from "../../shared/conversation/index.js";
import { TeammateChatHeader } from "./TeammateChatHeader.js";
import { type ConversationSummaryRow, type WorkspaceRightDockFileTarget, type WorkspaceRightDockPageRequest, type WorkspaceRightDockReviewTarget } from "../workspace/right-dock/index.js";
import { buildTeammatePrivateDockViewModel } from "./teammate-private-dock.js";
import { TeammateChannelsTab } from "./TeammateChannelsTab.js";
import { TeammateDangerTab } from "./TeammateDangerTab.js";
import { TeammateExternalToolsSection } from "./TeammateExternalToolsSection.js";
import { TeammateModelTab } from "./TeammateModelTab.js";
import { TeammatePermissionsTab } from "./TeammatePermissionsTab.js";
import { TeammateProfileTab } from "./TeammateProfileTab.js";
import { TeammatePrivateChatSurface } from "./TeammatePrivateChatSurface.js";
import { TeammateRenameDialog } from "./TeammateRenameDialog.js";
import { RuntimeApprovalComposerGate } from "../approvals/RuntimeApprovalComposerGate.js";
import type { ApprovalResolution } from "../approvals/types.js";
import { TeammateSettingsHeader } from "./TeammateSettingsHeader.js";
import { TeammateSettingsNavigation } from "./TeammateSettingsNavigation.js";
import { TeammateSkillsTab } from "./TeammateSkillsTab.js";
import { useWorkspaceRightDockController } from "../workspace/useWorkspaceRightDockController.js";
import { useConversationSummaryLayout } from "../workspace/conversation-summary-layout.js";
import { useConversationHeaderController } from "../workspace/useConversationHeaderController.js";
import { buildTeammatePrivateModelNotice, teammatePrivateMessageSearchText } from "./teammate-private-chat-view-models.js";
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
import { useTeammateRenameController } from "./useTeammateRenameController.js";
import { useTeammateModelController } from "./useTeammateModelController.js";
import { useTeammateSkillsController } from "./useTeammateSkillsController.js";
import { useTeammateTasksController } from "./useTeammateTasksController.js";
import { useTeammateMemoryController } from "./useTeammateMemoryController.js";
import { useTeammateChannelsController } from "./useTeammateChannelsController.js";
import { useTeammateDangerController } from "./useTeammateDangerController.js";
import { useTeammatePermissionsController } from "./useTeammatePermissionsController.js";
import { useTeammateExternalToolsController } from "./useTeammateExternalToolsController.js";
import type { TeammateUpdateAction } from "./types.js";
import {
  useTeammateWorkspaceRequestOwner,
  type TeammateWorkspaceRequestToken,
} from "./useTeammateWorkspaceRequestOwner.js";

type TeammateWorkspaceView = "chat" | "settings";
type TeammateWorkspaceTab = "profile" | "model" | "channels" | "skills" | "tools_permissions";

type MaybePromise<T> = T | Promise<T>;
const emptyTeammateDirectMessages: readonly TeammateDirectMessage[] = [];
const emptyConversationGeneratedMedia: readonly ConversationGeneratedMedia[] = [];

export function TeammateWorkspace({
  cwd,
  teammate,
  userProfile,
  providers,
  workspaceDefaultProviderPresetId,
  channels,
  runs,
  workUnits,
  skillPack,
  onUpdateTeammate,
  onTeammateUpdated,
  onDisableTeammate,
  onHardDeleteTeammate,
  onOpenProviders,
  onOpenSkillLibrary,
  onOpenAuthorizationSettings,
  onRefreshTeammates,
  onRefreshChannels,
  onTaskCreated,
  onOpenRun,
  onOpenTaskInWorkBoard,
  onOpenWorkBoard,
  defaultAuthorizationMode,
  defaultWorkspaceAccessMode,
  workspaceDefaultsAvailable = false,
  onDirectConversationChange,
  fullAccessConfirmed = false,
  onConfirmFullAccess,
  onConfirmFullAccessSelection,
  defaultPermissionMode,
  defaultPermissionPreset,
  workspacePolicy,
  workspacePolicyLoading = false,
  workspacePolicyError,
  onRefreshWorkspacePolicy,
  approvalErrors,
  resolvingApprovals,
  onResolveApproval,
  settingsOpenRequest,
  conversationRefreshToken = 0,
  onSettingsOpenRequestConsumed,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly userProfile?: UserProfile;
  readonly providers: readonly ProviderPreset[];
  readonly workspaceDefaultProviderPresetId?: string;
  readonly channels: readonly Channel[];
  readonly runs: readonly RunSession[];
  readonly workUnits: readonly WorkUnit[];
  readonly skillPack: SkillPack | undefined;
  readonly onUpdateTeammate: (
    teammateId: string,
    input: UpdateAiTeammateRequest,
    action?: TeammateUpdateAction,
  ) => Promise<AiTeammate>;
  readonly onTeammateUpdated?: (teammate: AiTeammate) => void;
  readonly onDisableTeammate: (teammateId: string) => Promise<void>;
  readonly onHardDeleteTeammate?: (teammateId: string, reason?: string) => Promise<void>;
  readonly onOpenProviders: () => void;
  readonly onOpenSkillLibrary?: () => void;
  readonly onOpenAuthorizationSettings?: () => void;
  readonly onRefreshTeammates?: () => MaybePromise<void>;
  readonly onRefreshChannels?: () => MaybePromise<void>;
  readonly onTaskCreated?: (task: Task) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenTaskInWorkBoard?: (task: Task) => void;
  readonly onOpenWorkBoard?: () => void;
  readonly defaultAuthorizationMode?: AuthorizationMode;
  readonly defaultWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly workspaceDefaultsAvailable?: boolean;
  readonly onDirectConversationChange?: (threadId?: string) => void;
  readonly fullAccessConfirmed?: boolean;
  readonly onConfirmFullAccess?: () => Promise<PermissionConfirmation | undefined>;
  readonly onConfirmFullAccessSelection?: () => Promise<PermissionConfirmation | undefined>;
  readonly defaultPermissionMode?: SessionPermissionMode;
  readonly defaultPermissionPreset?: PermissionPreset;
  readonly workspacePolicy?: ApprovalPolicy;
  readonly workspacePolicyLoading?: boolean;
  readonly workspacePolicyError?: string;
  readonly onRefreshWorkspacePolicy?: () => void;
  readonly approvalErrors: Readonly<Record<string, string>>;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onResolveApproval: (
    approvalId: string,
    decision: ApprovalResolution,
    reason?: string,
    proposedRuleFingerprint?: string,
  ) => MaybePromise<void>;
  readonly settingsOpenRequest?: {
    readonly teammateId: string;
    readonly requestId: number;
  };
  readonly conversationRefreshToken?: number;
  readonly onSettingsOpenRequestConsumed?: (requestId: number) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const titlebarPlacement = useDesktopTitlebarPlacement();
  const focusRevalidationToken = useFocusRevalidationToken();
  const [workspaceView, setWorkspaceView] = useState<TeammateWorkspaceView>("chat");
  const [activeTab, setActiveTab] = useState<TeammateWorkspaceTab>("profile");
  const [messages, setMessages] = useState<readonly TeammateDirectMessage[]>([]);
  const [generatedMedia, setGeneratedMedia] = useState<readonly ConversationGeneratedMedia[]>([]);
  const workspaceMessageIdentity = JSON.stringify([cwd.trim(), teammate.id]);
  const [messageSnapshotIdentity, setMessageSnapshotIdentity] = useState(workspaceMessageIdentity);
  const [selectedAuthorizationMode, setSelectedAuthorizationMode] = useState<AuthorizationMode>(() => resolveAuthorizationMode(
    defaultAuthorizationMode,
    defaultPermissionMode,
    defaultPermissionPreset,
  ));
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
  const workspaceSnapshotCurrent = messageSnapshotIdentity === workspaceMessageIdentity;
  const currentMessages = workspaceSnapshotCurrent ? messages : emptyTeammateDirectMessages;
  const currentGeneratedMedia = workspaceSnapshotCurrent ? generatedMedia : emptyConversationGeneratedMedia;
  const currentDirectRuntime = workspaceSnapshotCurrent ? directRuntime : undefined;
  const currentDirectWorkspace = workspaceSnapshotCurrent ? directWorkspace : undefined;

  useEffect(() => {
    onDirectConversationChange?.(workspaceView === "chat" ? currentDirectWorkspace?.threadId : undefined);
  }, [currentDirectWorkspace?.threadId, onDirectConversationChange, workspaceSnapshotCurrent, workspaceView]);

  useEffect(() => () => onDirectConversationChange?.(undefined), [onDirectConversationChange]);
  const directSendLifecycle = useConversationSendLifecycle(`teammate:${cwd.trim()}:${teammate.id}`);
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
  const workspaceRequestOwner = useTeammateWorkspaceRequestOwner(cwd, teammate.id);
  const workspaceError = workspaceRequestOwner.latestError?.message ?? "";
  const chatHeaderController = useConversationHeaderController({
    identityKey: teammate.id,
    onSearchChange: setMessageSearchQuery,
  });
  const privateFeedRef = useRef<HTMLDivElement | null>(null);
  const privateFeedPinnedToLatestRef = useRef(true);
  const privateFeedAutoFollowUntilRef = useRef(0);
  const privateFeedUserScrollIntentRef = useRef(false);
  const directGuidanceOperationSeqRef = useRef(0);
  const attachmentPreviewUrlsRef = useRef(new Set<string>());
  const effectivePrivateProviderPresetId = teammate.modelBindingMode === "workspace_default"
    ? workspaceDefaultProviderPresetId
    : teammate.providerPresetId;
  const provider = effectivePrivateProviderPresetId
    ? providers.find((item) => item.id === effectivePrivateProviderPresetId)
    : undefined;
  const privateModelNotice = buildTeammatePrivateModelNotice({
    bindingMode: teammate.modelBindingMode,
    effectiveProviderId: effectivePrivateProviderPresetId ?? "",
    provider,
    t,
  });
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
  const renameController = useTeammateRenameController({
    teammate,
    onUpdateTeammate,
    onTeammateUpdated,
  });
  const modelController = useTeammateModelController({
    teammate,
    providers,
    settingsForm,
    setSettingsForm,
    isProtectedSystemTeammate,
    workspaceDefaultProviderPresetId,
    onUpdateTeammate,
    onTeammateUpdated,
    onRefreshDirectRuntime: async () => {
      await refreshDirectRuntime();
    },
  });
  const permissionsController = useTeammatePermissionsController({
    teammate,
    onUpdateTeammate,
    onTeammateUpdated,
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
  const effectiveSkills = skillsController.effectiveSkills;
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
    deferTrailingAtomicTokens: true,
    attachments: readyAttachmentIds.map((attachmentId) => ({ attachmentId })),
    skills: effectiveSkills.map((skill) => ({ id: skill.skillId, label: skill.skill.name })),
    slashCommands: privateSlashCommands,
  });
  const composerSubmissionInputParts = useMemo(() => parseComposerInputParts(messageDraft, {
    cwd: cwd.trim(),
    attachments: readyAttachmentIds.map((attachmentId) => ({ attachmentId })),
    skills: effectiveSkills.map((skill) => ({ id: skill.skillId, label: skill.skill.name })),
    slashCommands: privateSlashCommands,
  }), [cwd, effectiveSkills, messageDraft, privateSlashCommands, readyAttachmentIds]);
  const composerFileReferenceParts = composerWorkspaceFileParts(composerSubmissionInputParts);
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
    onOpenTask: openAssignedTask,
    onTaskCreated: handleTaskCreated,
  });
  const mcpToolsByServerId = useMemo(() => {
    const grouped = new Map<string, McpTool[]>();
    for (const tool of mcpTools) {
      grouped.set(tool.serverId, [...(grouped.get(tool.serverId) ?? []), tool]);
    }
    return grouped;
  }, [mcpTools]);
  const externalToolsController = useTeammateExternalToolsController({
    authoritativeBindings: mcpBindings,
    cwd,
    onBindingsReplaced: setMcpBindings,
    teammateId: teammate.id,
    toolsByServerId: mcpToolsByServerId,
  });
  const settingsSections = [
    { id: "profile" as const, label: t("Profile"), icon: UserRound },
    { id: "model" as const, label: t("Model"), icon: Bot },
    { id: "channels" as const, label: t("Channels"), count: channelsController.stats.joined, icon: Hash },
    ...(isProtectedSystemTeammate ? [] : [
      { id: "skills" as const, label: t("Skills"), icon: Sparkles },
      { id: "tools_permissions" as const, label: t("Tools and permissions"), icon: Wrench },
    ]),
  ] satisfies readonly {
    readonly id: TeammateWorkspaceTab;
    readonly label: string;
    readonly count?: number;
    readonly icon: typeof UserRound;
  }[];
  const normalizedMessageSearchQuery = messageSearchQuery.trim().toLowerCase();
  const visibleMessages = useMemo(() => {
    if (!normalizedMessageSearchQuery) {
      return currentMessages;
    }
    return currentMessages.filter((message) => teammatePrivateMessageSearchText({
      message,
      attachmentById: privateAttachmentById,
      linkPreviewById: directLinkPreviewById,
      runById,
    }).includes(normalizedMessageSearchQuery));
  }, [currentMessages, directLinkPreviewById, normalizedMessageSearchQuery, privateAttachmentById, runById]);
  const directReplyActive = Boolean(currentDirectRuntime?.activeReply || directSendLifecycle.activeReplies.length > 0);
  const hasDirectRuntimeActivity = Boolean(currentDirectRuntime?.activeReply || directSendLifecycle.activeReplies.length > 0 || (currentDirectRuntime?.interventions.length ?? 0) > 0);

  useEffect(() => {
    const request = workspaceRequestOwner.beginWorkspaceAction("terminal-reports");
    if (!workspaceRequestOwner.isActionCurrent(request)) return undefined;
    const workspaceCwd = cwd.trim();
    const runThreadIdById = new Map(runs.map((run) => [run.id, run.threadId]));
    const threadIds = [...new Set(visibleMessages.flatMap((message) => [
      message.threadId,
      message.linkedRunId ? runThreadIdById.get(message.linkedRunId) : undefined,
    ]).filter((threadId): threadId is string => Boolean(threadId)))];
    if (!workspaceCwd || threadIds.length === 0) {
      workspaceRequestOwner.commit(request, "terminal-reports", () => setTerminalReports([]));
      return undefined;
    }
    void Promise.all(threadIds.map((threadId) => listTerminalReports(workspaceCwd, { threadId, limit: 100 })))
      .then((responses) => {
        workspaceRequestOwner.commit(request, "terminal-reports", () => {
          setTerminalReports(responses.flatMap((response) => response.reports));
        });
      })
      .catch(() => {
        workspaceRequestOwner.commit(request, "terminal-reports", () => setTerminalReports([]));
      });
    return undefined;
  }, [cwd, runs, teammate.id, visibleMessages]);

  const visibleDirectRunIds = useMemo(() => {
    const teammateRunIds = new Set(runs.filter((run) => !run.teammateId || run.teammateId === teammate.id).map((run) => run.id));
    return [...new Set(visibleMessages
      .map((message) => message.linkedRunId)
      .filter((runId): runId is string => Boolean(runId && teammateRunIds.has(runId))))];
  }, [runs, teammate.id, visibleMessages]);
  const visibleDirectRunKey = visibleDirectRunIds.join("|");
  const directApprovalViews = useMemo(
    () => currentDirectRuntime ? buildInlineApprovalViews(currentDirectRuntime.approvals, {
      owner: {
        kind: "teammate_direct",
        teammateId: teammate.id,
        threadId: currentDirectRuntime.thread.id,
      },
      runs,
      teammateDirectMessages: currentMessages,
      workUnits,
    }) : [],
    [currentDirectRuntime, currentMessages, runs, teammate.id, workUnits],
  );
  const hasActiveVisibleDirectRun = useMemo(() => {
    const visibleRunIds = new Set(visibleDirectRunIds);
    return runs.some((run) => visibleRunIds.has(run.id) && (
      run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval"
    ));
  }, [runs, visibleDirectRunKey]);

  useEffect(() => {
    const emptyRequest = workspaceRequestOwner.beginWorkspaceAction("execution-actions");
    if (!workspaceRequestOwner.isActionCurrent(emptyRequest)) return undefined;
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || visibleDirectRunIds.length === 0) {
      workspaceRequestOwner.commit(emptyRequest, "execution-actions", () => setDirectExecutionActions([]));
      return undefined;
    }
    let cancelled = false;
    let loading = false;
    const refresh = async (): Promise<void> => {
      if (loading) {
        return;
      }
      loading = true;
      const request = workspaceRequestOwner.beginWorkspaceAction("execution-actions");
      if (!workspaceRequestOwner.isActionCurrent(request)) {
        loading = false;
        return;
      }
      try {
        const responses = await Promise.all(visibleDirectRunIds.map((runId) =>
          listExecutionActions(workspaceCwd, { runId, limit: 100 }),
        ));
        if (!cancelled) workspaceRequestOwner.commit(request, "execution-actions", () => {
          const byId = new Map(responses.flatMap((response) => response.actions).map((action) => [action.id, action]));
          setDirectExecutionActions([...byId.values()]);
        });
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
  }, [cwd, directReplyActive, hasActiveVisibleDirectRun, hasDirectRuntimeActivity, teammate.id, visibleDirectRunKey]);

  useEffect(() => {
    if (isProtectedSystemTeammate && (activeTab === "skills" || activeTab === "tools_permissions")) {
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
  const directAttachments = useMemo(
    () => privateAttachments.filter((attachment) => attachment.scope === "teammate_direct_thread"),
    [privateAttachments],
  );
  const privateDockViewModel = useMemo(
    () => buildTeammatePrivateDockViewModel({
      teammate,
      messages: currentMessages,
      attachments: directAttachments,
      runs,
      executionActions: directExecutionActions,
      terminalReports,
      directWorkspace: currentDirectWorkspace,
      usedMemoryEvents,
      memoryById,
      activityItems,
      refreshing: loading,
      t,
    }),
    [
      activityItems,
      loading,
      directAttachments,
      directExecutionActions,
      currentDirectWorkspace,
      memoryById,
      currentMessages,
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
      secondary: `${directWorkspacePathLabel(currentDirectWorkspace, t)} · ${directWorkspaceStatusLabel(currentDirectWorkspace, t)}`,
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
      secondary: memoryScopes.length > 0 ? t("Memory on") : t("Memory preparing"),
      onOpen: () => openChatDockPage("context"),
    },
  ], [
    currentDirectWorkspace,
    privateDockViewModel,
    memoryScopes.length,
    t,
    teammate.displayName,
    teammate.roleKey,
  ]);
  const chatDockController = useWorkspaceRightDockController({
    initialOpen: false,
    intentOpen: chatDockOpen,
    resizeObserverKey: `${teammate.id}:${cwd.trim()}`,
  });
  const chatSummaryLayout = useConversationSummaryLayout({
    requestedOpen: chatSummaryOpen,
    containerWidth: chatDockController.containerWidth,
    dockVisible: chatDockController.visible,
    dockWidth: chatDockController.width,
  });
  const chatSummaryDockOffset = chatSummaryLayout.dockOffset;
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

  function openTeammateSettings(section: "profile" | "model"): void {
    chatHeaderController.closeSearch();
    setChatSummaryOpen(false);
    setChatDockOpen(false);
    setWorkspaceView("settings");
    setActiveTab(section);
  }

  const pendingDirectLinkPreviews = useMemo(
    () => pendingDirectLinkPreviewIds.map((id) => directLinkPreviewById.get(id)).filter((preview): preview is TeammateDirectLinkPreview => Boolean(preview)),
    [directLinkPreviewById, pendingDirectLinkPreviewIds],
  );
  const providerReady = privateModelNotice === undefined;
  const providerRecovered = providerReady && Boolean(provider);
  const openDirectInterventions = currentDirectRuntime?.interventions ?? [];
  const hasQueuedDirectGuidance = openDirectInterventions.some((intervention) => intervention.status === "queued");
  const privateComposerPayload = useMemo(() => {
    const serializedInput = serializeComposerInputParts(composerSubmissionInputParts);
    const fileRefs = directComposerFileRefs(composerFileReferenceParts);
    return {
      body: serializedInput.body.trim(),
      attachmentIds: [...serializedInput.attachmentIds],
      linkPreviewIds: [...pendingDirectLinkPreviewIds],
      fileRefs,
    };
  }, [composerFileReferenceParts, composerSubmissionInputParts, pendingDirectLinkPreviewIds]);
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
  useEffect(() => {
    setSelectedAuthorizationMode(resolveAuthorizationMode(
      defaultAuthorizationMode,
      defaultPermissionMode,
      defaultPermissionPreset,
    ));
    setSelectedWorkspaceAccessMode(resolveWorkspaceAccessMode(
      defaultWorkspaceAccessMode,
      defaultPermissionMode,
      defaultPermissionPreset,
    ));
  }, [defaultAuthorizationMode, defaultPermissionMode, defaultPermissionPreset, defaultWorkspaceAccessMode, teammate.id]);

  useEffect(() => {
    setSettingsForm(teammateToSettingsForm(teammate));
  }, [teammate]);

  useEffect(() => {
    setWorkspaceView("chat");
    setActiveTab("profile");
    setMessageSearchQuery("");
    setChatDockOpen(false);
    setChatDockPageRequest(undefined);
    setChatSummaryOpen(false);
    setChatTerminalOpen(false);
    setMessages([]);
    setGeneratedMedia([]);
    setMessageSnapshotIdentity(workspaceMessageIdentity);
    setHasMoreDirectMessages(false);
    setNextDirectBeforeMessageId(undefined);
    setLoading(false);
    setLoadingOlderDirectMessages(false);
    setSending(false);
    setUploadingAttachments(false);
    revokePendingAttachmentPreviews(pendingAttachments, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
    setPendingAttachments([]);
    setPendingDirectLinkPreviewIds([]);
    setDirectLinkPreviews([]);
    setPrivateAttachments([]);
    setMcpServers([]);
    setMcpTools([]);
    setMcpBindings([]);
    setActivityItems([]);
    setTerminalReports([]);
    setDirectExecutionActions([]);
    setDirectWorkspace(undefined);
    setDirectRuntime(undefined);
    setDirectGuidanceSubmitting("");
    setDirectGuidanceCancelingId("");
    setDirectGuidancePromotingId("");
    privateFeedPinnedToLatestRef.current = true;
    privateFeedUserScrollIntentRef.current = false;
    setPrivateFeedLatestButtonVisible(false);
  }, [workspaceMessageIdentity]);

  useEffect(() => {
    if (!settingsOpenRequest || settingsOpenRequest.teammateId !== teammate.id) return;
    setWorkspaceView("settings");
    setActiveTab("profile");
    onSettingsOpenRequestConsumed?.(settingsOpenRequest.requestId);
  }, [settingsOpenRequest?.requestId, settingsOpenRequest?.teammateId, teammate.id]);

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
    if (focusRevalidationToken === 0) return;
    void refreshTeammateWorkspace(false);
    if (workspaceView === "settings" && activeTab === "channels") void channelsController.refresh("refresh");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRevalidationToken]);

  useEffect(() => {
    if (conversationRefreshToken === 0 || workspaceView !== "chat") return;
    void refreshTeammateConversationSnapshot();
    // The refresh function is intentionally owned by the current cwd/teammate request fence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationRefreshToken]);

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
  }, [latestVisiblePrivateMessageId, latestVisiblePrivateMessageSignature, loading, workspaceView]);

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
    const request = workspaceRequestOwner.beginWorkspaceAction("workspace");
    if (!workspaceRequestOwner.isActionCurrent(request)) return;
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      workspaceRequestOwner.reportError(request, t("Workspace path is required."));
      if (workspaceRequestOwner.isActionCurrent(request)) setLoading(false);
      return;
    }
    const skillSnapshotRequestId = skillsController.beginSnapshotRequest(request.teammateId);
    if (showLoading && workspaceRequestOwner.isActionCurrent(request)) setLoading(true);
    try {
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
        listTeammateDirectMessages(workspaceCwd, request.teammateId),
        getTeammateDirectRuntime(workspaceCwd, request.teammateId),
        getTeammateDirectWorkspace(workspaceCwd, request.teammateId),
        listTeammateDirectLinkPreviews(workspaceCwd, request.teammateId),
        listTeammatePrivateAttachments(workspaceCwd, request.teammateId),
        listSkills(workspaceCwd),
        getSkillSourceHealth(workspaceCwd, { limit: 100 }),
        listTeammateSkills(workspaceCwd, request.teammateId),
        listMcpServers(workspaceCwd),
        listMcpTools(workspaceCwd),
        listTeammateMcpBindings(workspaceCwd, request.teammateId),
        listTeammateActivity(workspaceCwd, request.teammateId),
      ]);
      workspaceRequestOwner.commit(request, "conversation", () => {
        setMessages(directResponse.messages);
        setGeneratedMedia(directResponse.generatedMedia);
        setMessageSnapshotIdentity(JSON.stringify([workspaceCwd, request.teammateId]));
        setHasMoreDirectMessages(Boolean(directResponse.hasMore));
        setNextDirectBeforeMessageId(directResponse.nextBeforeMessageId);
        setDirectRuntime(directRuntimeResponse);
        setDirectWorkspace(directWorkspaceResponse);
        setDirectLinkPreviews(directLinkPreviewsResponse.linkPreviews);
        setPrivateAttachments(privateAttachmentsResponse.attachments);
      });
      workspaceRequestOwner.commit(request, "skills", () => {
        skillsController.applySnapshot(request.teammateId, skillSnapshotRequestId, {
          registryEntries: skillRegistryResponse.skills,
          sourceSnapshots: skillSourceHealthResponse.snapshots,
          bindings: skillResponse.bindings,
          effectiveSkills: skillResponse.effectiveSkills ?? [],
        });
      });
      workspaceRequestOwner.commit(request, "mcp", () => {
        setMcpServers(mcpServersResponse.servers);
        setMcpTools(mcpToolsResponse.tools);
        setMcpBindings(mcpBindingsResponse.bindings);
      });
      workspaceRequestOwner.commit(request, "activity", () => setActivityItems(activityResponse.items));
      workspaceRequestOwner.clearError(request);
    } catch (error) {
      workspaceRequestOwner.reportError(request, error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestOwner.isActionCurrent(request)) setLoading(false);
    }
  }

  async function refreshTeammateConversationSnapshot(): Promise<void> {
    const request = workspaceRequestOwner.beginWorkspaceAction("messages");
    if (!workspaceRequestOwner.isActionCurrent(request)) return;
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) return;
    try {
      const response = await listTeammateDirectMessages(workspaceCwd, request.teammateId);
      workspaceRequestOwner.commit(request, "conversation", () => {
        setMessages((current) => current.length > response.messages.length
          ? upsertDirectMessages(current, response.messages)
          : response.messages);
        setGeneratedMedia((current) => mergeConversationGeneratedMedia(current, response.generatedMedia));
        setMessageSnapshotIdentity(JSON.stringify([workspaceCwd, request.teammateId]));
      });
      workspaceRequestOwner.clearError(request);
    } catch (error) {
      workspaceRequestOwner.reportError(request, error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshDirectRuntime(): Promise<"committed" | "stale"> {
    const request = workspaceRequestOwner.beginWorkspaceAction("runtime");
    if (!workspaceRequestOwner.isActionCurrent(request)) return "stale";
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      return "stale";
    }
    try {
      const [directResponse, runtimeResponse, directWorkspaceResponse, linkPreviewsResponse, privateAttachmentsResponse] = await Promise.all([
        listTeammateDirectMessages(workspaceCwd, request.teammateId),
        getTeammateDirectRuntime(workspaceCwd, request.teammateId),
        getTeammateDirectWorkspace(workspaceCwd, request.teammateId),
        listTeammateDirectLinkPreviews(workspaceCwd, request.teammateId),
        listTeammatePrivateAttachments(workspaceCwd, request.teammateId),
      ]);
      const committed = workspaceRequestOwner.commit(request, "conversation", () => {
        setMessages((current) => current.length > directResponse.messages.length
          ? upsertDirectMessages(current, directResponse.messages)
          : directResponse.messages);
        setGeneratedMedia(directResponse.generatedMedia);
        setMessageSnapshotIdentity(JSON.stringify([workspaceCwd, request.teammateId]));
        setHasMoreDirectMessages(Boolean(directResponse.hasMore));
        setNextDirectBeforeMessageId(directResponse.nextBeforeMessageId);
        setDirectRuntime(runtimeResponse);
        setDirectWorkspace(directWorkspaceResponse);
        setDirectLinkPreviews(linkPreviewsResponse.linkPreviews);
        setPrivateAttachments(privateAttachmentsResponse.attachments);
      });
      if (workspaceRequestOwner.isActionCurrent(request)) workspaceRequestOwner.clearError(request);
      return committed ? "committed" : "stale";
    } catch (error) {
      if (workspaceRequestOwner.isActionCurrent(request)) throw error;
      return "stale";
    }
  }

  async function refreshTeammateActivity(): Promise<void> {
    const request = workspaceRequestOwner.beginWorkspaceAction("activity");
    if (!workspaceRequestOwner.isActionCurrent(request)) return;
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) return;
    try {
      const response = await listTeammateActivity(workspaceCwd, request.teammateId);
      workspaceRequestOwner.commit(request, "activity", () => setActivityItems(response.items));
      workspaceRequestOwner.clearError(request);
    } catch (error) {
      if (workspaceRequestOwner.isActionCurrent(request)) {
        workspaceRequestOwner.reportError(request, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
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
    const request = workspaceRequestOwner.beginWorkspaceAction("older-messages");
    if (!workspaceRequestOwner.isActionCurrent(request)) return;
    const beforeMessageId = nextDirectBeforeMessageId;
    const feed = privateFeedRef.current;
    const previousScrollHeight = feed?.scrollHeight ?? 0;
    const previousScrollTop = feed?.scrollTop ?? 0;
    setLoadingOlderDirectMessages(true);
    privateFeedPinnedToLatestRef.current = false;
    try {
      const response = await listTeammateDirectMessages(workspaceCwd, request.teammateId, {
        beforeMessageId,
      });
      workspaceRequestOwner.commit(request, "conversation", () => {
        setMessages((current) => upsertDirectMessages(current, response.messages));
        setGeneratedMedia((current) => mergeConversationGeneratedMedia(current, response.generatedMedia));
        setHasMoreDirectMessages(Boolean(response.hasMore));
        setNextDirectBeforeMessageId(response.nextBeforeMessageId);
        globalThis.requestAnimationFrame(() => {
          globalThis.requestAnimationFrame(() => {
            if (!workspaceRequestOwner.ownsResource(request, "conversation")) return;
            const nextFeed = privateFeedRef.current;
            if (!nextFeed) return;
            nextFeed.scrollTop = nextFeed.scrollHeight - previousScrollHeight + previousScrollTop;
          });
        });
      });
      workspaceRequestOwner.clearError(request);
    } catch (error) {
      workspaceRequestOwner.reportError(request, error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestOwner.isActionCurrent(request)) setLoadingOlderDirectMessages(false);
    }
  }

  async function resolveActiveDirectReply(operation: TeammateWorkspaceRequestToken) {
    if (!workspaceRequestOwner.isActionCurrent(operation)) return { status: "stale" as const };
    if (currentDirectRuntime?.activeReply) {
      return { status: "current" as const, activeReply: currentDirectRuntime.activeReply };
    }
    const transientReply = directSendLifecycle.activeReplies[0];
    if (transientReply?.workUnitId) {
      return { status: "current" as const, activeReply: { workUnitId: transientReply.workUnitId } };
    }
    try {
      const runtimeResponse = await getTeammateDirectRuntime(cwd.trim(), operation.teammateId);
      if (!workspaceRequestOwner.isActionCurrent(operation)) return { status: "stale" as const };
      workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
        setDirectRuntime(runtimeResponse);
      });
      return { status: "current" as const, activeReply: runtimeResponse.activeReply };
    } catch (error) {
      if (workspaceRequestOwner.isActionCurrent(operation)) throw error;
      return { status: "stale" as const };
    }
  }

  async function ensureDirectLinkPreviewsForBody(
    body: string,
    operation: TeammateWorkspaceRequestToken,
  ): Promise<readonly TeammateDirectLinkPreview[] | undefined> {
    if (!workspaceRequestOwner.isActionCurrent(operation)) return undefined;
    const existing = [...pendingDirectLinkPreviews];
    const created: TeammateDirectLinkPreview[] = [];
    for (const url of extractUrls(body)) {
      if (existing.some((preview) => preview.url === url || preview.normalizedUrl === url) || created.some((preview) => preview.url === url || preview.normalizedUrl === url)) {
        continue;
      }
      const response = await createTeammateDirectLinkPreview(cwd.trim(), operation.teammateId, { url });
      if (!workspaceRequestOwner.isActionCurrent(operation)) return undefined;
      created.push(response.linkPreview);
      workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
        setDirectLinkPreviews((current) => [
          response.linkPreview,
          ...current.filter((preview) => preview.id !== response.linkPreview.id),
        ]);
      });
    }
    return uniqueDirectLinkPreviews([...existing, ...created]);
  }

  async function sendPrivateMessage(authorization: {
    readonly authorizationMode: AuthorizationMode;
    readonly permissionPreset: PermissionPreset;
    readonly permissionConfirmation?: PermissionConfirmation;
  }): Promise<void> {
    const serializedInput = serializeComposerInputParts(composerSubmissionInputParts);
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
    const operation = workspaceRequestOwner.beginWorkspaceAction("send");
    if (!workspaceRequestOwner.isActionCurrent(operation)) return;
    const draftSnapshot = messageDraft;
    const attachmentsSnapshot = pendingAttachments;
    const linkPreviewIdsSnapshot = pendingDirectLinkPreviewIds;
    const sendOperation = directSendLifecycle.begin();
    setSending(true);
    let streamFailed = false;
    try {
      const linkPreviews = await ensureDirectLinkPreviewsForBody(body, operation);
      if (!linkPreviews || !workspaceRequestOwner.isActionCurrent(operation)) return;
      setMessageDraft("");
      setPendingAttachments([]);
      setPendingDirectLinkPreviewIds([]);
      privateFeedPinnedToLatestRef.current = true;
      privateFeedAutoFollowUntilRef.current = Date.now() + 3_000;
      privateFeedUserScrollIntentRef.current = false;
      setPrivateFeedLatestButtonVisible(false);
      const response = await streamTeammateDirectMessage(cwd.trim(), operation.teammateId, {
        body,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs,
        providerPresetId: teammate.providerPresetId,
        authorizationMode: authorization.authorizationMode,
        workspaceAccessMode: selectedWorkspaceAccessMode,
        permissionPreset: authorization.permissionPreset,
        permissionConfirmation,
      });
      await readSseResponse(response, (event) => {
        if (!workspaceRequestOwner.isActionCurrent(operation)) return;
        if (event.event === "ready") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamReadyEvent;
          workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
            setMessages((current) => upsertDirectMessages(current, [data.message, data.aiReply]));
            directSendLifecycle.accept(sendOperation);
          });
          return;
        }
        if (event.event === "delta") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamDeltaEvent;
          workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
            setMessages((current) => current.map((message) => message.id === data.messageId ? {
              ...message,
              body: data.body,
              narrationSegments: data.narrationSegments ?? message.narrationSegments,
              status: "pending",
            } : message));
          });
          return;
        }
        if (event.event === "run_linked") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamRunLinkedEvent;
          workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
            setMessages((current) => current.map((message) => message.id === data.messageId ? {
              ...message,
              linkedRunId: data.linkedRunId ?? message.linkedRunId,
            } : message));
            if (data.activeReply) {
              directSendLifecycle.accept(sendOperation);
              directSendLifecycle.link(sendOperation, data.activeReply);
              setSending(false);
            }
          });
          void refreshDirectRuntime();
          return;
        }
        if (event.event === "done") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamDoneEvent;
          workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
            setMessages((current) => upsertDirectMessages(current, [data.message, data.aiReply]));
            directSendLifecycle.settle(sendOperation);
            setSending(false);
          });
          return;
        }
        if (event.event === "blocked") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamBlockedEvent;
          workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
            setMessages((current) => upsertDirectMessages(current, [data.message, data.aiReply]));
            directSendLifecycle.settle(sendOperation);
            setSending(false);
          });
          return;
        }
        if (event.event === "error") {
          streamFailed = true;
          directSendLifecycle.fail(sendOperation);
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamErrorEvent;
          const nextMessages = [data.message, data.aiReply].filter((message): message is TeammateDirectMessage => Boolean(message));
          workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
            if (nextMessages.length > 0) {
              setMessages((current) => upsertDirectMessages(current, nextMessages));
            }
            setSending(false);
          });
          if (data.error) workspaceRequestOwner.reportError(operation, data.error);
        }
      });
      if (!workspaceRequestOwner.isActionCurrent(operation)) return;
      await Promise.all([
        refreshTeammateActivity(),
        memoryController.refresh("background"),
      ]);
      if (!workspaceRequestOwner.isActionCurrent(operation)) return;
      revokePendingAttachmentPreviews(attachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      await refreshDirectRuntime();
      if (workspaceRequestOwner.isActionCurrent(operation) && !streamFailed) {
        workspaceRequestOwner.clearError(operation);
      }
    } catch (error) {
      if (!workspaceRequestOwner.isActionCurrent(operation)) return;
      const failure = directSendLifecycle.fail(sendOperation);
      if (failure.restoreInput) {
        setMessageDraft(draftSnapshot);
        setPendingAttachments(attachmentsSnapshot);
        setPendingDirectLinkPreviewIds(linkPreviewIdsSnapshot);
      }
      workspaceRequestOwner.reportError(operation, error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestOwner.isActionCurrent(operation)) setSending(false);
    }
  }

  async function stopDirectReply(): Promise<void> {
    if (directGuidanceSubmitting) {
      return;
    }
    const operation = workspaceRequestOwner.beginWorkspaceAction("guidance");
    if (!workspaceRequestOwner.isActionCurrent(operation)) return;
    setDirectGuidanceSubmitting("stop");
    try {
      const resolution = await resolveActiveDirectReply(operation);
      if (resolution.status === "stale") return;
      const activeReply = resolution.activeReply;
      if (!activeReply) {
        workspaceRequestOwner.reportError(operation, t("There is no active private reply right now."));
        return;
      }
      const response = await cancelTeammateDirectReply(cwd.trim(), activeReply.workUnitId, { reason: "user_requested" });
      if (!workspaceRequestOwner.isActionCurrent(operation)) return;
      workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
        if (response.message) {
          setMessages((current) => upsertDirectMessages(current, [response.message!]));
        }
      });
      await refreshDirectRuntime();
      workspaceRequestOwner.clearError(operation);
    } catch (error) {
      workspaceRequestOwner.reportError(operation, error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestOwner.isActionCurrent(operation)) setDirectGuidanceSubmitting("");
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
    const operation = workspaceRequestOwner.beginWorkspaceAction("guidance");
    if (!workspaceRequestOwner.isActionCurrent(operation)) return false;
    setDirectGuidanceSubmitting(mode);
    try {
      const resolution = await resolveActiveDirectReply(operation);
      if (resolution.status === "stale") return false;
      const activeReply = resolution.activeReply;
      if (!activeReply) {
        workspaceRequestOwner.reportError(operation, t("There is no active private reply right now."));
        return false;
      }
      const linkPreviews = await ensureDirectLinkPreviewsForBody(payload.body, operation);
      if (!linkPreviews || !workspaceRequestOwner.isActionCurrent(operation)) return false;
      const completePayload = {
        ...payload,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
      };
      const instruction = summarizeDirectGuidancePayload(completePayload, t);
      const operationId = directGuidanceOperationSeqRef.current + 1;
      directGuidanceOperationSeqRef.current = operationId;
      const response = await createTeammateDirectIntervention(cwd.trim(), operation.teammateId, {
        mode,
        instruction,
        messagePayload: completePayload,
        idempotencyKey: `direct-guidance:${activeReply.workUnitId}:${mode}:${operationId}:${instruction}`,
      });
      if (!workspaceRequestOwner.isActionCurrent(operation)) return false;
      workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
        setDirectRuntime(response.runtime);
        setMessageDraft("");
        setPendingAttachments([]);
        setPendingDirectLinkPreviewIds([]);
      });
      revokePendingAttachmentPreviews(attachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      await refreshDirectRuntime();
      workspaceRequestOwner.clearError(operation);
      return true;
    } catch (error) {
      if (!workspaceRequestOwner.isActionCurrent(operation)) return false;
      setMessageDraft(draftSnapshot);
      setPendingAttachments(attachmentsSnapshot);
      setPendingDirectLinkPreviewIds(linkPreviewIdsSnapshot);
      workspaceRequestOwner.reportError(operation, error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (workspaceRequestOwner.isActionCurrent(operation)) setDirectGuidanceSubmitting("");
    }
  }

  async function cancelDirectGuidance(interventionId: string): Promise<void> {
    if (directGuidanceCancelingId) {
      return;
    }
    const operation = workspaceRequestOwner.beginWorkspaceAction("guidance-cancel");
    if (!workspaceRequestOwner.isActionCurrent(operation)) return;
    setDirectGuidanceCancelingId(interventionId);
    try {
      await cancelTeammateDirectIntervention(cwd.trim(), interventionId, { reason: "cancelled_by_user" });
      if (!workspaceRequestOwner.isActionCurrent(operation)) return;
      await refreshDirectRuntime();
      workspaceRequestOwner.clearError(operation);
    } catch (error) {
      workspaceRequestOwner.reportError(operation, error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestOwner.isActionCurrent(operation)) setDirectGuidanceCancelingId("");
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
    const operation = workspaceRequestOwner.beginWorkspaceAction("guidance-promote");
    if (!workspaceRequestOwner.isActionCurrent(operation)) return;
    setDirectGuidancePromotingId(interventionId);
    try {
      const response = await promoteTeammateDirectIntervention(cwd.trim(), interventionId, { reason: "user_requested" });
      if (!workspaceRequestOwner.isActionCurrent(operation)) return;
      workspaceRequestOwner.claimAndCommit(operation, ["conversation"], () => {
        setDirectRuntime(response.runtime);
      });
      if (response.message) {
        workspaceRequestOwner.reportError(operation, response.message);
      }
      await refreshDirectRuntime();
      if (!workspaceRequestOwner.isActionCurrent(operation)) return;
      const request = workspaceRequestOwner.beginWorkspaceAction("messages");
      if (workspaceRequestOwner.isActionCurrent(request)) {
        try {
          const directMessagesResponse = await listTeammateDirectMessages(cwd.trim(), request.teammateId);
          workspaceRequestOwner.commit(request, "conversation", () => {
            setMessages(directMessagesResponse.messages);
            setGeneratedMedia(directMessagesResponse.generatedMedia);
            setMessageSnapshotIdentity(JSON.stringify([cwd.trim(), request.teammateId]));
          });
          workspaceRequestOwner.clearError(request);
        } catch (error) {
          if (workspaceRequestOwner.isActionCurrent(request)) throw error;
        }
      }
      if (!response.message) workspaceRequestOwner.clearError(operation);
    } catch (error) {
      workspaceRequestOwner.reportError(operation, error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestOwner.isActionCurrent(operation)) setDirectGuidancePromotingId("");
    }
  }

  function handlePrivateComposerSubmit(authorization: {
    readonly authorizationMode: AuthorizationMode;
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
      readonly authorizationMode: AuthorizationMode;
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
      workspaceRequestOwner.reportImmediate("guidance", t("Guidance is already queued. Run or delete the queued message first."));
      return;
    }
    void sendPrivateMessage(authorization);
  }

  function handlePrivateComposerPasteFiles(files: readonly File[]): void {
    void uploadPrivateFiles(files);
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
    const request = workspaceRequestOwner.beginWorkspaceAction("attachment-upload");
    if (!workspaceRequestOwner.isActionCurrent(request)) return;
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
      const responses = await Promise.all(selectedFiles.map((file) => uploadTeammatePrivateAttachment(cwd.trim(), request.teammateId, file)));
      if (!workspaceRequestOwner.isActionCurrent(request)) return;
      const uploaded = responses.map((response) => response.attachment);
      const uploadedByLocalId = new Map(uploadItems.map((item, index) => [item.localId, uploaded[index]]));
      workspaceRequestOwner.claimAndCommit(request, ["conversation"], () => {
        setPrivateAttachments((current) => [...uploaded, ...current.filter((attachment) => !uploaded.some((item) => item.id === attachment.id))]);
        setPendingAttachments((current) => current.map((item) => {
          if (!uploadedByLocalId.has(item.localId)) return item;
          const attachment = uploadedByLocalId.get(item.localId);
          return attachment
            ? { ...item, state: "ready", attachment }
            : { ...item, state: "failed", error: t("Upload failed") };
        }));
      });
      workspaceRequestOwner.clearError(request);
    } catch (error) {
      if (!workspaceRequestOwner.isActionCurrent(request)) return;
      const message = error instanceof Error ? error.message : String(error);
      setPendingAttachments((current) => current.map((item) =>
        uploadItems.some((upload) => upload.localId === item.localId)
          ? { ...item, state: "failed", error: message }
          : item,
      ));
      workspaceRequestOwner.reportError(request, message);
    } finally {
      if (workspaceRequestOwner.isActionCurrent(request)) setUploadingAttachments(false);
    }
  }

  async function removePendingAttachment(localId: string): Promise<void> {
    const removed = pendingAttachments.find((item) => item.localId === localId);
    revokePendingAttachmentPreview(removed, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
    setPendingAttachments((current) => current.filter((item) => item.localId !== localId));
    if (!removed?.attachment || !removed.deleteOnRemove) {
      return;
    }
    const request = workspaceRequestOwner.beginWorkspaceAction("attachment-delete");
    if (!workspaceRequestOwner.isActionCurrent(request)) return;
    try {
      await deleteAttachment(cwd.trim(), removed.attachment.id);
      workspaceRequestOwner.claimAndCommit(request, ["conversation"], () => {
        setPrivateAttachments((current) => current.filter((attachment) => attachment.id !== removed?.attachment?.id));
      });
      workspaceRequestOwner.clearError(request);
    } catch (error) {
      workspaceRequestOwner.reportError(request, error instanceof Error ? error.message : String(error));
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
    privateFeedPinnedToLatestRef.current = false;
  }

  function scrollPrivateFeedToLatest(): void {
    const feed = privateFeedRef.current;
    if (!feed) {
      return;
    }
    privateFeedAutoFollowUntilRef.current = Date.now() + 1_000;
    privateFeedUserScrollIntentRef.current = false;
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
    await refreshTeammateActivity();
  }

  return (
    <div
      className={[
        "teammate-workspace",
        `right-dock-motion-${chatDockController.motionState}`,
        workspaceView === "settings" ? "settings-mode" : "chat-mode",
        `titlebar-${titlebarPlacement}`,
      ].filter(Boolean).join(" ")}
      data-ui2-teammate-settings={workspaceView === "settings" || undefined}
    >
      {workspaceView === "chat" ? (
        <DesktopTitlebarSurface>
        <TeammateChatHeader
          cwd={cwd}
          teammate={teammate}
          attachmentCount={directAttachments.length}
          searchInputRef={chatHeaderController.searchInputRef}
          searchOpen={chatHeaderController.searchOpen}
          searchQuery={messageSearchQuery}
          searchTriggerRef={chatHeaderController.searchTriggerRef}
          summaryOpen={chatSummaryOpen}
          summaryVisible={chatSummaryLayout.visible}
          summaryDockOffset={chatSummaryDockOffset}
          summaryDockResizing={chatDockController.resizing}
          summaryDockMotion={chatSummaryDockMotion}
          summaryDockState={chatDockController.motionState}
          summaryRows={privateSummaryRows}
          terminalOpen={chatTerminalOpen}
          terminalDisabled={!cwd.trim()}
          detailsOpen={chatDockController.expanded}
          detailsDisabled={!chatDockController.available}
          moreButtonRef={renameController.triggerRef}
          onToggleSearch={() => {
            setChatSummaryOpen(false);
            chatHeaderController.toggleSearch();
          }}
          onCloseSearch={() => chatHeaderController.closeSearch(true)}
          onSearchQueryChange={setMessageSearchQuery}
          onClearSearch={chatHeaderController.clearSearch}
          onOpenAttachments={() => openChatDockPage("files")}
          onOpenSettings={openTeammateSettings}
          onOpenRename={() => {
            chatHeaderController.closeSearch();
            setChatSummaryOpen(false);
            renameController.openDialog();
          }}
          onOpenContext={() => {
            chatHeaderController.closeSearch();
            openChatDockPage("context");
          }}
          onToggleSummary={() => {
            chatHeaderController.closeSearch();
            setChatSummaryOpen((current) => !current);
          }}
          onCloseSummary={() => setChatSummaryOpen(false)}
          onToggleTerminal={() => {
            setChatTerminalOpen((current) => !current);
          }}
          onToggleDetails={() => {
            if (!chatDockController.available) return;
            setChatDockOpen((current) => !current);
          }}
        />
        </DesktopTitlebarSurface>
      ) : (
        <DesktopTitlebarSurface>
        <TeammateSettingsHeader
          profileActive={activeTab === "profile"}
          profileDirty={profileController.profileDirty}
          savingProfile={profileController.savingProfile}
          modelActive={activeTab === "model" && !isProtectedSystemTeammate}
          modelDirty={modelController.modelDirty}
          savingModel={modelController.savingModel}
          permissionsActive={activeTab === "tools_permissions"}
          permissionsDirty={permissionsController.dirty || externalToolsController.dirty}
          savingPermissions={permissionsController.saving || externalToolsController.saving}
          onBack={() => setWorkspaceView("chat")}
          onResetProfile={profileController.resetProfile}
          onSaveProfile={() => void profileController.saveProfile()}
          onResetModel={modelController.resetModel}
          onSaveModel={() => void modelController.saveModel()}
          onResetPermissions={() => {
            permissionsController.reset();
            externalToolsController.reset();
          }}
          onSavePermissions={() => void Promise.all([
            permissionsController.save(),
            externalToolsController.save(),
          ])}
        />
        </DesktopTitlebarSurface>
      )}

      {renameController.open ? (
        <TeammateRenameDialog
          currentName={teammate.displayName}
          error={renameController.error}
          returnFocusRef={renameController.triggerRef}
          saving={renameController.saving}
          value={renameController.value}
          onClose={renameController.close}
          onSubmit={() => void renameController.submit()}
          onValueChange={renameController.setValue}
        />
      ) : null}

      {workspaceView === "chat" && workspaceError ? <div className="inline-error">{workspaceError}</div> : null}
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
          threadId={currentDirectWorkspace?.threadId}
          userProfile={userProfile}
          loading={loading}
          visibleMessages={visibleMessages}
          generatedMedia={currentGeneratedMedia}
          normalizedMessageSearchQuery={normalizedMessageSearchQuery}
          privateFeedRef={privateFeedRef}
          usedMemoryEvents={usedMemoryEvents}
          memoryById={memoryById}
          runs={runs}
          executionActions={directExecutionActions}
          approvals={currentDirectRuntime?.approvals ?? []}
          composerGateApprovals={directApprovalViews}
          terminalReports={terminalReports}
          dockViewModel={privateDockViewModel}
          providerRecovered={providerRecovered}
          modelNotice={privateModelNotice}
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
          fullAccessConfirmed={fullAccessConfirmed}
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
          composerGateNode={directApprovalViews.length > 0 ? (
            <RuntimeApprovalComposerGate
              approvals={directApprovalViews}
              approvalErrors={approvalErrors}
              resolvingApprovals={resolvingApprovals}
              surface="teammate_direct"
              onResolve={(approvalId, decision, reason, proposedRuleFingerprint) => {
                void Promise.resolve(onResolveApproval(
                  approvalId,
                  decision,
                  reason,
                  proposedRuleFingerprint,
                )).then(() => refreshDirectRuntime());
              }}
            />
          ) : undefined}
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
          onOpenModelSettings={() => openTeammateSettings("model")}
          onMessageDraftChange={setMessageDraft}
          onComposerSubmit={handlePrivateComposerSubmit}
          onComposerKeyDown={handlePrivateComposerKeyDown}
          onComposerPasteFiles={handlePrivateComposerPasteFiles}
          onComposerDragOver={handlePrivateComposerDragOver}
          onComposerDragLeave={handlePrivateComposerDragLeave}
          onComposerDrop={handlePrivateComposerDrop}
          onUploadPrivateFiles={uploadPrivateFiles}
          onRemoveComposerFileReference={removeComposerFileReference}
          onRemovePendingLinkPreview={(previewId) => setPendingDirectLinkPreviewIds((current) => current.filter((id) => id !== previewId))}
          onRemovePendingAttachment={removePendingAttachment}
          authorizationMode={selectedAuthorizationMode}
          onAuthorizationModeChange={setSelectedAuthorizationMode}
          workspaceAccessMode={selectedWorkspaceAccessMode}
          onWorkspaceAccessModeChange={setSelectedWorkspaceAccessMode}
          onFullAccessPresetSelected={onConfirmFullAccessSelection}
          dockOpen={chatDockController.renderedOpen}
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
          summaryVisible={chatSummaryLayout.visible}
          summaryLayoutStyle={chatSummaryLayout.style}
          onDockPageRequestConsumed={(nonce) => {
            setChatDockPageRequest((current) => current?.nonce === nonce ? undefined : current);
          }}
          onDockClose={() => setChatDockOpen(false)}
          onTerminalClose={() => setChatTerminalOpen(false)}
        />
      ) : null}

      {workspaceView === "settings" ? (
        <div className="channel-settings-tab-content teammate-settings-tab-content">
          {workspaceError ? <div className="inline-error">{workspaceError}</div> : null}
          {loading ? (
            <div className="client-empty-state teammate-empty">
              <Loader2 className="spin" />
              <span>{t("Loading teammate workspace...")}</span>
            </div>
          ) : null}

          {activeTab === "model" ? (
            <TeammateModelTab
              modelError={modelController.modelError}
              savingModel={modelController.savingModel}
              viewModel={modelController.viewModel}
              onOpenProviders={onOpenProviders}
              onSelectProvider={modelController.selectProvider}
            />
          ) : null}

          {activeTab === "channels" ? <TeammateChannelsTab controller={channelsController} /> : null}
          {activeTab === "skills" ? <TeammateSkillsTab controller={skillsController} onOpenSkillLibrary={onOpenSkillLibrary} /> : null}

          {activeTab === "profile" ? (
            <div className="teammate-profile-settings-stack">
              <TeammateProfileTab
                avatarCropSource={profileController.avatarCropSource}
                avatarTriggerRef={profileController.avatarTriggerRef}
                cwd={cwd}
                teammate={teammate}
                settingsForm={settingsForm}
                personaImportForm={profileController.personaImportForm}
                personaDraft={profileController.personaDraft}
                personaError={profileController.personaError}
                profileError={profileController.profileError}
                isProtectedSystemTeammate={isProtectedSystemTeammate}
                uploadingAvatar={profileController.uploadingAvatar}
                personaBusyAction={profileController.personaBusyAction}
                onSettingsFormChange={setSettingsForm}
                onPersonaImportFormChange={profileController.setPersonaImportForm}
                onSelectAvatarFile={profileController.selectAvatarFile}
                onRemoveAvatar={profileController.removeAvatar}
                onCancelAvatarCrop={profileController.cancelAvatarCrop}
                onConfirmAvatarCrop={profileController.confirmAvatarCrop}
                onPreviewPersonaImport={profileController.previewPersonaImport}
                onApplyPersonaDraft={profileController.applyPersonaDraft}
              />
              {!isProtectedSystemTeammate ? <TeammateDangerTab controller={dangerController} teammate={teammate} /> : null}
            </div>
          ) : null}

          {activeTab === "tools_permissions" ? (
            <div className="teammate-tools-permissions-panel">
              <TeammatePermissionsTab
                controller={permissionsController}
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
              {mcpServers.length > 0 ? (
                <TeammateExternalToolsSection
                  controller={externalToolsController}
                  servers={mcpServers}
                  toolsByServerId={mcpToolsByServerId}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function mergeConversationGeneratedMedia(
  currentItems: readonly ConversationGeneratedMedia[],
  latestItems: readonly ConversationGeneratedMedia[],
): readonly ConversationGeneratedMedia[] {
  const byId = new Map<string, ConversationGeneratedMedia>();
  for (const item of [...currentItems, ...latestItems]) byId.set(item.mediaJobId, item);
  return [...byId.values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.mediaJobId.localeCompare(right.mediaJobId),
  );
}
