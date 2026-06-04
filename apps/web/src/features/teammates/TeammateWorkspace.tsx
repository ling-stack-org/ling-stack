import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Hash,
  Image,
  Loader2,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import type { SkillPack } from "@ling-stack/core/skill-types";
import {
  archiveSkill,
  attachmentContentUrl,
  attachmentContentUrlById,
  createSkillImportDraft,
  createTask,
  createTeammatePersonaDraft,
  deleteAttachment,
  deleteTeammateAvatar,
  listMemoryObjects,
  listSkills,
  listTeammateActivity,
  listTeammateChannels,
  listTeammateDirectMessages,
  listTeammatePrivateAttachments,
  listUsedMemoryEvents,
  listMcpServers,
  listMcpTools,
  listTeammateMcpBindings,
  listTeammateMemoryScopes,
  listTeammateSkills,
  listTeammateTasks,
  publishSkillImportDraft,
  replaceTeammateChannels,
  replaceTeammateMcpBindings,
  replaceTeammateSkills,
  streamTeammateDirectMessage,
  uploadTeammateAvatar,
  uploadTeammatePrivateAttachment,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime, titleFromPrompt } from "../../lib/formatting.js";
import { providerPreflightReady } from "../../lib/providers.js";
import { readSseResponse } from "../../sse.js";
import {
  AvatarInitial,
  MetaRow,
  StatusBadge,
  UsedMemorySummary,
  filterUsedMemoryEventsByResponse,
} from "../../shared/components/index.js";
import type {
  AiTeammate,
  Channel,
  EffectiveTeammateSkill,
  MemoryObject,
  McpServer,
  McpTool,
  ProviderPreset,
  SkillImportDraft,
  SkillPackSource,
  SkillRegistryEntry,
  Task,
  TeammatePersonaDraft,
  TeammateActivityItem,
  TeammateChannelMembership,
  TeammateDirectMessage,
  TeammateDirectThread,
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
} from "../../types.js";
import { approvalProfileText, teammateInitialFromName, workflowPhaseLabel } from "./helpers.js";

type TeammateWorkspaceTab = "chat" | "tasks" | "activity" | "channels" | "skills" | "memory" | "settings" | "mcp";
type McpToolFilter = "all" | "authorized" | "read" | "write-or-external";

interface TeammateSettingsForm {
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId: string;
  readonly status: AiTeammate["status"];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly systemPrompt: string;
}

interface TeammateTaskCreateForm {
  readonly channelId: string;
  readonly requestedSkillId: string;
  readonly title: string;
  readonly prompt: string;
}

interface SkillImportForm {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: SkillPackSource;
  readonly content: string;
}

interface PersonaImportForm {
  readonly sourcePath: string;
  readonly content: string;
}

type MaybePromise<T> = T | Promise<T>;

export function TeammateWorkspace({
  cwd,
  teammate,
  providers,
  channels,
  skillPack,
  onUpdateTeammate,
  onDisableTeammate,
  onHardDeleteTeammate,
  onOpenProviders,
  onRefreshTeammates,
  onRefreshChannels,
  onRefreshTasks,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly skillPack: SkillPack | undefined;
  readonly onUpdateTeammate: (teammateId: string, input: UpdateAiTeammateRequest) => Promise<void>;
  readonly onDisableTeammate: (teammateId: string) => Promise<void>;
  readonly onHardDeleteTeammate?: (teammateId: string, reason?: string) => Promise<void>;
  readonly onOpenProviders: () => void;
  readonly onRefreshTeammates?: () => MaybePromise<void>;
  readonly onRefreshChannels?: () => MaybePromise<void>;
  readonly onRefreshTasks?: (channelId: string) => MaybePromise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<TeammateWorkspaceTab>("chat");
  const [thread, setThread] = useState<TeammateDirectThread | undefined>();
  const [messages, setMessages] = useState<readonly TeammateDirectMessage[]>([]);
  const [privateAttachments, setPrivateAttachments] = useState<readonly TeammatePrivateAttachment[]>([]);
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState<readonly string[]>([]);
  const [memberships, setMemberships] = useState<readonly TeammateChannelMembership[]>([]);
  const [skillRegistryEntries, setSkillRegistryEntries] = useState<readonly SkillRegistryEntry[]>([]);
  const [skillBindings, setSkillBindings] = useState<readonly TeammateSkillBinding[]>([]);
  const [effectiveSkills, setEffectiveSkills] = useState<readonly EffectiveTeammateSkill[]>([]);
  const [mcpServers, setMcpServers] = useState<readonly McpServer[]>([]);
  const [mcpTools, setMcpTools] = useState<readonly McpTool[]>([]);
  const [mcpBindings, setMcpBindings] = useState<readonly TeammateMcpBinding[]>([]);
  const [memoryScopes, setMemoryScopes] = useState<readonly TeammateMemoryScope[]>([]);
  const [memoryObjects, setMemoryObjects] = useState<readonly MemoryObject[]>([]);
  const [usedMemoryEvents, setUsedMemoryEvents] = useState<readonly UsedMemoryEvent[]>([]);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [activityItems, setActivityItems] = useState<readonly TeammateActivityItem[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [manualSkillInput, setManualSkillInput] = useState("");
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
  const [creatingTask, setCreatingTask] = useState(false);
  const [savingChannels, setSavingChannels] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);
  const [savingMcp, setSavingMcp] = useState(false);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
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
  const provider = teammate.providerPresetId ? providers.find((item) => item.id === teammate.providerPresetId) : undefined;
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
  const memoryById = useMemo(() => new Map(memoryObjects.map((memory) => [memory.id, memory])), [memoryObjects]);
  const privateAttachmentById = useMemo(() => new Map(privateAttachments.map((attachment) => [attachment.id, attachment])), [privateAttachments]);
  const pendingAttachments = useMemo(() => pendingAttachmentIds.map((id) => privateAttachmentById.get(id)).filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment)), [pendingAttachmentIds, privateAttachmentById]);
  const enabledSkillCount = useMemo(() => skillBindings.filter((binding) => binding.enabled).length, [skillBindings]);
  const skillRows = useMemo(() => {
    const registryRows = skillDefinitions.map((skill) => ({
      id: skill.id,
      skill,
      binding: bindingBySkillId.get(skill.id),
      effectiveSkill: effectiveSkillById.get(skill.id),
    }));
    const unknownRows = skillBindings
      .filter((binding) => !skillById.has(binding.skillId))
      .map((binding) => ({
        id: binding.skillId,
        skill: undefined,
        binding,
        effectiveSkill: effectiveSkillById.get(binding.skillId),
      }));
    return [...registryRows, ...unknownRows];
  }, [bindingBySkillId, effectiveSkillById, skillBindings, skillById, skillDefinitions]);
  const executableSkillOptions = useMemo(() => effectiveSkills.filter((skill) => skill.executable), [effectiveSkills]);
  const channelsById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const membershipByChannelId = useMemo(() => new Map(memberships.map((membership) => [membership.channelId, membership])), [memberships]);
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
    for (const membership of memberships) {
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
  }, [channels, channelsById, memberships]);
  const tabs: readonly { readonly id: TeammateWorkspaceTab; readonly label: string; readonly count?: number }[] = [
    { id: "chat", label: t("Private chat"), count: messages.length },
    { id: "tasks", label: t("Tasks"), count: tasks.length },
    { id: "activity", label: t("Activity"), count: activityItems.length },
    { id: "channels", label: t("Channels"), count: memberships.length },
    { id: "skills", label: t("Skills"), count: enabledSkillCount },
    { id: "memory", label: t("Memory"), count: memoryScopes.length },
    { id: "settings", label: t("Settings") },
    { id: "mcp", label: t("MCP") },
  ];

  useEffect(() => {
    setSettingsForm(teammateToSettingsForm(teammate));
  }, [teammate]);

  useEffect(() => {
    setSaveMessage("");
    setTaskMessage("");
    setChannelMessage("");
    setSkillMessage("");
    setMcpMessage("");
    setExpandedMcpServerIds(new Set());
    setMcpToolSearchByServerId({});
    setMcpToolFilterByServerId({});
    setManualSkillInput("");
    setPendingAttachmentIds([]);
    setHardDeleteReason("");
    setTaskForm({ channelId: "", requestedSkillId: "", title: "", prompt: "" });
    setSkillImportForm({ name: "", sourcePath: "", source: "custom", content: "" });
    setSkillImportDraft(undefined);
    setPersonaImportForm({ sourcePath: "", content: "" });
    setPersonaDraft(undefined);
  }, [teammate.id]);

  useEffect(() => {
    void refreshTeammateWorkspace();
  }, [cwd, teammate.id]);

  useEffect(() => {
    setTaskForm((current) => {
      const channelId = resolvePreferredTaskChannelId(current.channelId);
      return channelId === current.channelId ? current : { ...current, channelId };
    });
  }, [channels, memberships]);

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
        privateAttachmentsResponse,
        skillRegistryResponse,
        channelResponse,
        skillResponse,
        mcpServersResponse,
        mcpToolsResponse,
        mcpBindingsResponse,
        memoryResponse,
        memoryObjectsResponse,
        usedMemoryResponse,
        taskResponse,
        activityResponse,
      ] = await Promise.all([
        listTeammateDirectMessages(workspaceCwd, teammate.id),
        listTeammatePrivateAttachments(workspaceCwd, teammate.id),
        listSkills(workspaceCwd),
        listTeammateChannels(workspaceCwd, teammate.id),
        listTeammateSkills(workspaceCwd, teammate.id),
        listMcpServers(workspaceCwd),
        listMcpTools(workspaceCwd),
        listTeammateMcpBindings(workspaceCwd, teammate.id),
        listTeammateMemoryScopes(workspaceCwd, teammate.id),
        listMemoryObjects(workspaceCwd),
        listUsedMemoryEvents(workspaceCwd, { teammateId: teammate.id, limit: 100 }),
        listTeammateTasks(workspaceCwd, teammate.id),
        listTeammateActivity(workspaceCwd, teammate.id),
      ]);
      setThread(directResponse.thread);
      setMessages(directResponse.messages);
      setPrivateAttachments(privateAttachmentsResponse.attachments);
      setSkillRegistryEntries(skillRegistryResponse.skills);
      setMemberships(channelResponse.memberships);
      setSkillBindings(skillResponse.bindings);
      setEffectiveSkills(skillResponse.effectiveSkills ?? []);
      setMcpServers(mcpServersResponse.servers);
      setMcpTools(mcpToolsResponse.tools);
      setMcpBindings(mcpBindingsResponse.bindings);
      setMemoryScopes(memoryResponse.scopes);
      setMemoryObjects(memoryObjectsResponse.memories);
      setUsedMemoryEvents(usedMemoryResponse.events);
      setTasks(taskResponse.tasks);
      setActivityItems(activityResponse.items);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function sendPrivateMessage(): Promise<void> {
    const body = messageDraft.trim();
    const attachmentIds = pendingAttachmentIds;
    if ((!body && attachmentIds.length === 0) || sending) {
      return;
    }
    setSending(true);
    try {
      setWorkspaceError("");
      setMessageDraft("");
      setPendingAttachmentIds([]);
      const response = await streamTeammateDirectMessage(cwd.trim(), teammate.id, {
        body,
        attachmentIds,
        providerPresetId: teammate.providerPresetId,
      });
      await readSseResponse(response, (event) => {
        if (event.event === "ready") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamReadyEvent;
          setMessages((current) => upsertDirectMessages(current, [data.message, data.aiReply]));
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
          return;
        }
        if (event.event === "blocked") {
          const data = JSON.parse(event.data) as TeammateDirectMessageStreamBlockedEvent;
          setMessages((current) => upsertDirectMessages(current, [data.message, data.aiReply]));
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
        }
      });
      const [activityResponse, usedMemoryResponse, memoryObjectsResponse] = await Promise.all([
        listTeammateActivity(cwd.trim(), teammate.id),
        listUsedMemoryEvents(cwd.trim(), { teammateId: teammate.id, limit: 100 }),
        listMemoryObjects(cwd.trim()),
      ]);
      setActivityItems(activityResponse.items);
      setUsedMemoryEvents(usedMemoryResponse.events);
      setMemoryObjects(memoryObjectsResponse.memories);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  async function uploadPrivateFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0 || uploadingAttachments) {
      return;
    }
    setUploadingAttachments(true);
    try {
      setWorkspaceError("");
      const responses = await Promise.all(files.map((file) => uploadTeammatePrivateAttachment(cwd.trim(), teammate.id, file)));
      const uploaded = responses.map((response) => response.attachment);
      setPrivateAttachments((current) => [...uploaded, ...current.filter((attachment) => !uploaded.some((item) => item.id === attachment.id))]);
      setPendingAttachmentIds((current) => [...current, ...uploaded.map((attachment) => attachment.id)].slice(0, 10));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadingAttachments(false);
    }
  }

  async function removePendingAttachment(attachmentId: string): Promise<void> {
    setPendingAttachmentIds((current) => current.filter((id) => id !== attachmentId));
    try {
      await deleteAttachment(cwd.trim(), attachmentId);
      setPrivateAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }

  async function uploadAvatarFile(file: File | undefined): Promise<void> {
    if (!file || uploadingAvatar) {
      return;
    }
    setUploadingAvatar(true);
    try {
      setWorkspaceError("");
      await uploadTeammateAvatar(cwd.trim(), teammate.id, file);
      await onRefreshTeammates?.();
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
      await deleteTeammateAvatar(cwd.trim(), teammate.id);
      await onRefreshTeammates?.();
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
    setActiveTab("tasks");
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
      : [...current, { channelId, isDefault: current.length === 0 }];
    await saveChannelMemberships(next);
  }

  async function setDefaultChannel(channelId: string): Promise<void> {
    const current = memberships.map((membership) => ({ channelId: membership.channelId, isDefault: membership.isDefault }));
    const hasMembership = current.some((membership) => membership.channelId === channelId);
    const next = current.map((membership) => ({ ...membership, isDefault: membership.channelId === channelId }));
    if (!hasMembership) {
      next.push({ channelId, isDefault: true });
    }
    await saveChannelMemberships(next);
  }

  async function saveSettings(): Promise<void> {
    setSaving(true);
    try {
      setWorkspaceError("");
      await onUpdateTeammate(teammate.id, {
        displayName: settingsForm.displayName.trim() || teammate.displayName,
        description: settingsForm.description.trim(),
        providerPresetId: settingsForm.providerPresetId || null,
        status: settingsForm.status,
        pinned: settingsForm.pinned,
        hidden: settingsForm.hidden,
        systemPrompt: settingsForm.systemPrompt.trim() || null,
      });
      setSaveMessage(t("Saved"));
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
      await onUpdateTeammate(teammate.id, {
        displayName: personaDraft.displayName.trim() || teammate.displayName,
        description: personaDraft.description.trim(),
        systemPrompt: personaDraft.systemPrompt.trim() || null,
        appendSystemPrompt: personaDraft.appendSystemPrompt,
      });
      setSettingsForm((current) => ({
        ...current,
        displayName: personaDraft.displayName.trim() || current.displayName,
        description: personaDraft.description.trim(),
        systemPrompt: personaDraft.systemPrompt.trim(),
      }));
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
    <div className="teammate-workspace">
      <section className="teammate-workspace-hero" aria-label={t("AI teammate private workspace")}>
        <div className="teammate-workspace-identity">
          <TeammateAvatar teammate={teammate} cwd={cwd} />
          <div>
            <span className="teammate-pack-label">{t(`role.${teammate.roleKey}`)}</span>
            <h2>{teammate.displayName}</h2>
            <p>{teammate.description}</p>
          </div>
        </div>
        <div className="teammate-workspace-actions">
          <StatusBadge status={teammate.status} />
          <button className="secondary-button" type="button" onClick={() => void refreshTeammateWorkspace()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "spin" : undefined} />
            {t("Refresh")}
          </button>
        </div>
        <div className="teammate-workspace-meta">
          <MetaRow label={t("Provider")} value={provider ? provider.displayName : t("None")} compact />
          <MetaRow label={t("Model")} value={provider?.model ?? "-"} compact />
          <MetaRow label={t("Approval")} value={approvalProfileText(teammate.approvalProfile, t)} compact />
          <MetaRow label={t("Thread")} value={thread?.id ?? "-"} compact />
        </div>
        {provider && !providerPreflightReady(provider) ? (
          <div className="provider-run-notice">
            <ShieldCheck size={16} />
            <span>{t("Provider needs a successful check before reliable AI replies.")}</span>
          </div>
        ) : !provider ? (
          <div className="provider-run-notice neutral">
            <ShieldCheck size={16} />
            <span>{t("No provider is bound. Private chat will record messages but AI replies may be blocked.")}</span>
          </div>
        ) : null}
      </section>

      <div className="teammate-workspace-tabs" role="tablist" aria-label={t("AI teammate workspace tabs")}>
        {tabs.map((tab) => (
          <button key={tab.id} type="button" className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>
            {t(tab.label)}
            {tab.count !== undefined ? <span>{tab.count}</span> : null}
          </button>
        ))}
      </div>

      {workspaceError ? <div className="inline-error">{workspaceError}</div> : null}
      {loading ? (
        <div className="client-empty-state teammate-empty">
          <Loader2 className="spin" />
          <span>{t("Loading teammate workspace...")}</span>
        </div>
      ) : null}

      {activeTab === "chat" ? (
        <section className="teammate-private-chat" aria-label={t("Private chat")}>
          <div className="teammate-message-list">
            {messages.length === 0 ? (
              <div className="client-empty-state teammate-empty">
                <MessageSquare size={18} />
                <span>{t("No private messages yet")}</span>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`teammate-message-row ${message.authorType}`}>
                  {message.authorType === "ai-teammate" ? <TeammateAvatar teammate={teammate} cwd={cwd} compact /> : <AvatarInitial label="U" tone="gray" />}
                  <div>
                    <header>
                      <strong>{message.authorType === "ai-teammate" ? teammate.displayName : t("You")}</strong>
                      <time>{formatDateTime(message.createdAt)}</time>
                      <StatusBadge status={message.status} />
                    </header>
                    <p>{message.body}</p>
                    {message.attachmentIds.length > 0 ? (
                      <AttachmentChipList
                        attachments={message.attachmentIds.map((id) => privateAttachmentById.get(id)).filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment))}
                        cwd={cwd}
                      />
                    ) : null}
                    <UsedMemorySummary
                      compact
                      events={filterUsedMemoryEventsByResponse(usedMemoryEvents, message.id)}
                      memoryById={memoryById}
                    />
                    {message.errorMessage ? <small>{message.errorMessage}</small> : null}
                    <div className="teammate-message-actions">
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={() => void createTaskFromMessage(message)}
                        disabled={creatingTask || taskChannelOptions.length === 0}
                      >
                        {creatingTask ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                        {t("Create task")}
                      </button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
          <div className="teammate-chat-composer">
            {pendingAttachments.length > 0 ? (
              <div className="teammate-pending-attachments">
                {pendingAttachments.map((attachment) => (
                  <span key={attachment.id} className="teammate-attachment-chip">
                    <Paperclip size={13} />
                    <span>{attachment.fileName}</span>
                    <button type="button" onClick={() => void removePendingAttachment(attachment.id)} aria-label={t("Remove attachment")}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              rows={3}
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
              placeholder={t("Message this AI teammate privately")}
            />
            <div className="teammate-chat-composer-actions">
              <label className="secondary-button compact-button">
                {uploadingAttachments ? <Loader2 className="spin" size={14} /> : <Paperclip size={14} />}
                {t("Attach")}
                <input
                  type="file"
                  multiple
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    void uploadPrivateFiles(files);
                  }}
                />
              </label>
            <button className="primary-button" type="button" onClick={() => void sendPrivateMessage()} disabled={sending || (!messageDraft.trim() && pendingAttachmentIds.length === 0)}>
              {sending ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
              {sending ? t("Sending...") : t("Send")}
            </button>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "tasks" ? (
        <>
          <section className="teammate-list-panel teammate-task-create-panel" aria-label={t("New teammate task")}>
            <div className="panel-title split">
              <span>
                <SquareTerminal size={16} />
                <h2>{t("New teammate task")}</h2>
              </span>
              {taskMessage ? <small>{taskMessage}</small> : null}
            </div>
            <div className="teammate-task-create-grid">
              <label className="field">
                <span>{t("Task channel")}</span>
                <select
                  value={taskForm.channelId}
                  onChange={(event) => setTaskForm({ ...taskForm, channelId: event.target.value })}
                  disabled={taskChannelOptions.length === 0}
                >
                  {taskChannelOptions.length === 0 ? <option value="">{t("No channels available")}</option> : null}
                  {taskChannelOptions.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("Task title")}</span>
                <input value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} />
              </label>
              <label className="field">
                <span>{t("Requested skill")}</span>
                <select
                  value={taskForm.requestedSkillId}
                  onChange={(event) => setTaskForm({ ...taskForm, requestedSkillId: event.target.value })}
                >
                  <option value="">{t("None")}</option>
                  {executableSkillOptions.map((skill) => (
                    <option key={skill.skillId} value={skill.skillId}>
                      {t(skill.skill.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field wide">
                <span>{t("Task prompt")}</span>
                <textarea rows={5} value={taskForm.prompt} onChange={(event) => setTaskForm({ ...taskForm, prompt: event.target.value })} />
              </label>
            </div>
            <div className="teammate-task-create-footer">
              <span className="phase-token implement">{t("Assigned to {name}", { name: teammate.displayName })}</span>
              {taskForm.requestedSkillId ? <span className="phase-token plan">{t("Skill {skill}", { skill: taskForm.requestedSkillId })}</span> : null}
              <button className="primary-button" type="button" onClick={() => void createAssignedTask()} disabled={creatingTask || !taskForm.prompt.trim() || taskChannelOptions.length === 0}>
                {creatingTask ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
                {t("Create task")}
              </button>
            </div>
          </section>
          <TeammateListSection
            icon={<SquareTerminal size={16} />}
            title={t("Tasks")}
            emptyLabel={t("No tasks assigned to this teammate")}
            items={tasks}
            renderItem={(task) => (
              <article key={task.id} className="teammate-data-row">
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.prompt}</small>
                </span>
                <StatusBadge status={task.status} />
              </article>
            )}
          />
        </>
      ) : null}

      {activeTab === "activity" ? (
        <TeammateListSection
          icon={<Activity size={16} />}
          title={t("Activity")}
          emptyLabel={t("No teammate activity yet")}
          items={activityItems}
          renderItem={(item) => (
            <article key={item.id} className="teammate-data-row">
              <span>
                <strong>{item.title}</strong>
                <small>{item.subtitle ?? item.sourceId} · {formatDateTime(item.createdAt)}</small>
              </span>
              <StatusBadge status={item.status ?? item.kind} />
            </article>
          )}
        />
      ) : null}

      {activeTab === "channels" ? (
        <section className="teammate-list-panel teammate-channels-panel" aria-label={t("Channels")}>
          <div className="panel-title split">
            <span>
              <Hash size={16} />
              <h2>{t("Channels")}</h2>
            </span>
            <small>{savingChannels ? t("Saving...") : channelMessage || memberships.length}</small>
          </div>
          {channels.length === 0 ? (
            <div className="client-empty-state teammate-empty">
              <Hash size={18} />
              <span>{t("No channel memberships")}</span>
            </div>
          ) : (
            <div className="teammate-data-list">
              {channels.map((channel) => {
                const membership = membershipByChannelId.get(channel.id);
                const joined = Boolean(membership);
                const isDefault = Boolean(membership?.isDefault || channel.defaultTeammateId === teammate.id);
                return (
                  <article key={channel.id} className="teammate-data-row teammate-channel-row">
                    <span>
                      <strong>{channel.name}</strong>
                      <small>{isDefault ? t("Channel default") : joined ? t("Joined channel") : t("Not joined")}</small>
                    </span>
                    <div className="teammate-channel-actions">
                      <StatusBadge status={channel.status} />
                      <button className="secondary-button compact-button" type="button" onClick={() => void toggleChannelMembership(channel.id)} disabled={savingChannels}>
                        {joined ? <X size={14} /> : <Plus size={14} />}
                        {joined ? t("Leave") : t("Join")}
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => void setDefaultChannel(channel.id)} disabled={savingChannels || isDefault}>
                        <CheckCircle2 size={14} />
                        {isDefault ? t("Default teammate") : t("Set default")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "skills" ? (
        <section className="teammate-list-panel teammate-skills-panel" aria-label={t("Skills")}>
          <div className="panel-title split">
            <span>
              <Brain size={16} />
              <h2>{t("Skills")}</h2>
            </span>
            <small>{savingSkills ? t("Saving...") : skillMessage || t("{count} bound", { count: enabledSkillCount })}</small>
          </div>
          <div className="teammate-skill-add-row">
            <label className="field">
              <span>{t("Bind registry skill")}</span>
              <input
                value={manualSkillInput}
                onChange={(event) => setManualSkillInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addManualSkillBinding();
                  }
                }}
                placeholder={t("Skill id")}
              />
            </label>
            <button className="secondary-button" type="button" onClick={() => void addManualSkillBinding()} disabled={savingSkills}>
              <Plus size={15} />
              {t("Bind skill")}
            </button>
          </div>
          <div className="teammate-import-panel">
            <div className="panel-title split">
              <span>
                <Upload size={15} />
                <h3>{t("Import skill draft")}</h3>
              </span>
              {skillImportDraft ? <small>{t("{count} parsed", { count: skillImportDraft.definitions.length })}</small> : null}
            </div>
            <div className="teammate-task-create-grid">
              <label className="field">
                <span>{t("Source")}</span>
                <select value={skillImportForm.source} onChange={(event) => setSkillImportForm({ ...skillImportForm, source: event.target.value as SkillPackSource })}>
                  <option value="custom">{t("custom")}</option>
                  <option value="skill-directory">{t("skill-directory")}</option>
                  <option value="agents-md">{t("agents-md")}</option>
                  <option value="workspace">{t("workspace")}</option>
                </select>
              </label>
              <label className="field">
                <span>{t("Draft name")}</span>
                <input value={skillImportForm.name} onChange={(event) => setSkillImportForm({ ...skillImportForm, name: event.target.value })} />
              </label>
              <label className="field">
                <span>{t("Source path")}</span>
                <input value={skillImportForm.sourcePath} onChange={(event) => setSkillImportForm({ ...skillImportForm, sourcePath: event.target.value })} placeholder="SKILL.md" />
              </label>
              <label className="field wide">
                <span>{t("Skill content")}</span>
                <textarea rows={5} value={skillImportForm.content} onChange={(event) => setSkillImportForm({ ...skillImportForm, content: event.target.value })} />
              </label>
            </div>
            {skillImportDraft ? (
              <div className="teammate-import-preview">
                {skillImportDraft.definitions.map((item) => (
                  <article key={item.definition.id} className="teammate-data-row">
                    <span>
                      <strong>{item.definition.name}</strong>
                      <small>{item.definition.id} · {item.definition.summary}</small>
                    </span>
                    <StatusBadge status={item.warnings?.some((warning) => warning.severity === "error") ? "blocked" : "draft"} />
                  </article>
                ))}
                {[...skillImportDraft.warnings, ...skillImportDraft.definitions.flatMap((item) => item.warnings ?? [])].map((warning, index) => (
                  <small key={`${warning.code}-${index}`} className={`teammate-warning ${warning.severity}`}>{t(warning.code)}: {warning.message}</small>
                ))}
              </div>
            ) : null}
            <div className="teammate-settings-actions">
              <button className="secondary-button" type="button" onClick={() => void previewSkillImport()} disabled={importingSkill || !skillImportForm.content.trim()}>
                {importingSkill ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
                {t("Preview draft")}
              </button>
              <button className="primary-button" type="button" onClick={() => void publishSkillDraft()} disabled={importingSkill || !skillImportDraft || skillImportDraft.warnings.some((warning) => warning.severity === "error") || skillImportDraft.definitions.some((item) => item.warnings?.some((warning) => warning.severity === "error"))}>
                <CheckCircle2 size={15} />
                {t("Publish to registry")}
              </button>
            </div>
          </div>
          {skillRows.length === 0 ? (
            <div className="client-empty-state teammate-empty">
              <Brain size={18} />
              <span>{t("No skills bound to this teammate")}</span>
            </div>
          ) : (
            <div className="teammate-data-list">
              {skillRows.map(({ id, skill, binding, effectiveSkill }) => {
                const enabled = Boolean(binding?.enabled);
                const sourceLabel = binding
                  ? binding.source === "template"
                    ? t("Default skill")
                    : t("User skill")
                  : registryEntryBySkillId.get(id)?.source === "builtin"
                    ? t("Available skill")
                    : t("Registry skill");
                const canDelete = binding?.source === "user";
                const canArchive = !binding && registryEntryBySkillId.has(id) && registryEntryBySkillId.get(id)?.source !== "builtin";
                const executable = effectiveSkill?.executable ?? false;
                const blockedLabel = effectiveSkill?.blockedReasons.map((reason) => t(reason.code)).join(", ");
                return (
                  <article key={id} className={`teammate-data-row teammate-skill-row ${enabled ? "enabled" : ""} ${executable ? "executable" : "blocked"}`}>
                    <span>
                      <strong>{skill ? t(skill.name) : id}</strong>
                      <small>{blockedLabel || (skill ? t(skill.summary) : t("Custom skill binding"))}</small>
                    </span>
                    <div className="teammate-skill-actions">
                      <StatusBadge status={executable ? "executable" : enabled ? "blocked" : "disabled"} />
                      <span className="skill-binding-source">{sourceLabel}</span>
                      <span className={`phase-token ${skill?.workflowPhase ?? "operate"}`}>{skill ? workflowPhaseLabel(skill.workflowPhase, t) : t("Custom")}</span>
                      <button className="secondary-button compact-button" type="button" onClick={() => void toggleSkillBinding(id)} disabled={savingSkills}>
                        {enabled ? <X size={14} /> : <Plus size={14} />}
                        {binding ? enabled ? t("Disable skill") : t("Enable skill") : t("Bind skill")}
                      </button>
                      {canDelete ? (
                        <button className="secondary-button danger compact-button" type="button" onClick={() => void deleteUserSkillBinding(id)} disabled={savingSkills}>
                          <Trash2 size={14} />
                          {t("Delete skill")}
                        </button>
                      ) : null}
                      {canArchive ? (
                        <button className="secondary-button danger compact-button" type="button" onClick={() => void archiveCustomSkill(id)} disabled={savingSkills}>
                          <Trash2 size={14} />
                          {t("Archive skill")}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "memory" ? (
        <section className="teammate-list-panel teammate-memory-panel" aria-label={t("Memory")}>
          <div className="panel-title split">
            <span>
              <Bot size={16} />
              <h2>{t("Memory")}</h2>
            </span>
            <small>{memoryScopes.length}</small>
          </div>
          <article className="teammate-data-row">
            <span>
              <strong>{t("Vector retrieval")}</strong>
              <small>{t("Not installed / Optional")}</small>
            </span>
            <StatusBadge status="optional" />
          </article>
          {memoryScopes.length === 0 ? (
            <div className="client-empty-state teammate-empty">
              <Bot size={18} />
              <span>{t("No memory scopes enabled")}</span>
            </div>
          ) : (
            <div className="teammate-data-list">
              {memoryScopes.map((scope) => (
                <article key={scope.id} className="teammate-data-row">
                  <span>
                    <strong>{t(scope.kind)}</strong>
                    <small>{scope.channelId ? channelsById.get(scope.channelId)?.name ?? scope.channelId : t("Private workspace")}</small>
                  </span>
                  <StatusBadge status={scope.enabled ? "active" : "paused"} />
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "settings" ? (
        <section className="teammate-settings-panel" aria-label={t("Teammate settings")}>
          <div className="panel-title split">
            <span>
              <Settings size={16} />
              <h2>{t("Settings")}</h2>
            </span>
            {saveMessage ? <small>{saveMessage}</small> : null}
          </div>
          <section className="teammate-avatar-settings" aria-label={t("Avatar")}>
            <div className="teammate-avatar-preview compact-preview">
              <TeammateAvatar teammate={teammate} cwd={cwd} />
              <span>{teammate.displayName}</span>
            </div>
            <div className="teammate-avatar-actions">
              <label className="secondary-button">
                {uploadingAvatar ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
                {t("Upload avatar")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void uploadAvatarFile(file);
                  }}
                />
              </label>
              <button className="secondary-button compact-button" type="button" onClick={() => void removeAvatar()} disabled={uploadingAvatar || !teammate.avatarImageAttachmentId}>
                <Image size={14} />
                {t("Remove avatar")}
              </button>
            </div>
          </section>
          <section className="teammate-import-panel" aria-label={t("Persona import")}>
            <div className="panel-title split">
              <span>
                <Upload size={15} />
                <h3>{t("Persona import")}</h3>
              </span>
              {personaDraft ? <small>{t("Draft ready")}</small> : null}
            </div>
            <div className="teammate-task-create-grid">
              <label className="field">
                <span>{t("Source path")}</span>
                <input value={personaImportForm.sourcePath} onChange={(event) => setPersonaImportForm({ ...personaImportForm, sourcePath: event.target.value })} placeholder="AGENTS.md" />
              </label>
              <label className="field wide">
                <span>{t("Persona content")}</span>
                <textarea rows={5} value={personaImportForm.content} onChange={(event) => setPersonaImportForm({ ...personaImportForm, content: event.target.value })} />
              </label>
            </div>
            {personaDraft ? (
              <div className="teammate-import-preview">
                <article className="teammate-data-row">
                  <span>
                    <strong>{personaDraft.displayName}</strong>
                    <small>{personaDraft.description}</small>
                  </span>
                  <StatusBadge status={personaDraft.sourceKind} />
                </article>
                {personaDraft.warnings.map((warning, index) => (
                  <small key={`${warning}-${index}`} className="teammate-warning warning">{warning}</small>
                ))}
              </div>
            ) : null}
            <div className="teammate-settings-actions">
              <button className="secondary-button" type="button" onClick={() => void previewPersonaImport()} disabled={importingPersona || !personaImportForm.content.trim()}>
                {importingPersona ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
                {t("Preview draft")}
              </button>
              <button className="primary-button" type="button" onClick={() => void applyPersonaDraft()} disabled={importingPersona || !personaDraft}>
                <CheckCircle2 size={15} />
                {t("Apply persona draft")}
              </button>
            </div>
          </section>
          <div className="teammate-settings-grid">
            <label className="field">
              <span>{t("Teammate name")}</span>
              <input value={settingsForm.displayName} onChange={(event) => setSettingsForm({ ...settingsForm, displayName: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("Provider")}</span>
              <select value={settingsForm.providerPresetId} onChange={(event) => setSettingsForm({ ...settingsForm, providerPresetId: event.target.value })}>
                <option value="">{t("None")}</option>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName} / {item.model}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("Status")}</span>
              <select value={settingsForm.status} onChange={(event) => setSettingsForm({ ...settingsForm, status: event.target.value as AiTeammate["status"] })}>
                <option value="active">{t("active")}</option>
                <option value="paused">{t("paused")}</option>
                <option value="disabled">{t("disabled")}</option>
              </select>
            </label>
            <label className="teammate-toggle inline-toggle">
              <input type="checkbox" checked={settingsForm.pinned} onChange={(event) => setSettingsForm({ ...settingsForm, pinned: event.target.checked })} />
              <Bot size={15} />
              <span>
                <strong>{t("Pinned in sidebar")}</strong>
                <small>{t("Keep this teammate near the top of the workspace roster.")}</small>
              </span>
            </label>
            <label className="teammate-toggle inline-toggle">
              <input type="checkbox" checked={settingsForm.hidden} onChange={(event) => setSettingsForm({ ...settingsForm, hidden: event.target.checked })} />
              <Bot size={15} />
              <span>
                <strong>{t("Hidden from sidebar")}</strong>
                <small>{t("The teammate remains durable and can be restored later.")}</small>
              </span>
            </label>
            <label className="field wide">
              <span>{t("Description")}</span>
              <textarea rows={3} value={settingsForm.description} onChange={(event) => setSettingsForm({ ...settingsForm, description: event.target.value })} />
            </label>
            <label className="field wide">
              <span>{t("System prompt")}</span>
              <textarea rows={5} value={settingsForm.systemPrompt} onChange={(event) => setSettingsForm({ ...settingsForm, systemPrompt: event.target.value })} />
            </label>
          </div>
          <div className="teammate-settings-actions">
            <button className="secondary-button" type="button" onClick={onOpenProviders}>
              <ShieldCheck size={15} />
              {t("Model Workbench")}
            </button>
            <button className="secondary-button danger" type="button" onClick={() => void onDisableTeammate(teammate.id)}>
              {t("Disable")}
            </button>
            <button className="primary-button" type="button" onClick={() => void saveSettings()} disabled={saving}>
              {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              {t("Save")}
            </button>
          </div>
          <section className="teammate-danger-zone" aria-label={t("Danger zone")}>
            <span>
              <strong>{t("Hard delete private data")}</strong>
              <small>{t("Deletes private chat, private attachments, avatar, teammate memory, and private bindings. Channel and run history keep a deleted teammate reference.")}</small>
            </span>
            <input
              value={hardDeleteReason}
              onChange={(event) => setHardDeleteReason(event.target.value)}
              placeholder={t("Reason")}
            />
            <button className="secondary-button danger" type="button" onClick={() => void hardDeleteTeammate()} disabled={hardDeleting || !onHardDeleteTeammate}>
              {hardDeleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
              {t("Hard delete")}
            </button>
          </section>
        </section>
      ) : null}

      {activeTab === "mcp" ? (
        <section className="teammate-mcp-panel" aria-label={t("MCP tool authorization")}>
          <div className="teammate-mcp-toolbar">
            <div className="panel-title">
              <span>
                <Wrench size={16} />
                <h2>{t("MCP tool authorization")}</h2>
              </span>
            </div>
            <span className="teammate-mcp-save-status">{savingMcp ? t("Saving...") : mcpMessage || t("Explicit assignment only")}</span>
            <button className="secondary-button compact-button" type="button" onClick={() => void saveMcpBindings()} disabled={savingMcp || mcpServers.length === 0}>
              {savingMcp ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              {t("Update MCP authorization")}
            </button>
          </div>
          <p className="teammate-mcp-note">{t("Only authorize MCP tools this teammate actually needs.")}</p>
          {mcpServers.length === 0 ? (
            <div className="client-empty-state teammate-empty">
              <Wrench size={18} />
              <span>{t("No MCP servers configured")}</span>
            </div>
          ) : (
            <div className="teammate-mcp-server-list">
              {mcpServers.map((server) => {
                const serverTools = mcpToolsByServerId.get(server.id) ?? [];
                const binding = mcpBindingByServerId.get(server.id);
                const selectedTools = new Set(binding?.mode === "all_current_tools"
                  ? serverTools.map((tool) => tool.rawName)
                  : binding?.selectedToolNames ?? []);
                const expanded = expandedMcpServerIds.has(server.id);
                const searchQuery = mcpToolSearchByServerId[server.id] ?? "";
                const toolFilter = mcpToolFilterByServerId[server.id] ?? "all";
                const filteredTools = filterMcpTools(serverTools, selectedTools, searchQuery, toolFilter);
                const allToolNames = serverTools.map((tool) => tool.rawName);
                return (
                  <article key={server.id} className={expanded ? "teammate-mcp-server-row expanded" : "teammate-mcp-server-row"}>
                    <header className="teammate-mcp-server-header">
                      <span className="teammate-mcp-server-title">
                        <Wrench size={15} />
                        <span>
                          <strong>{server.displayName}</strong>
                          <small>{server.enabled ? t("Enabled") : t("Disabled")} · {server.status.kind === "ready" ? t("Ready") : t("Not ready")}</small>
                        </span>
                      </span>
                      <span className="teammate-mcp-server-summary">
                        <StatusBadge status={server.status.kind} />
                        <span className="status-badge neutral">{t("{count} tools", { count: serverTools.length })}</span>
                        <span className="status-badge neutral">{t("{count} authorized", { count: selectedTools.size })}</span>
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={() => setMcpServerSelectedTools(server.id, allToolNames)}
                          disabled={savingMcp || !server.enabled || allToolNames.length === 0 || selectedTools.size === allToolNames.length}
                        >
                          {t("Select all current MCP")}
                        </button>
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={() => setMcpServerSelectedTools(server.id, [])}
                          disabled={savingMcp || selectedTools.size === 0}
                        >
                          {t("Clear authorization")}
                        </button>
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => toggleMcpServerExpanded(server.id)}
                          disabled={serverTools.length === 0}
                        >
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {expanded ? t("Hide tools") : t("Show tools")}
                        </button>
                      </span>
                    </header>
                    {serverTools.length === 0 ? (
                      <small className="teammate-mcp-inline-hint">{t("No tools discovered yet. Sync tools from Tool Access first.")}</small>
                    ) : null}
                    {expanded && serverTools.length > 0 ? (
                      <div className="teammate-mcp-tool-tree">
                        <div className="teammate-mcp-tool-controls">
                          <label className="field teammate-mcp-search">
                            <span>{t("Search tools")}</span>
                            <span className="teammate-mcp-search-input">
                              <Search size={14} />
                              <input
                                aria-label={t("Search tools")}
                                value={searchQuery}
                                onChange={(event) => updateMcpToolSearch(server.id, event.target.value)}
                                placeholder={t("Search tools")}
                              />
                            </span>
                          </label>
                          <div className="teammate-mcp-filter-tabs" role="group" aria-label={t("MCP tool filters")}>
                            {(["all", "authorized", "read", "write-or-external"] as const).map((filter) => (
                              <button
                                key={filter}
                                type="button"
                                className={toolFilter === filter ? "active" : ""}
                                onClick={() => updateMcpToolFilter(server.id, filter)}
                              >
                                {mcpToolFilterLabel(filter, t)}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="teammate-mcp-tool-list">
                          {filteredTools.length === 0 ? (
                            <div className="client-empty-state teammate-empty compact">
                              <span>{t("No tools match filters")}</span>
                            </div>
                          ) : null}
                          {filteredTools.map((tool) => {
                            const toolLabel = tool.displayName || tool.rawName;
                            return (
                              <label
                                key={`${tool.serverId}:${tool.rawName}`}
                                className={selectedTools.has(tool.rawName) ? "teammate-mcp-tool-row selected" : "teammate-mcp-tool-row"}
                              >
                                <span className="teammate-mcp-tool-check">
                                  <input
                                    type="checkbox"
                                    aria-label={toolLabel}
                                    checked={selectedTools.has(tool.rawName)}
                                    onChange={() => toggleMcpTool(server.id, tool.rawName)}
                                    disabled={savingMcp || !server.enabled}
                                  />
                                  <span className="teammate-mcp-tool-check-visual" aria-hidden="true" />
                                </span>
                                <span className="teammate-mcp-tool-name">
                                  <strong>{toolLabel}</strong>
                                </span>
                                <span className="status-badge neutral teammate-mcp-effect">{mcpToolEffectLabel(tool.sideEffectLevel, t)}</span>
                                <small className="teammate-mcp-tool-description">{tool.description || tool.rawName}</small>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function TeammateListSection<T>({
  icon,
  title,
  emptyLabel,
  items,
  renderItem,
}: {
  readonly icon: JSX.Element;
  readonly title: string;
  readonly emptyLabel: string;
  readonly items: readonly T[];
  readonly renderItem: (item: T) => JSX.Element;
}): JSX.Element {
  return (
    <section className="teammate-list-panel">
      <div className="panel-title split">
        <span>
          {icon}
          <h2>{title}</h2>
        </span>
        <small>{items.length}</small>
      </div>
      {items.length === 0 ? (
        <div className="client-empty-state teammate-empty">
          {icon}
          <span>{emptyLabel}</span>
        </div>
      ) : (
        <div className="teammate-data-list">{items.map(renderItem)}</div>
      )}
    </section>
  );
}

function filterMcpTools(
  tools: readonly McpTool[],
  selectedTools: ReadonlySet<string>,
  searchQuery: string,
  filter: McpToolFilter,
): readonly McpTool[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  return tools.filter((tool) => {
    if (filter === "authorized" && !selectedTools.has(tool.rawName)) {
      return false;
    }
    if (filter === "read" && tool.sideEffectLevel !== "read" && tool.sideEffectLevel !== "none") {
      return false;
    }
    if (filter === "write-or-external" && !isWriteOrExternalMcpTool(tool.sideEffectLevel)) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    const searchable = [
      tool.rawName,
      tool.displayName,
      tool.description ?? "",
      tool.callableName,
    ].join(" ").toLowerCase();
    return searchable.includes(normalizedQuery);
  });
}

function isWriteOrExternalMcpTool(sideEffectLevel: McpTool["sideEffectLevel"]): boolean {
  return sideEffectLevel === "write" ||
    sideEffectLevel === "write-network" ||
    sideEffectLevel === "external" ||
    sideEffectLevel === "credential" ||
    sideEffectLevel === "deploy";
}

function mcpToolFilterLabel(filter: McpToolFilter, t: (key: string) => string): string {
  if (filter === "authorized") {
    return t("Authorized");
  }
  if (filter === "read") {
    return t("Read tools");
  }
  if (filter === "write-or-external") {
    return t("Write or external actions");
  }
  return t("All");
}

function mcpToolEffectLabel(sideEffectLevel: McpTool["sideEffectLevel"], t: (key: string) => string): string {
  if (sideEffectLevel === "none") {
    return t("No side effects");
  }
  if (sideEffectLevel === "read") {
    return t("Read");
  }
  if (sideEffectLevel === "write") {
    return t("Write");
  }
  if (sideEffectLevel === "write-network") {
    return t("Write network");
  }
  if (sideEffectLevel === "external") {
    return t("External action");
  }
  if (sideEffectLevel === "credential") {
    return t("Credential");
  }
  if (sideEffectLevel === "deploy") {
    return t("Deploy");
  }
  return sideEffectLevel;
}

function normalizeManualSkillId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const urlSkillId = parseSkillIdFromUrl(trimmed);
  const candidate = urlSkillId || trimmed;
  return candidate
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function parseSkillIdFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return [url.hostname, ...segments.slice(-2)].join("/");
  } catch {
    return "";
  }
}

function teammateToSettingsForm(teammate: AiTeammate): TeammateSettingsForm {
  return {
    displayName: teammate.displayName,
    description: teammate.description,
    providerPresetId: teammate.providerPresetId ?? "",
    status: teammate.status,
    pinned: teammate.pinned,
    hidden: teammate.hidden,
    systemPrompt: teammate.systemPrompt ?? "",
  };
}

function upsertDirectMessages(
  current: readonly TeammateDirectMessage[],
  nextMessages: readonly TeammateDirectMessage[],
): readonly TeammateDirectMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of nextMessages) {
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function TeammateAvatar({ teammate, cwd, compact = false }: { readonly teammate: AiTeammate; readonly cwd: string; readonly compact?: boolean }): JSX.Element {
  if (teammate.avatarImageAttachmentId) {
    return (
      <img
        className={`teammate-avatar-image ${compact ? "compact" : ""}`}
        src={attachmentContentUrlById(teammate.avatarImageAttachmentId, cwd.trim())}
        alt=""
      />
    );
  }
  return <AvatarInitial label={teammateInitialFromName(teammate.displayName)} tone={teammateAvatarTone(teammate)} />;
}

function AttachmentChipList({ attachments, cwd }: { readonly attachments: readonly TeammatePrivateAttachment[]; readonly cwd: string }): JSX.Element | null {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="teammate-message-attachments">
      {attachments.map((attachment) => (
        <a key={attachment.id} className="teammate-attachment-chip" href={attachmentContentUrl(attachment, cwd.trim())} target="_blank" rel="noreferrer">
          <Paperclip size={13} />
          <span>{attachment.fileName}</span>
        </a>
      ))}
    </div>
  );
}

function teammateAvatarTone(teammate: AiTeammate): "default" | "orange" | "teal" | "violet" | "blue" | "rose" | "gray" {
  if (
    teammate.avatarTone === "default" ||
    teammate.avatarTone === "orange" ||
    teammate.avatarTone === "teal" ||
    teammate.avatarTone === "violet" ||
    teammate.avatarTone === "blue" ||
    teammate.avatarTone === "rose" ||
    teammate.avatarTone === "gray"
  ) {
    return teammate.avatarTone;
  }
  if (teammate.roleKey === "product" || teammate.roleKey === "release") {
    return "orange";
  }
  if (teammate.roleKey === "engineer" || teammate.roleKey === "architect") {
    return "teal";
  }
  if (teammate.roleKey === "designer" || teammate.roleKey === "docs") {
    return "violet";
  }
  if (teammate.roleKey === "qa") {
    return "blue";
  }
  if (teammate.roleKey === "security") {
    return "rose";
  }
  return "default";
}
