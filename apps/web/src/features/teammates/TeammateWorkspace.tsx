import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import type { SkillPack } from "@ling-stack/core/skill-types";
import {
  archiveSkill,
  cancelTeammateDirectIntervention,
  cancelTeammateDirectReply,
  createSkillImportDraft,
  createTask,
  createTeammateDirectLinkPreview,
  createTeammateDirectIntervention,
  createTeammatePersonaDraft,
  deleteAttachment,
  deleteTeammateAvatar,
  getMemoryHealth,
  getSkillSourceHealth,
  getTeammateDirectRuntime,
  getTeammateDirectWorkspace,
  getMemoryReviewPolicy,
  exportMemoryMarkdown,
  importMemoryMarkdown,
  listMemoryObjects,
  listMemoryPromotionInbox,
  listSkills,
  listTeammateActivity,
  listTeammateChannels,
  listTeammateDirectLinkPreviews,
  listTeammateDirectMessages,
  listTeammatePrivateAttachments,
  listUsedMemoryEvents,
  listMcpServers,
  listMcpTools,
  listTeammateMcpBindings,
  listTeammateMemoryScopes,
  listTeammateSkills,
  listTeammateTasks,
  promoteTeammateDirectIntervention,
  publishSkillImportDraft,
  replaceTeammateChannels,
  replaceTeammateMcpBindings,
  replaceTeammateSkills,
  reviewMemory,
  streamTeammateDirectMessage,
  updateMemoryReviewPolicy,
  uploadTeammateAvatar,
  uploadTeammatePrivateAttachment,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { titleFromPrompt } from "../../lib/formatting.js";
import { deriveEffectiveTeammateChannelMemberships } from "../../lib/channel-teammates.js";
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
  SettingsToolReturnRow,
  type PendingAttachmentItem,
} from "../../shared/components/index.js";
import type {
  AiTeammate,
  Channel,
  EffectiveTeammateSkill,
  MemoryHealthReport,
  MemoryMarkdownImportPlan,
  MemoryObject,
  MemoryPromotionInboxItem,
  MemoryReviewAction,
  MemoryReviewMode,
  MemoryReviewPolicy,
  McpServer,
  McpTool,
  ProviderPreset,
  RunSession,
  SkillImportDraft,
  SkillRegistryEntry,
  SkillSourceSnapshot,
  Task,
  TeammatePersonaDraft,
  TeammateActivityItem,
  TeammateChannelMembership,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammateDirectReplyIntervention,
  TeammateDirectRuntimeResponse,
  DirectWorkspaceResponse,
  TeammateMcpBinding,
  TeammateMemoryScope,
  TeammatePrivateAttachment,
  TeammateDirectMessageStreamBlockedEvent,
  TeammateDirectMessageStreamDeltaEvent,
  TeammateDirectMessageStreamDoneEvent,
  TeammateDirectMessageStreamErrorEvent,
  TeammateDirectMessageStreamReadyEvent,
  TeammateSkillBinding,
  UpdateAiTeammateRequest,
  UsedMemoryEvent,
  UserProfile,
} from "../../types.js";
import { TeammateActivityTab } from "./TeammateActivityTab.js";
import { TeammateChatContextPanel } from "./TeammateChatContextPanel.js";
import { TeammateChatHeader } from "./TeammateChatHeader.js";
import { TeammateChannelsTab } from "./TeammateChannelsTab.js";
import { TeammateDangerTab } from "./TeammateDangerTab.js";
import { TeammateMemoryTab, type MemoryReviewEditForm } from "./TeammateMemoryTab.js";
import { TeammateMcpTab, type McpToolFilter as TeammateMcpToolFilter } from "./TeammateMcpTab.js";
import { TeammateModelTab } from "./TeammateModelTab.js";
import { TeammatePermissionsTab } from "./TeammatePermissionsTab.js";
import { TeammateProfileTab } from "./TeammateProfileTab.js";
import { TeammatePrivateChatSurface } from "./TeammatePrivateChatSurface.js";
import { TeammateSettingsSummaryPanel } from "./TeammateSettingsSummaryPanel.js";
import { TeammateSkillsTab, type SkillImportForm, type TeammateSkillRowModel } from "./TeammateSkillsTab.js";
import { TeammateTasksTab, type TeammateTaskCreateForm as ExtractedTeammateTaskCreateForm } from "./TeammateTasksTab.js";
import {
  directComposerFileRefs,
  directGuidanceDraftText,
  downloadTextFile,
  extractUrls,
  filterTeammateSkillRows,
  memoryReviewActionMessage,
  normalizeManualSkillId,
  pendingAttachmentItemsFromIds,
  splitAdditionalInstructions,
  summarizeDirectGuidancePayload,
  teammateToSettingsForm,
  uniqueDirectLinkPreviews,
  upsertDirectMessages,
  type SkillBindingFilter,
} from "./teammate-workspace-utils.js";

type TeammateWorkspaceView = "chat" | "settings";
type TeammateWorkspaceTab = "profile" | "model" | "permissions" | "channels" | "skills" | "memory" | "mcp" | "danger" | "tasks" | "activity";
type McpToolFilter = TeammateMcpToolFilter;

interface TeammateSettingsForm {
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId: string;
  readonly status: AiTeammate["status"];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly systemPrompt: string;
  readonly appendSystemPromptText: string;
}

type TeammateTaskCreateForm = ExtractedTeammateTaskCreateForm;

interface PersonaImportForm {
  readonly sourcePath: string;
  readonly content: string;
}

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
  onRefreshTasks,
  onOpenRun,
  onBackToWorkspaceTools,
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
  readonly onRefreshTasks?: (channelId: string) => MaybePromise<void>;
  readonly onOpenRun?: (runId: string) => void;
  readonly onBackToWorkspaceTools?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [workspaceView, setWorkspaceView] = useState<TeammateWorkspaceView>("chat");
  const [activeTab, setActiveTab] = useState<TeammateWorkspaceTab>("profile");
  const [messages, setMessages] = useState<readonly TeammateDirectMessage[]>([]);
  const [hasMoreDirectMessages, setHasMoreDirectMessages] = useState(false);
  const [nextDirectBeforeMessageId, setNextDirectBeforeMessageId] = useState<string | undefined>();
  const [loadingOlderDirectMessages, setLoadingOlderDirectMessages] = useState(false);
  const [directRuntime, setDirectRuntime] = useState<TeammateDirectRuntimeResponse | undefined>();
  const [directWorkspace, setDirectWorkspace] = useState<DirectWorkspaceResponse | undefined>();
  const [directReplyOptimisticActive, setDirectReplyOptimisticActive] = useState(false);
  const [directGuidanceSubmitting, setDirectGuidanceSubmitting] = useState<"queue_followup" | "interrupt_redirect" | "stop" | "">("");
  const [directGuidanceCancelingId, setDirectGuidanceCancelingId] = useState("");
  const [directGuidancePromotingId, setDirectGuidancePromotingId] = useState("");
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const [chatContextPanelOpen, setChatContextPanelOpen] = useState(false);
  const [privateAttachments, setPrivateAttachments] = useState<readonly TeammatePrivateAttachment[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachmentItem<TeammatePrivateAttachment>[]>([]);
  const [directLinkPreviews, setDirectLinkPreviews] = useState<readonly TeammateDirectLinkPreview[]>([]);
  const [pendingDirectLinkPreviewIds, setPendingDirectLinkPreviewIds] = useState<readonly string[]>([]);
  const [memberships, setMemberships] = useState<readonly TeammateChannelMembership[]>([]);
  const [skillRegistryEntries, setSkillRegistryEntries] = useState<readonly SkillRegistryEntry[]>([]);
  const [skillBindings, setSkillBindings] = useState<readonly TeammateSkillBinding[]>([]);
  const [effectiveSkills, setEffectiveSkills] = useState<readonly EffectiveTeammateSkill[]>([]);
  const [skillSourceSnapshots, setSkillSourceSnapshots] = useState<readonly SkillSourceSnapshot[]>([]);
  const [mcpServers, setMcpServers] = useState<readonly McpServer[]>([]);
  const [mcpTools, setMcpTools] = useState<readonly McpTool[]>([]);
  const [mcpBindings, setMcpBindings] = useState<readonly TeammateMcpBinding[]>([]);
  const [memoryScopes, setMemoryScopes] = useState<readonly TeammateMemoryScope[]>([]);
  const [memoryObjects, setMemoryObjects] = useState<readonly MemoryObject[]>([]);
  const [memoryHealthReport, setMemoryHealthReport] = useState<MemoryHealthReport | undefined>();
  const [memoryPromotionInbox, setMemoryPromotionInbox] = useState<readonly MemoryPromotionInboxItem[]>([]);
  const [memoryReviewPolicy, setMemoryReviewPolicy] = useState<MemoryReviewPolicy | undefined>();
  const [memoryReviewingId, setMemoryReviewingId] = useState("");
  const [memoryReviewMessage, setMemoryReviewMessage] = useState("");
  const [memoryPolicySaving, setMemoryPolicySaving] = useState(false);
  const [memoryEditId, setMemoryEditId] = useState("");
  const [memoryEditForm, setMemoryEditForm] = useState<MemoryReviewEditForm>({ title: "", body: "", sensitivity: "normal" });
  const [memoryTransferBusy, setMemoryTransferBusy] = useState<"" | "export" | "preview" | "import">("");
  const [memoryExportIncludeSecretAdjacent, setMemoryExportIncludeSecretAdjacent] = useState(false);
  const [memoryImportContent, setMemoryImportContent] = useState("");
  const [memoryImportSourceLabel, setMemoryImportSourceLabel] = useState("");
  const [memoryImportPlan, setMemoryImportPlan] = useState<MemoryMarkdownImportPlan | undefined>();
  const [usedMemoryEvents, setUsedMemoryEvents] = useState<readonly UsedMemoryEvent[]>([]);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [activityItems, setActivityItems] = useState<readonly TeammateActivityItem[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [manualSkillInput, setManualSkillInput] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [skillSearchQuery, setSkillSearchQuery] = useState("");
  const [skillFilter, setSkillFilter] = useState<SkillBindingFilter>("all");
  const [skillImportOpen, setSkillImportOpen] = useState(false);
  const [taskForm, setTaskForm] = useState<TeammateTaskCreateForm>({ channelId: "", requestedSkillId: "", title: "", prompt: "" });
  const [skillImportForm, setSkillImportForm] = useState<SkillImportForm>({ name: "", sourcePath: "", source: "custom", content: "" });
  const [skillImportDraft, setSkillImportDraft] = useState<SkillImportDraft | undefined>();
  const [importingSkill, setImportingSkill] = useState(false);
  const [personaImportForm, setPersonaImportForm] = useState<PersonaImportForm>({ sourcePath: "", content: "" });
  const [personaDraft, setPersonaDraft] = useState<TeammatePersonaDraft | undefined>();
  const [importingPersona, setImportingPersona] = useState(false);
  const [settingsForm, setSettingsForm] = useState<TeammateSettingsForm>(() => teammateToSettingsForm(teammate));
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [privateFeedLatestButtonVisible, setPrivateFeedLatestButtonVisible] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [savingChannels, setSavingChannels] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);
  const [savingMcp, setSavingMcp] = useState(false);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [hardDeleting, setHardDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [hardDeleteReason, setHardDeleteReason] = useState("");
  const [taskMessage, setTaskMessage] = useState("");
  const [channelMessage, setChannelMessage] = useState("");
  const [skillMessage, setSkillMessage] = useState("");
  const [mcpMessage, setMcpMessage] = useState("");
  const [expandedMcpServerIds, setExpandedMcpServerIds] = useState<ReadonlySet<string>>(() => new Set());
  const [mcpToolSearchByServerId, setMcpToolSearchByServerId] = useState<Readonly<Record<string, string>>>({});
  const [mcpToolFilterByServerId, setMcpToolFilterByServerId] = useState<Readonly<Record<string, McpToolFilter>>>({});
  const [workspaceError, setWorkspaceError] = useState("");
  const privateFeedRef = useRef<HTMLDivElement | null>(null);
  const privateFeedPinnedToLatestRef = useRef(true);
  const privateFeedAutoFollowUntilRef = useRef(0);
  const privateFeedUserScrollIntentRef = useRef(false);
  const directGuidanceOperationSeqRef = useRef(0);
  const attachmentPreviewUrlsRef = useRef(new Set<string>());
  const provider = teammate.providerPresetId ? providers.find((item) => item.id === teammate.providerPresetId) : undefined;
  const settingsProvider = settingsForm.providerPresetId ? providers.find((item) => item.id === settingsForm.providerPresetId) : undefined;
  const isProtectedSystemTeammate = Boolean(teammate.protectedProfile || teammate.kind === "system_teammate" || teammate.systemRole === "ling_agent");
  const skillDefinitions = useMemo(() => {
    if (skillRegistryEntries.length > 0) {
      return skillRegistryEntries.map((entry) => entry.definition);
    }
    return skillPack?.skills ?? [];
  }, [skillPack, skillRegistryEntries]);
  const skillById = useMemo(() => new Map(skillDefinitions.map((skill) => [skill.id, skill])), [skillDefinitions]);
  const registryEntryBySkillId = useMemo(() => new Map(skillRegistryEntries.map((entry) => [entry.id, entry])), [skillRegistryEntries]);
  const bindingBySkillId = useMemo(() => new Map(skillBindings.map((binding) => [binding.skillId, binding])), [skillBindings]);
  const effectiveSkillById = useMemo(() => new Map(effectiveSkills.map((skill) => [skill.skillId, skill])), [effectiveSkills]);
  const sourceSnapshotBySkillId = useMemo(() => new Map(skillSourceSnapshots.map((snapshot) => [snapshot.skillId, snapshot])), [skillSourceSnapshots]);
  const memoryById = useMemo(() => new Map(memoryObjects.map((memory) => [memory.id, memory])), [memoryObjects]);
  const privateAttachmentById = useMemo(() => new Map(privateAttachments.map((attachment) => [attachment.id, attachment])), [privateAttachments]);
  const readyAttachmentIds = pendingAttachments.flatMap((item) => item.attachment ? [item.attachment.id] : []);
  const composerInputParts = parseComposerInputParts(messageDraft, {
    cwd: cwd.trim(),
    attachments: readyAttachmentIds.map((attachmentId) => ({ attachmentId })),
    skills: effectiveSkills.map((skill) => ({ id: skill.skillId, label: skill.skill.name })),
  });
  const composerFileReferenceParts = composerWorkspaceFileParts(composerInputParts);
  const composerFileReferenceTokens = composerFileReferenceParts.map((part, index) => ({
    part,
    occurrenceIndex: composerFileReferenceParts.slice(0, index).filter((candidate) => candidate.raw === part.raw).length,
  }));
  const enabledSkillCount = useMemo(() => skillBindings.filter((binding) => binding.enabled).length, [skillBindings]);
  const skillRows = useMemo((): readonly TeammateSkillRowModel[] => {
    const registryRows = skillDefinitions.map((skill) => ({
      id: skill.id,
      skill,
      binding: bindingBySkillId.get(skill.id),
      effectiveSkill: effectiveSkillById.get(skill.id),
      sourceSnapshot: sourceSnapshotBySkillId.get(skill.id),
    }));
    const unknownRows = skillBindings
      .filter((binding) => !skillById.has(binding.skillId))
      .map((binding) => ({
        id: binding.skillId,
        skill: undefined,
        binding,
        effectiveSkill: effectiveSkillById.get(binding.skillId),
        sourceSnapshot: sourceSnapshotBySkillId.get(binding.skillId),
      }));
    return [...registryRows, ...unknownRows];
  }, [bindingBySkillId, effectiveSkillById, skillBindings, skillById, skillDefinitions, sourceSnapshotBySkillId]);
  const skillTableRows = useMemo(() => filterTeammateSkillRows(skillRows, skillSearchQuery, skillFilter), [skillFilter, skillRows, skillSearchQuery]);
  const selectedSkillRow = useMemo(
    () => skillRows.find((row) => row.id === selectedSkillId) ?? skillTableRows[0] ?? skillRows[0],
    [selectedSkillId, skillRows, skillTableRows],
  );
  const skillStats = useMemo(() => {
    const bound = skillRows.filter((row) => row.binding?.enabled).length;
    const executable = skillRows.filter((row) => row.effectiveSkill?.executable).length;
    const blocked = skillRows.filter((row) => row.binding?.enabled && !row.effectiveSkill?.executable).length;
    const available = skillRows.filter((row) => !row.binding).length;
    return { bound, executable, blocked, available };
  }, [skillRows]);
  const executableSkillOptions = useMemo(() => effectiveSkills.filter((skill) => skill.executable), [effectiveSkills]);
  const channelsById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const effectiveMemberships = useMemo(
    () => deriveEffectiveTeammateChannelMemberships({ teammate, channels, memberships }),
    [channels, memberships, teammate],
  );
  const membershipByChannelId = useMemo(() => new Map(effectiveMemberships.map((membership) => [membership.channelId, membership])), [effectiveMemberships]);
  const mcpToolsByServerId = useMemo(() => {
    const grouped = new Map<string, McpTool[]>();
    for (const tool of mcpTools) {
      grouped.set(tool.serverId, [...(grouped.get(tool.serverId) ?? []), tool]);
    }
    return grouped;
  }, [mcpTools]);
  const mcpBindingByServerId = useMemo(() => new Map(mcpBindings.map((binding) => [binding.serverId, binding])), [mcpBindings]);
  const taskChannelOptions = useMemo(() => {
    const seen = new Set<string>();
    const ordered: Channel[] = [];
    for (const membership of effectiveMemberships) {
      const channel = channelsById.get(membership.channelId);
      if (channel && !seen.has(channel.id)) {
        ordered.push(channel);
        seen.add(channel.id);
      }
    }
    for (const channel of channels) {
      if (!seen.has(channel.id)) {
        ordered.push(channel);
        seen.add(channel.id);
      }
    }
    return ordered;
  }, [channels, channelsById, effectiveMemberships]);
  const settingsSections: readonly { readonly id: TeammateWorkspaceTab; readonly label: string; readonly count?: number; readonly danger?: boolean }[] = [
    { id: "profile", label: t("Profile") },
    { id: "model", label: t("Model") },
    { id: "permissions", label: t("Permissions") },
    { id: "channels", label: t("Channels"), count: effectiveMemberships.length },
    { id: "memory" as const, label: t("Memory"), count: memoryPromotionInbox.length || memoryScopes.length },
    ...(isProtectedSystemTeammate ? [] : [
      { id: "skills" as const, label: t("Skills"), count: enabledSkillCount },
      { id: "mcp" as const, label: t("MCP") },
      { id: "danger" as const, label: t("Danger zone"), danger: true },
    ]),
  ];
  const normalizedMessageSearchQuery = messageSearchQuery.trim().toLowerCase();
  const visibleMessages = useMemo(() => {
    if (!normalizedMessageSearchQuery) {
      return messages;
    }
    return messages.filter((message) => {
      const attachmentText = message.attachmentIds
        .map((id) => privateAttachmentById.get(id)?.fileName ?? "")
        .join(" ");
      return `${message.body} ${attachmentText}`.toLowerCase().includes(normalizedMessageSearchQuery);
    });
  }, [messages, normalizedMessageSearchQuery, privateAttachmentById]);

  useEffect(() => {
    if (isProtectedSystemTeammate && (activeTab === "skills" || activeTab === "mcp" || activeTab === "danger")) {
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
  const recentUsedMemoryEvents = useMemo(() => usedMemoryEvents.slice(0, 3), [usedMemoryEvents]);
  const recentMemoryObjects = useMemo(() => {
    const memoryIds = recentUsedMemoryEvents.flatMap((event) => event.memoryIds);
    return [...new Set(memoryIds)]
      .map((id) => memoryById.get(id))
      .filter((memory): memory is MemoryObject => Boolean(memory))
      .slice(0, 3);
  }, [memoryById, recentUsedMemoryEvents]);
  const lastAiMessage = useMemo(
    () => [...messages].reverse().find((message) => message.authorType === "ai-teammate"),
    [messages],
  );
  const directLinkPreviewById = useMemo(() => new Map(directLinkPreviews.map((preview) => [preview.id, preview])), [directLinkPreviews]);
  const pendingDirectLinkPreviews = useMemo(
    () => pendingDirectLinkPreviewIds.map((id) => directLinkPreviewById.get(id)).filter((preview): preview is TeammateDirectLinkPreview => Boolean(preview)),
    [directLinkPreviewById, pendingDirectLinkPreviewIds],
  );
  const providerReady = Boolean(provider && providerPreflightReady(provider));
  const providerRecovered = providerReady && Boolean(provider);
  const settingsProviderReady = Boolean(settingsProvider && providerPreflightReady(settingsProvider));
  const openDirectInterventions = directRuntime?.interventions ?? [];
  const hasQueuedDirectGuidance = openDirectInterventions.some((intervention) => intervention.status === "queued");
  const directReplyActive = Boolean(directRuntime?.activeReply || directReplyOptimisticActive);
  const hasDirectRuntimeActivity = Boolean(directRuntime?.activeReply || directReplyOptimisticActive || openDirectInterventions.length > 0);
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

  useEffect(() => {
    setSettingsForm(teammateToSettingsForm(teammate));
  }, [teammate]);

  useEffect(() => {
    setWorkspaceView("chat");
    setActiveTab("profile");
    setSaveMessage("");
    setTaskMessage("");
    setChannelMessage("");
    setSkillMessage("");
    setMcpMessage("");
    setExpandedMcpServerIds(new Set());
    setMcpToolSearchByServerId({});
    setMcpToolFilterByServerId({});
    setManualSkillInput("");
    setSelectedSkillId("");
    setSkillSearchQuery("");
    setSkillFilter("all");
    setSkillImportOpen(false);
    setMessageSearchOpen(false);
    setMessageSearchQuery("");
    setChatContextPanelOpen(false);
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
    setHardDeleteReason("");
    setTaskForm({ channelId: "", requestedSkillId: "", title: "", prompt: "" });
    setSkillImportForm({ name: "", sourcePath: "", source: "custom", content: "" });
    setSkillImportDraft(undefined);
    setPersonaImportForm({ sourcePath: "", content: "" });
    setPersonaDraft(undefined);
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
    setTaskForm((current) => {
      const channelId = resolvePreferredTaskChannelId(current.channelId);
      return channelId === current.channelId ? current : { ...current, channelId };
    });
  }, [channels, memberships]);

  useEffect(() => {
    if (!selectedSkillRow && selectedSkillId) {
      setSelectedSkillId("");
      return;
    }
    if (selectedSkillRow && selectedSkillRow.id !== selectedSkillId) {
      setSelectedSkillId(selectedSkillRow.id);
    }
  }, [selectedSkillId, selectedSkillRow]);

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

  async function refreshTeammateWorkspace(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setWorkspaceError(t("Workspace path is required."));
      return;
    }
    setLoading(true);
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
        channelResponse,
        skillResponse,
        mcpServersResponse,
        mcpToolsResponse,
        mcpBindingsResponse,
        memoryResponse,
        memoryObjectsResponse,
        memoryHealthResponse,
        memoryReviewPolicyResponse,
        memoryPromotionInboxResponse,
        usedMemoryResponse,
        taskResponse,
        activityResponse,
      ] = await Promise.all([
        listTeammateDirectMessages(workspaceCwd, teammate.id),
        getTeammateDirectRuntime(workspaceCwd, teammate.id),
        getTeammateDirectWorkspace(workspaceCwd, teammate.id),
        listTeammateDirectLinkPreviews(workspaceCwd, teammate.id),
        listTeammatePrivateAttachments(workspaceCwd, teammate.id),
        listSkills(workspaceCwd),
        getSkillSourceHealth(workspaceCwd, { limit: 8 }),
        listTeammateChannels(workspaceCwd, teammate.id),
        listTeammateSkills(workspaceCwd, teammate.id),
        listMcpServers(workspaceCwd),
        listMcpTools(workspaceCwd),
        listTeammateMcpBindings(workspaceCwd, teammate.id),
        listTeammateMemoryScopes(workspaceCwd, teammate.id),
        listMemoryObjects(workspaceCwd),
        getMemoryHealth(workspaceCwd, { limit: 8 }),
        getMemoryReviewPolicy(workspaceCwd),
        listMemoryPromotionInbox(workspaceCwd),
        listUsedMemoryEvents(workspaceCwd, { teammateId: teammate.id, limit: 100 }),
        listTeammateTasks(workspaceCwd, teammate.id),
        listTeammateActivity(workspaceCwd, teammate.id),
      ]);
      setMessages(directResponse.messages);
      setHasMoreDirectMessages(Boolean(directResponse.hasMore));
      setNextDirectBeforeMessageId(directResponse.nextBeforeMessageId);
      setDirectRuntime(directRuntimeResponse);
      setDirectWorkspace(directWorkspaceResponse);
      setDirectLinkPreviews(directLinkPreviewsResponse.linkPreviews);
      setPrivateAttachments(privateAttachmentsResponse.attachments);
      setSkillRegistryEntries(skillRegistryResponse.skills);
      setSkillSourceSnapshots(skillSourceHealthResponse.snapshots);
      setMemberships(channelResponse.memberships);
      setSkillBindings(skillResponse.bindings);
      setEffectiveSkills(skillResponse.effectiveSkills ?? []);
      setMcpServers(mcpServersResponse.servers);
      setMcpTools(mcpToolsResponse.tools);
      setMcpBindings(mcpBindingsResponse.bindings);
      setMemoryScopes(memoryResponse.scopes);
      setMemoryObjects(memoryObjectsResponse.memories);
      setMemoryHealthReport(memoryHealthResponse.report);
      setMemoryReviewPolicy(memoryReviewPolicyResponse.policy);
      setMemoryPromotionInbox(memoryPromotionInboxResponse.items);
      setUsedMemoryEvents(usedMemoryResponse.events);
      setTasks(taskResponse.tasks);
      setActivityItems(activityResponse.items);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
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

  async function sendPrivateMessage(): Promise<void> {
    const serializedInput = serializeComposerInputParts(composerInputParts);
    const body = serializedInput.body.trim();
    const attachmentIds = [...serializedInput.attachmentIds];
    const fileRefs = directComposerFileRefs(composerFileReferenceParts);
    if ((!body && attachmentIds.length === 0 && pendingDirectLinkPreviewIds.length === 0 && fileRefs.length === 0) || sending) {
      return;
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
          setMessages((current) => current.map((message) => message.id === data.messageId ? { ...message, body: data.body, status: "pending" } : message));
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
      const [activityResponse, usedMemoryResponse, memoryObjectsResponse, memoryHealthResponse, memoryReviewPolicyResponse, memoryPromotionInboxResponse] = await Promise.all([
        listTeammateActivity(cwd.trim(), teammate.id),
        listUsedMemoryEvents(cwd.trim(), { teammateId: teammate.id, limit: 100 }),
        listMemoryObjects(cwd.trim()),
        getMemoryHealth(cwd.trim(), { limit: 8 }),
        getMemoryReviewPolicy(cwd.trim()),
        listMemoryPromotionInbox(cwd.trim()),
      ]);
      setActivityItems(activityResponse.items);
      setUsedMemoryEvents(usedMemoryResponse.events);
      setMemoryObjects(memoryObjectsResponse.memories);
      setMemoryHealthReport(memoryHealthResponse.report);
      setMemoryReviewPolicy(memoryReviewPolicyResponse.policy);
      setMemoryPromotionInbox(memoryPromotionInboxResponse.items);
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

  function handlePrivateComposerSubmit(): void {
    if (directReplyActive) {
      if (privateComposerHasGuidancePayload) {
        void submitDirectGuidance("queue_followup");
        return;
      }
      void stopDirectReply();
      return;
    }
    void sendPrivateMessage();
  }

  function handlePrivateComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
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
    void sendPrivateMessage();
  }

  function handlePrivateComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
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

  async function refreshMemoryReviewData(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      return;
    }
    const [memoryObjectsResponse, memoryHealthResponse, memoryReviewPolicyResponse, memoryPromotionInboxResponse] = await Promise.all([
      listMemoryObjects(workspaceCwd),
      getMemoryHealth(workspaceCwd, { limit: 8 }),
      getMemoryReviewPolicy(workspaceCwd),
      listMemoryPromotionInbox(workspaceCwd),
    ]);
    setMemoryObjects(memoryObjectsResponse.memories);
    setMemoryHealthReport(memoryHealthResponse.report);
    setMemoryReviewPolicy(memoryReviewPolicyResponse.policy);
    setMemoryPromotionInbox(memoryPromotionInboxResponse.items);
  }

  async function exportMemoryProjection(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || memoryTransferBusy) {
      return;
    }
    setMemoryTransferBusy("export");
    try {
      setWorkspaceError("");
      setMemoryReviewMessage("");
      const response = await exportMemoryMarkdown(workspaceCwd, {
        includeMarkdown: true,
        includeSecretAdjacent: memoryExportIncludeSecretAdjacent,
      });
      if (!("markdown" in response.export)) {
        throw new Error("Memory export response did not include Markdown.");
      }
      downloadTextFile(response.export.suggestedFileName, response.export.markdown);
      setMemoryReviewMessage(t("Downloaded {count} memories", { count: response.export.memoryCount }));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemoryTransferBusy("");
    }
  }

  async function loadMemoryImportFile(file: File | undefined): Promise<void> {
    if (!file) {
      return;
    }
    try {
      setWorkspaceError("");
      setMemoryReviewMessage("");
      setMemoryImportContent(await file.text());
      setMemoryImportSourceLabel(file.name);
      setMemoryImportPlan(undefined);
      setMemoryReviewMessage(t("Loaded {name}", { name: file.name }));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }

  async function previewMemoryImport(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || memoryTransferBusy) {
      return;
    }
    if (!memoryImportContent.trim()) {
      setMemoryReviewMessage(t("Paste or choose a Markdown export first"));
      return;
    }
    setMemoryTransferBusy("preview");
    try {
      setWorkspaceError("");
      setMemoryReviewMessage("");
      const response = await importMemoryMarkdown(workspaceCwd, {
        markdown: memoryImportContent,
        sourceLabel: memoryImportSourceLabel.trim() || undefined,
        dryRun: true,
      });
      setMemoryImportPlan(response.plan);
      setMemoryReviewMessage(t("Preview ready: {count} candidates", { count: response.plan.candidateCount }));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemoryTransferBusy("");
    }
  }

  async function importMemoryCandidates(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || memoryTransferBusy) {
      return;
    }
    if (!memoryImportContent.trim()) {
      setMemoryReviewMessage(t("Paste or choose a Markdown export first"));
      return;
    }
    setMemoryTransferBusy("import");
    try {
      setWorkspaceError("");
      setMemoryReviewMessage("");
      const response = await importMemoryMarkdown(workspaceCwd, {
        markdown: memoryImportContent,
        sourceLabel: memoryImportSourceLabel.trim() || undefined,
        dryRun: false,
      });
      setMemoryImportPlan(response.plan);
      setMemoryReviewMessage(t("Imported {count} candidates", { count: response.importedCount }));
      await refreshMemoryReviewData();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemoryTransferBusy("");
    }
  }

  async function changeMemoryReviewMode(mode: MemoryReviewMode): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || memoryPolicySaving || memoryReviewPolicy?.mode === mode) {
      return;
    }
    setMemoryPolicySaving(true);
    try {
      setWorkspaceError("");
      setMemoryReviewMessage("");
      const response = await updateMemoryReviewPolicy(workspaceCwd, { mode });
      setMemoryReviewPolicy(response.policy);
      setMemoryReviewMessage(t("Memory review mode updated"));
      await refreshMemoryReviewData();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemoryPolicySaving(false);
    }
  }

  function startMemoryEdit(item: MemoryPromotionInboxItem): void {
    setMemoryEditId(item.memory.id);
    setMemoryEditForm({
      title: item.memory.title,
      body: item.memory.body,
      sensitivity: item.memory.sensitivity,
    });
  }

  async function applyMemoryReview(item: MemoryPromotionInboxItem, action: MemoryReviewAction): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || memoryReviewingId) {
      return;
    }
    setMemoryReviewingId(item.memory.id);
    try {
      setWorkspaceError("");
      setMemoryReviewMessage("");
      await reviewMemory(
        workspaceCwd,
        item.memory.id,
        action === "edit_and_approve"
          ? {
            action,
            editedMemory: {
              title: memoryEditForm.title.trim() || item.memory.title,
              body: memoryEditForm.body.trim() || item.memory.body,
              sensitivity: memoryEditForm.sensitivity,
            },
            reason: "Reviewed in teammate memory tab.",
          }
          : {
            action,
            reason: "Reviewed in teammate memory tab.",
          },
      );
      if (action !== "keep_candidate") {
        setMemoryEditId((current) => current === item.memory.id ? "" : current);
      }
      await refreshMemoryReviewData();
      setMemoryReviewMessage(t(memoryReviewActionMessage(action)));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemoryReviewingId("");
    }
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

  async function uploadAvatarFile(file: File | undefined): Promise<void> {
    if (!file || uploadingAvatar) {
      return;
    }
    setUploadingAvatar(true);
    try {
      setWorkspaceError("");
      const response = await uploadTeammateAvatar(cwd.trim(), teammate.id, file);
      onTeammateUpdated?.(response.teammate);
      void onRefreshTeammates?.();
      setSaveMessage(t("Saved"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function removeAvatar(): Promise<void> {
    if (uploadingAvatar) {
      return;
    }
    setUploadingAvatar(true);
    try {
      setWorkspaceError("");
      const response = await deleteTeammateAvatar(cwd.trim(), teammate.id);
      onTeammateUpdated?.(response?.teammate ?? { ...teammate, avatarImageAttachmentId: undefined });
      void onRefreshTeammates?.();
      setSaveMessage(t("Saved"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function hardDeleteTeammate(): Promise<void> {
    if (!onHardDeleteTeammate || hardDeleting) {
      return;
    }
    const confirmed = window.confirm(t("Hard delete this teammate's private data? This cannot be undone."));
    if (!confirmed) {
      return;
    }
    setHardDeleting(true);
    try {
      setWorkspaceError("");
      await onHardDeleteTeammate(teammate.id, hardDeleteReason);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setHardDeleting(false);
    }
  }

  async function createAssignedTask(input: Partial<TeammateTaskCreateForm> = {}): Promise<void> {
    const prompt = (input.prompt ?? taskForm.prompt).trim();
    if (!prompt || creatingTask) {
      return;
    }
    const channelId = resolvePreferredTaskChannelId(input.channelId ?? taskForm.channelId);
    if (!channelId) {
      setWorkspaceError(t("Select a channel before creating a task."));
      return;
    }

    setCreatingTask(true);
    try {
      setWorkspaceError("");
      setTaskMessage("");
      const title = (input.title ?? taskForm.title).trim() || titleFromPrompt(prompt);
      const requestedSkillId = input.requestedSkillId ?? taskForm.requestedSkillId;
      const response = await createTask(cwd.trim(), channelId, {
        title,
        prompt,
        assigneeTeammateId: teammate.id,
        requestedSkillId: requestedSkillId || undefined,
      });
      setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
      setTaskForm((current) => ({ ...current, title: "", prompt: "", channelId }));
      const activityResponse = await listTeammateActivity(cwd.trim(), teammate.id);
      setActivityItems(activityResponse.items);
      await onRefreshTasks?.(channelId);
      setTaskMessage(t("Task created for {name}", { name: teammate.displayName }));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingTask(false);
    }
  }

  async function createTaskFromMessage(message: TeammateDirectMessage): Promise<void> {
    await createAssignedTask({
      channelId: resolvePreferredTaskChannelId(taskForm.channelId),
      title: titleFromPrompt(message.body),
      prompt: message.body,
    });
  }

  async function saveChannelMemberships(
    nextMemberships: readonly { readonly channelId: string; readonly isDefault?: boolean }[],
  ): Promise<void> {
    setSavingChannels(true);
    try {
      setWorkspaceError("");
      setChannelMessage("");
      const response = await replaceTeammateChannels(cwd.trim(), teammate.id, nextMemberships);
      setMemberships(response.memberships);
      await onRefreshChannels?.();
      setChannelMessage(t("Saved"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingChannels(false);
    }
  }

  async function toggleChannelMembership(channelId: string): Promise<void> {
    const current = memberships.map((membership) => ({ channelId: membership.channelId, isDefault: membership.isDefault }));
    const existing = current.find((membership) => membership.channelId === channelId);
    const next = existing
      ? current.filter((membership) => membership.channelId !== channelId)
      : [...current, { channelId }];
    await saveChannelMemberships(next);
  }

  async function saveSettings(): Promise<void> {
    setSaving(true);
    try {
      setWorkspaceError("");
      setSaveMessage("");
      const updatedTeammate = await onUpdateTeammate(teammate.id, isProtectedSystemTeammate
        ? {
            displayName: settingsForm.displayName.trim() || teammate.displayName,
            description: settingsForm.description.trim(),
            appendSystemPrompt: splitAdditionalInstructions(settingsForm.appendSystemPromptText),
          }
        : {
            displayName: settingsForm.displayName.trim() || teammate.displayName,
            description: settingsForm.description.trim(),
            providerPresetId: settingsForm.providerPresetId || null,
            status: settingsForm.status,
            pinned: settingsForm.pinned,
            hidden: settingsForm.hidden,
            systemPrompt: settingsForm.systemPrompt.trim() || null,
          });
      setSettingsForm(teammateToSettingsForm(updatedTeammate));
      setSaveMessage(t("Saved"));
      void refreshDirectRuntime().catch(() => undefined);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function previewPersonaImport(): Promise<void> {
    if (!personaImportForm.content.trim() || importingPersona) {
      setSaveMessage(t("Paste persona content first"));
      return;
    }
    setImportingPersona(true);
    try {
      setWorkspaceError("");
      setSaveMessage("");
      const response = await createTeammatePersonaDraft(cwd.trim(), teammate.id, {
        content: personaImportForm.content,
        sourcePath: personaImportForm.sourcePath.trim() || undefined,
      });
      setPersonaDraft(response.draft);
      setSaveMessage(t("Draft ready"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingPersona(false);
    }
  }

  async function applyPersonaDraft(): Promise<void> {
    if (!personaDraft || importingPersona) {
      return;
    }
    setImportingPersona(true);
    try {
      setWorkspaceError("");
      setSaveMessage("");
      const updatedTeammate = await onUpdateTeammate(teammate.id, isProtectedSystemTeammate
        ? {
            displayName: personaDraft.displayName.trim() || teammate.displayName,
            description: personaDraft.description.trim(),
            appendSystemPrompt: personaDraft.appendSystemPrompt,
          }
        : {
            displayName: personaDraft.displayName.trim() || teammate.displayName,
            description: personaDraft.description.trim(),
            systemPrompt: personaDraft.systemPrompt.trim() || null,
            appendSystemPrompt: personaDraft.appendSystemPrompt,
          });
      setSettingsForm(teammateToSettingsForm(updatedTeammate));
      setPersonaDraft(undefined);
      setPersonaImportForm({ sourcePath: "", content: "" });
      setSaveMessage(t("Saved"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingPersona(false);
    }
  }

  async function saveSkillBindings(
    nextBindings: readonly { readonly skillId: string; readonly source?: TeammateSkillBinding["source"]; readonly enabled?: boolean }[],
    message: string,
  ): Promise<boolean> {
    if (savingSkills) {
      return false;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setWorkspaceError(t("Workspace path is required."));
      return false;
    }
    setSavingSkills(true);
    try {
      setWorkspaceError("");
      setSkillMessage("");
      const response = await replaceTeammateSkills(workspaceCwd, teammate.id, nextBindings);
      setSkillBindings(response.bindings);
      setEffectiveSkills(response.effectiveSkills ?? []);
      setSkillMessage(message);
      return true;
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSavingSkills(false);
    }
  }

  async function toggleSkillBinding(skillId: string): Promise<void> {
    const nextBindings = bindingBySkillId.has(skillId)
      ? skillBindings.map((binding) =>
        binding.skillId === skillId
          ? { skillId: binding.skillId, source: binding.source, enabled: !binding.enabled }
          : { skillId: binding.skillId, source: binding.source, enabled: binding.enabled },
      )
      : [
        ...skillBindings.map((binding) => ({ skillId: binding.skillId, source: binding.source, enabled: binding.enabled })),
        { skillId, source: "user" as const, enabled: true },
      ];
    await saveSkillBindings(nextBindings, t("Skills updated"));
  }

  async function addManualSkillBinding(): Promise<void> {
    const skillId = normalizeManualSkillId(manualSkillInput);
    if (!skillId) {
      setSkillMessage(t("Enter a skill id first"));
      return;
    }
    const existing = bindingBySkillId.get(skillId);
    if (existing?.enabled) {
      setSkillMessage(t("Skill already exists"));
      return;
    }
    const nextBindings = existing
      ? skillBindings.map((binding) =>
        binding.skillId === skillId
          ? { skillId: binding.skillId, source: binding.source, enabled: true }
          : { skillId: binding.skillId, source: binding.source, enabled: binding.enabled },
      )
      : [
        ...skillBindings.map((binding) => ({ skillId: binding.skillId, source: binding.source, enabled: binding.enabled })),
        { skillId, source: "user" as const, enabled: true },
      ];
    if (await saveSkillBindings(nextBindings, t("Skill added"))) {
      setManualSkillInput("");
    }
  }

  async function deleteUserSkillBinding(skillId: string): Promise<void> {
    const binding = bindingBySkillId.get(skillId);
    if (!binding || binding.source === "template") {
      setSkillMessage(t("Default skills cannot be deleted"));
      return;
    }
    const nextBindings = skillBindings
      .filter((item) => item.skillId !== skillId)
      .map((item) => ({ skillId: item.skillId, source: item.source, enabled: item.enabled }));
    await saveSkillBindings(nextBindings, t("Skill deleted"));
  }

  async function previewSkillImport(): Promise<void> {
    if (!skillImportForm.content.trim() || importingSkill) {
      setSkillMessage(t("Paste skill content first"));
      return;
    }
    setImportingSkill(true);
    try {
      setWorkspaceError("");
      setSkillMessage("");
      const response = await createSkillImportDraft(cwd.trim(), {
        content: skillImportForm.content,
        source: skillImportForm.source,
        sourcePath: skillImportForm.sourcePath.trim() || undefined,
        name: skillImportForm.name.trim() || undefined,
      });
      setSkillImportDraft(response.draft);
      setSkillMessage(t("Draft ready"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingSkill(false);
    }
  }

  async function publishSkillDraft(): Promise<void> {
    if (!skillImportDraft || importingSkill) {
      return;
    }
    setImportingSkill(true);
    try {
      setWorkspaceError("");
      const response = await publishSkillImportDraft(cwd.trim(), skillImportDraft.id);
      const registryResponse = await listSkills(cwd.trim());
      const skillResponse = await listTeammateSkills(cwd.trim(), teammate.id);
      setSkillRegistryEntries(registryResponse.skills);
      setSkillBindings(skillResponse.bindings);
      setEffectiveSkills(skillResponse.effectiveSkills ?? []);
      setSkillImportDraft(undefined);
      setSkillImportOpen(false);
      setSkillImportForm({ name: "", sourcePath: "", source: "custom", content: "" });
      setSkillMessage(t("Published {count} skills", { count: response.skills.length }));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingSkill(false);
    }
  }

  async function archiveCustomSkill(skillId: string): Promise<void> {
    if (savingSkills) {
      return;
    }
    setSavingSkills(true);
    try {
      setWorkspaceError("");
      await archiveSkill(cwd.trim(), skillId);
      const registryResponse = await listSkills(cwd.trim());
      setSkillRegistryEntries(registryResponse.skills);
      setSkillMessage(t("Skill archived"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingSkills(false);
    }
  }

  function toggleMcpTool(serverId: string, toolName: string): void {
    setMcpMessage("");
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
    setMcpMessage("");
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

  async function saveMcpBindings(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setWorkspaceError(t("Workspace path is required."));
      return;
    }
    setSavingMcp(true);
    try {
      setWorkspaceError("");
      setMcpMessage("");
      const response = await replaceTeammateMcpBindings(
        workspaceCwd,
        teammate.id,
        mcpBindings
          .filter((binding) => binding.enabled && (binding.mode === "all_current_tools" || binding.selectedToolNames.length > 0))
          .map((binding) => ({
            serverId: binding.serverId,
            mode: binding.mode,
            selectedToolNames: binding.mode === "selected" ? binding.selectedToolNames : undefined,
            approvalOverrides: binding.approvalOverrides,
            enabled: binding.enabled,
          })),
      );
      setMcpBindings(response.bindings);
      setMcpMessage(t("Saved"));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingMcp(false);
    }
  }

  function resolvePreferredTaskChannelId(channelId: string): string {
    if (channelId && channels.some((channel) => channel.id === channelId)) {
      return channelId;
    }
    return memberships.find((membership) => membership.isDefault)?.channelId ?? memberships[0]?.channelId ?? channels[0]?.id ?? "";
  }

  return (
    <div className={[
      "teammate-workspace",
      workspaceView === "settings" ? "settings-mode" : "chat-mode",
      onBackToWorkspaceTools ? "settings-return-mode" : "",
      workspaceView === "chat" && !chatContextPanelOpen ? "context-collapsed" : "",
    ].filter(Boolean).join(" ")}>
      {workspaceView === "chat" ? (
        <TeammateChatHeader
          cwd={cwd}
          teammate={teammate}
          providerReady={providerReady}
          memoryScopeCount={memoryScopes.length}
          attachmentCount={directAttachments.length}
          loading={loading}
          searchOpen={messageSearchOpen}
          searchQuery={messageSearchQuery}
          contextPanelOpen={chatContextPanelOpen}
          onToggleSearch={() => setMessageSearchOpen((current) => !current)}
          onSearchQueryChange={setMessageSearchQuery}
          onClearSearch={() => setMessageSearchQuery("")}
          onRefresh={refreshTeammateWorkspace}
          onOpenSettings={() => {
            setWorkspaceView("settings");
            setActiveTab("profile");
          }}
          onToggleContextPanel={() => setChatContextPanelOpen((current) => !current)}
          toolbarStart={onBackToWorkspaceTools ? <SettingsToolReturnRow onBack={onBackToWorkspaceTools} /> : undefined}
        />
      ) : (
        <section className={onBackToWorkspaceTools ? "teammate-settings-header settings-return-mode" : "teammate-settings-header"} aria-label={t("Single agent settings")}>
          {onBackToWorkspaceTools ? (
            <span className="teammate-settings-return-actions">
              <SettingsToolReturnRow onBack={onBackToWorkspaceTools} />
              <button className="secondary-button compact-button" type="button" onClick={() => setWorkspaceView("chat")}>
                <ArrowLeft size={15} />
                {t("Back to private chat")}
              </button>
            </span>
          ) : (
            <span className="teammate-settings-header-back-actions">
              <button className="secondary-button compact-button" type="button" onClick={() => setWorkspaceView("chat")}>
                <ArrowLeft size={15} />
                {t("Back to private chat")}
              </button>
            </span>
          )}
          {!onBackToWorkspaceTools ? (
            <div>
              <h2>{t("{name} settings", { name: teammate.displayName })}</h2>
              <p>{isProtectedSystemTeammate ? t("Built-in teammate profile and user-added instructions") : t("Single agent profile, permissions, and tool configuration")}</p>
            </div>
          ) : (
            <div className="teammate-settings-header-spacer" aria-hidden="true" />
          )}
          <div className="teammate-settings-header-actions">
            <button className="secondary-button compact-button" type="button" onClick={() => setSettingsForm(teammateToSettingsForm(teammate))}>
              {t("Reset")}
            </button>
            <button className="primary-button compact-button" type="button" onClick={() => void saveSettings()} disabled={saving}>
              {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              {t("Save")}
            </button>
          </div>
        </section>
      )}

      {workspaceError ? <div className="inline-error">{workspaceError}</div> : null}
      {loading ? (
        <div className="client-empty-state teammate-empty">
          <Loader2 className="spin" />
          <span>{t("Loading teammate workspace...")}</span>
        </div>
      ) : null}

      {workspaceView === "settings" ? (
        <nav className="teammate-settings-nav" aria-label={t("Settings sections")}>
          {settingsSections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`${activeTab === section.id ? "active" : ""}${section.danger ? " danger" : ""}`}
              onClick={() => setActiveTab(section.id)}
            >
              <span>{section.label}</span>
              {section.count !== undefined ? <small>{section.count}</small> : null}
            </button>
          ))}
        </nav>
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
          providerRecovered={providerRecovered}
          privateAttachmentById={privateAttachmentById}
          creatingTask={creatingTask}
          taskChannelOptions={taskChannelOptions}
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
          composerFileReferenceParts={composerFileReferenceParts}
          composerFileReferenceTokens={composerFileReferenceTokens}
          composerDragActive={composerDragActive}
          onPrivateFeedScroll={handlePrivateFeedScroll}
          onCancelPrivateFeedAutoFollow={cancelPrivateFeedAutoFollow}
          onScrollToLatest={scrollPrivateFeedToLatest}
          onCopyMessageText={copyMessageText}
          onOpenRun={onOpenRun}
          onCreateTaskFromMessage={createTaskFromMessage}
          onPromoteDirectGuidance={promoteDirectGuidance}
          onCancelDirectGuidance={cancelDirectGuidance}
          onEditDirectGuidance={editDirectGuidance}
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
        />
      ) : null}

      {workspaceView === "chat" && chatContextPanelOpen ? (
        <TeammateChatContextPanel
          cwd={cwd}
          lastAiMessage={lastAiMessage}
          directWorkspace={directWorkspace}
          directAttachments={directAttachments}
          recentUsedMemoryEvents={recentUsedMemoryEvents}
          recentMemoryObjects={recentMemoryObjects}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "tasks" ? (
        <TeammateTasksTab
          teammate={teammate}
          taskForm={taskForm}
          taskMessage={taskMessage}
          taskChannelOptions={taskChannelOptions}
          executableSkillOptions={executableSkillOptions}
          tasks={tasks}
          creatingTask={creatingTask}
          onTaskFormChange={setTaskForm}
          onCreateTask={createAssignedTask}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "activity" ? (
        <TeammateActivityTab activityItems={activityItems} />
      ) : null}

      {workspaceView === "settings" && activeTab === "model" ? (
        <TeammateModelTab
          providers={providers}
          settingsForm={settingsForm}
          settingsProvider={settingsProvider}
          settingsProviderReady={settingsProviderReady}
          isProtectedSystemTeammate={isProtectedSystemTeammate}
          saveMessage={saveMessage}
          saving={saving}
          onSettingsFormChange={setSettingsForm}
          onOpenProviders={onOpenProviders}
          onSaveSettings={saveSettings}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "permissions" ? (
        <TeammatePermissionsTab teammate={teammate} />
      ) : null}

      {workspaceView === "settings" && activeTab === "channels" ? (
        <TeammateChannelsTab
          channels={channels}
          membershipByChannelId={membershipByChannelId}
          membershipCount={effectiveMemberships.length}
          savingChannels={savingChannels}
          channelMessage={channelMessage}
          isProtectedSystemTeammate={isProtectedSystemTeammate}
          onToggleChannelMembership={toggleChannelMembership}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "skills" ? (
        <TeammateSkillsTab
          savingSkills={savingSkills}
          skillMessage={skillMessage}
          skillStats={skillStats}
          skillSearchQuery={skillSearchQuery}
          skillFilter={skillFilter}
          manualSkillInput={manualSkillInput}
          skillImportOpen={skillImportOpen}
          skillImportForm={skillImportForm}
          skillImportDraft={skillImportDraft}
          importingSkill={importingSkill}
          skillRows={skillRows}
          skillTableRows={skillTableRows}
          selectedSkillRow={selectedSkillRow}
          registryEntryBySkillId={registryEntryBySkillId}
          onSkillSearchQueryChange={setSkillSearchQuery}
          onSkillFilterChange={setSkillFilter}
          onManualSkillInputChange={setManualSkillInput}
          onSkillImportOpenChange={setSkillImportOpen}
          onSkillImportFormChange={setSkillImportForm}
          onAddManualSkillBinding={addManualSkillBinding}
          onPreviewSkillImport={previewSkillImport}
          onPublishSkillDraft={publishSkillDraft}
          onSelectSkill={setSelectedSkillId}
          onToggleSkillBinding={toggleSkillBinding}
          onDeleteUserSkillBinding={deleteUserSkillBinding}
          onArchiveCustomSkill={archiveCustomSkill}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "memory" ? (
        <TeammateMemoryTab
          teammate={teammate}
          channelsById={channelsById}
          isProtectedSystemTeammate={isProtectedSystemTeammate}
          loading={loading}
          memoryScopes={memoryScopes}
          memoryHealthReport={memoryHealthReport}
          memoryPromotionInbox={memoryPromotionInbox}
          memoryReviewPolicy={memoryReviewPolicy}
          memoryReviewMessage={memoryReviewMessage}
          memoryReviewingId={memoryReviewingId}
          memoryPolicySaving={memoryPolicySaving}
          memoryEditId={memoryEditId}
          memoryEditForm={memoryEditForm}
          memoryTransferBusy={memoryTransferBusy}
          memoryExportIncludeSecretAdjacent={memoryExportIncludeSecretAdjacent}
          memoryImportSourceLabel={memoryImportSourceLabel}
          memoryImportContent={memoryImportContent}
          memoryImportPlan={memoryImportPlan}
          onRefreshMemoryReviewData={refreshMemoryReviewData}
          onExportMemoryProjection={exportMemoryProjection}
          onMemoryExportIncludeSecretAdjacentChange={setMemoryExportIncludeSecretAdjacent}
          onMemoryImportSourceLabelChange={setMemoryImportSourceLabel}
          onLoadMemoryImportFile={loadMemoryImportFile}
          onMemoryImportContentChange={(value) => {
            setMemoryImportContent(value);
            setMemoryImportPlan(undefined);
          }}
          onPreviewMemoryImport={previewMemoryImport}
          onImportMemoryCandidates={importMemoryCandidates}
          onChangeMemoryReviewMode={changeMemoryReviewMode}
          onStartMemoryEdit={startMemoryEdit}
          onCancelMemoryEdit={() => setMemoryEditId("")}
          onMemoryEditFormChange={setMemoryEditForm}
          onApplyMemoryReview={applyMemoryReview}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "profile" ? (
        <TeammateProfileTab
          cwd={cwd}
          teammate={teammate}
          settingsForm={settingsForm}
          personaImportForm={personaImportForm}
          personaDraft={personaDraft}
          saveMessage={saveMessage}
          isProtectedSystemTeammate={isProtectedSystemTeammate}
          uploadingAvatar={uploadingAvatar}
          importingPersona={importingPersona}
          saving={saving}
          onSettingsFormChange={setSettingsForm}
          onPersonaImportFormChange={setPersonaImportForm}
          onUploadAvatarFile={uploadAvatarFile}
          onRemoveAvatar={removeAvatar}
          onPreviewPersonaImport={previewPersonaImport}
          onApplyPersonaDraft={applyPersonaDraft}
          onSaveSettings={saveSettings}
        />
      ) : null}

      {workspaceView === "settings" && activeTab === "danger" ? (
        <TeammateDangerTab
          teammate={teammate}
          hardDeleteReason={hardDeleteReason}
          hardDeleting={hardDeleting}
          canHardDelete={Boolean(onHardDeleteTeammate)}
          onHardDeleteReasonChange={setHardDeleteReason}
          onDisableTeammate={onDisableTeammate}
          onHardDeleteTeammate={hardDeleteTeammate}
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
          savingMcp={savingMcp}
          mcpMessage={mcpMessage}
          onSave={saveMcpBindings}
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
          settingsProvider={settingsProvider}
          channelCount={effectiveMemberships.length}
          executableSkillCount={skillStats.executable}
          memoryReady={memoryScopes.length > 0}
          mcpBindingCount={mcpBindings.length}
        />
      ) : null}
    </div>
  );
}
