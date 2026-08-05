import type { Dispatch, SetStateAction } from "react";
import {
  createChannel,
  createChannelContextSummary,
  createChannelDecision,
  createChannelHandoff,
  createChannelLinkPreview,
  createChannelWorkflowFromHandoff,
  createTask,
  deleteChannelAttachment,
  streamChannelMessage,
  updateChannel,
  updateChannelBrief,
  updateChannelCollaborationProtocol,
  updateChannelDecision,
  updateChannelHandoff,
  uploadChannelAttachment,
  revertChannelCollaborationProtocol,
} from "../api.js";
import {
  channelFormPersistenceKey,
  channelToForm,
  defaultChannelCreateForm,
  defaultChannelEditForm,
} from "../lib/channels.js";
import type { ChannelActivityTriageDraft, ChannelActivityTriageResult } from "../lib/channel-activity-triage.js";
import { titleFromPrompt } from "../lib/formatting.js";
import { canUseConversationProvider, providerEffectiveBaseUrl, providerPreflightReady } from "../lib/providers.js";
import { defaultTools } from "../lib/tools.js";
import { readSseResponse } from "../sse.js";
import type {
  AiTeammate,
  Channel,
  ChannelAttachment,
  ChannelBrief,
  ChannelBranch,
  ChannelCollaborationProtocolResponse,
  ChannelContextSummary,
  ChannelCreateFormState,
  ChannelDecision,
  ChannelExecutionProposal,
  ChannelFormState,
  ChannelHandoff,
  ChannelHandoffStatus,
  ChannelLinkPreview,
  ChannelMessage,
  ChannelMessageFileRef,
  ChannelMessageStreamBlockedEvent,
  ChannelMessageStreamDeltaEvent,
  ChannelMessageStreamDoneEvent,
  ChannelMessageStreamErrorEvent,
  ChannelMessageStreamReadyEvent,
  ChannelMessageStreamRunLinkedEvent,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ProviderPreset,
  ProviderTemplate,
  RunFormState,
  Task,
  TaskFormState,
  UpdateChannelBriefRequest,
  UpdateChannelCollaborationProtocolRequest,
} from "../types.js";
import { channelSidebarTarget, type SidebarTarget, type ViewId } from "./view-types.js";
import {
  buildContextTaskPrompt,
  splitTextLines,
  upsertChannelMessages,
} from "./app-shell-selectors.js";
import { defaultTaskForm } from "../domains/workspace/use-workspace-domain.js";
import {
  archiveSidebarChannelBranchWithState,
  archiveSidebarChannelWithState,
  createSidebarChannelBranchWithState,
  removeSidebarChannelWithState,
} from "./channel-sidebar-archive-actions.js";

export interface ChannelActionsController {
  readonly saveChannel: () => Promise<void>;
  readonly saveDefaultChannel: () => Promise<void>;
  readonly saveChannelEdit: (channelId: string, formOverride?: ChannelFormState) => Promise<void>;
  readonly saveChannelBranch: (channelId: string, name: string) => Promise<void>;
  readonly archiveSidebarChannel: (channelId: string) => Promise<void>;
  readonly archiveSidebarChannelBranch: (channelId: string, branchId: string) => Promise<void>;
  readonly removeChannel: (channelId: string) => Promise<void>;
  readonly saveTask: () => Promise<boolean>;
  readonly createTaskFromSlashCommand: (input: CreateTaskFromSlashCommandInput) => Promise<void>;
  readonly sendChannelMessage: (input: SendChannelMessageInput) => Promise<ChannelMessageSendResult>;
  readonly uploadChannelFiles: (files: readonly File[]) => Promise<readonly ChannelAttachment[]>;
  readonly addChannelLinkPreview: (url: string) => Promise<ChannelLinkPreview | undefined>;
  readonly removeChannelAttachment: (attachmentId: string) => Promise<void>;
  readonly saveChannelBrief: (input: UpdateChannelBriefRequest) => Promise<void>;
  readonly saveChannelProtocolPatch: (
    input: UpdateChannelCollaborationProtocolRequest,
  ) => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly revertChannelProtocolSettings: () => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly supersedeChannelDecision: (decision: ChannelDecision) => Promise<void>;
  readonly rejectChannelDecision: (decision: ChannelDecision) => Promise<void>;
  readonly createHandoffFromTask: (task: Task) => Promise<ChannelHandoff | undefined>;
  readonly updateHandoffStatusValue: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => Promise<void>;
  readonly startWorkflowFromHandoff: (handoff: ChannelHandoff) => Promise<void>;
  readonly createTaskFromContextSummary: (summary: ChannelContextSummary) => Promise<void>;
  readonly runActivityTriageAction: (draft: ChannelActivityTriageDraft) => Promise<ChannelActivityTriageResult>;
}

export interface ChannelMessageSendResult {
  readonly errorMessage?: string;
}

type ChannelActionFeedbackSurface = "create-dialog" | "workspace" | "composer" | "task" | "workflow" | "protocol" | "dock" | "sidebar";
type ChannelActionFeedbackScope = "validation" | "mutation" | "stream";

interface ChannelActionFeedbackEntry {
  readonly surface: ChannelActionFeedbackSurface;
  readonly identity: string;
  readonly scope: ChannelActionFeedbackScope;
  readonly message: string;
}

interface SendChannelMessageInput {
  readonly threadId?: string;
  readonly body: string;
  readonly mentions: readonly { readonly id: string; readonly label: string; readonly kind: "ai-teammate" | "local-user" | "channel" }[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly requestAiReply: boolean;
}

interface CreateTaskFromSlashCommandInput {
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId: string;
  readonly attachmentIds?: readonly string[];
}

export function useChannelActionsController(input: {
  readonly form: RunFormState;
  readonly setForm: Dispatch<SetStateAction<RunFormState>>;
  readonly channels: readonly Channel[];
  readonly channelForm: ChannelCreateFormState;
  readonly channelEditForm: ChannelFormState;
  readonly taskForm: TaskFormState;
  readonly providers: readonly ProviderPreset[];
  readonly providerTemplates: readonly ProviderTemplate[];
  readonly selectedChannelId: string;
  readonly activeSidebarTarget: SidebarTarget;
  readonly channelDecisions: readonly ChannelDecision[];
  readonly setActiveView: Dispatch<SetStateAction<ViewId>>;
  readonly setActiveSidebarTarget: Dispatch<SetStateAction<SidebarTarget>>;
  readonly setSelectedChannelId: Dispatch<SetStateAction<string>>;
  readonly setSelectedChannelBranchId: Dispatch<SetStateAction<string>>;
  readonly setSelectedTaskId: Dispatch<SetStateAction<string>>;
  readonly setTaskRunProviderId: Dispatch<SetStateAction<string>>;
  readonly setChannelCreateOpen: Dispatch<SetStateAction<boolean>>;
  readonly setChannelForm: Dispatch<SetStateAction<ChannelCreateFormState>>;
  readonly setChannelEditForm: Dispatch<SetStateAction<ChannelFormState>>;
  readonly setChannels: Dispatch<SetStateAction<readonly Channel[]>>;
  readonly setChannelBranches: Dispatch<SetStateAction<readonly ChannelBranch[]>>;
  readonly setTaskForm: Dispatch<SetStateAction<TaskFormState>>;
  readonly setTasks: Dispatch<SetStateAction<readonly Task[]>>;
  readonly setChannelMessages: Dispatch<SetStateAction<readonly ChannelMessage[]>>;
  readonly setChannelExecutionProposals: Dispatch<SetStateAction<readonly ChannelExecutionProposal[]>>;
  readonly setChannelAttachments: Dispatch<SetStateAction<readonly ChannelAttachment[]>>;
  readonly setChannelLinkPreviews: Dispatch<SetStateAction<readonly ChannelLinkPreview[]>>;
  readonly setChannelFilesLoading: Dispatch<SetStateAction<boolean>>;
  readonly setChannelBrief: Dispatch<SetStateAction<ChannelBrief | undefined>>;
  readonly setChannelCollaborationProtocol: Dispatch<SetStateAction<ChannelCollaborationProtocolResponse | undefined>>;
  readonly setChannelDecisions: Dispatch<SetStateAction<readonly ChannelDecision[]>>;
  readonly setChannelHandoffs: Dispatch<SetStateAction<readonly ChannelHandoff[]>>;
  readonly setChannelContextSummaries: Dispatch<SetStateAction<readonly ChannelContextSummary[]>>;
  readonly setChannelWorkflows: Dispatch<SetStateAction<readonly ChannelWorkflow[]>>;
  readonly setChannelWorkflowSteps: Dispatch<SetStateAction<readonly ChannelWorkflowStep[]>>;
  readonly reportFeedback: (entry: ChannelActionFeedbackEntry) => void;
  readonly clearFeedback: (surface: ChannelActionFeedbackSurface, identity: string) => void;
  readonly t: (value: string, values?: Record<string, string | number>) => string;
  readonly addChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly setDefaultChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
  readonly refreshTasks: (channelId?: string) => Promise<void>;
  readonly refreshChannelExecutionProposals: (channelId?: string) => Promise<void>;
  readonly refreshChannelFiles: (channelId?: string) => Promise<void>;
  readonly refreshChannelProtocol: (channelId?: string) => Promise<void>;
  readonly refreshExternalWorkCiTriage: (cwd?: string, channelId?: string) => Promise<void>;
  readonly refreshUsedMemoryAudit: (cwd?: string) => Promise<void>;
  readonly refreshChannelMessageRouteDecisions: (channelId?: string) => Promise<void>;
  readonly refreshChannelIntentDecisions: (channelId?: string) => Promise<void>;
  readonly refreshRuns: (cwd?: string) => Promise<void>;
  readonly refreshRuntimeState: (cwd?: string) => Promise<void>;
  readonly refreshChannelActivity: () => Promise<void>;
}): ChannelActionsController {
  function reportFeedback(
    surface: ChannelActionFeedbackSurface,
    identity: string,
    scope: ChannelActionFeedbackScope,
    caught: unknown,
  ): string {
    const message = caught instanceof Error ? caught.message : String(caught);
    input.reportFeedback({ surface, identity, scope, message });
    return message;
  }

  function clearFeedback(surface: ChannelActionFeedbackSurface, identity: string): void {
    input.clearFeedback(surface, identity);
  }

  function buildChannelCreatePayload(form: ChannelCreateFormState): ChannelFormState {
    return {
      name: form.name,
      status: form.status,
      boundPath: form.boundPath,
      defaultProviderPresetId: form.defaultProviderPresetId,
      defaultTeammateId: "",
      autoReplyMode: form.autoReplyMode,
      responseLanguage: form.responseLanguage,
      allowedTools: form.allowedTools,
      runtimePolicy: form.runtimePolicy,
    };
  }

  async function applyCreatedChannelTeammates(channelId: string, form: ChannelCreateFormState): Promise<void> {
    const teammateIds = [...new Set(form.selectedTeammateIds.filter(Boolean))];
    for (const teammateId of teammateIds) {
      await input.addChannelTeammate(channelId, teammateId);
    }
  }

  async function saveChannel(): Promise<void> {
    if (!input.form.cwd.trim()) {
      reportFeedback("create-dialog", "draft", "validation", "本地工作区未就绪");
      return;
    }
    if (!input.channelForm.name.trim()) {
      reportFeedback("create-dialog", "draft", "validation", "请输入 channel name");
      return;
    }
    const selectedProvider = input.providers.find((provider) => provider.id === input.channelForm.defaultProviderPresetId);
    if (!selectedProvider || !canUseConversationProvider(selectedProvider) || !providerPreflightReady(selectedProvider)) {
      reportFeedback("create-dialog", "draft", "validation", "请选择已配置并检查通过的聊天模型");
      return;
    }

    try {
      clearFeedback("create-dialog", "draft");
      const response = await createChannel(input.form.cwd.trim(), buildChannelCreatePayload(input.channelForm));
      await applyCreatedChannelTeammates(response.channel.id, input.channelForm);
      input.setSelectedChannelId(response.channel.id);
      input.setActiveSidebarTarget(channelSidebarTarget(response.channel.id));
      input.setChannelCreateOpen(false);
      input.setChannelForm((current) => ({
        ...current,
        name: "",
        defaultProviderPresetId: (current.defaultProviderPresetId || response.channel.defaultProviderPresetId) ?? "",
        selectedTeammateIds: [],
        defaultResponderTeammateId: "",
        defaultTeammateId: "",
      }));
      await input.refreshChannels();
    } catch (error) {
      reportFeedback("create-dialog", "draft", "mutation", error);
      throw error;
    }
  }

  async function saveDefaultChannel(): Promise<void> {
    if (!input.form.cwd.trim()) {
      reportFeedback("create-dialog", "draft", "validation", "本地工作区未就绪");
      return;
    }

    const readyProvider = input.providers.find(providerPreflightReady);
    try {
      clearFeedback("create-dialog", "draft");
      const response = await createChannel(input.form.cwd.trim(), {
        name: input.channelForm.name.trim() || "Engineering",
        status: input.channelForm.status,
        boundPath: input.channelForm.boundPath.trim() || input.form.cwd.trim(),
        defaultProviderPresetId: readyProvider?.id ?? input.channelForm.defaultProviderPresetId,
        defaultTeammateId: "",
        autoReplyMode: input.channelForm.autoReplyMode,
        responseLanguage: input.channelForm.responseLanguage,
        allowedTools: input.channelForm.allowedTools.length > 0 ? input.channelForm.allowedTools : defaultTools,
        runtimePolicy: input.channelForm.runtimePolicy,
      });
      await applyCreatedChannelTeammates(response.channel.id, input.channelForm);
      input.setSelectedChannelId(response.channel.id);
      input.setActiveSidebarTarget(channelSidebarTarget(response.channel.id));
      input.setChannelCreateOpen(false);
      input.setTaskRunProviderId("");
      if (readyProvider) {
        input.setForm((current) => ({
          ...current,
          providerPresetId: readyProvider.id,
          provider: readyProvider.providerId,
          model: readyProvider.model,
          baseUrl: providerEffectiveBaseUrl(readyProvider, input.providerTemplates),
          api: readyProvider.api,
        }));
      }
      input.setChannelForm((current) => ({
        ...current,
        name: "",
        boundPath: current.boundPath || input.form.cwd.trim(),
        defaultProviderPresetId: readyProvider?.id ?? current.defaultProviderPresetId,
        defaultTeammateId: "",
        selectedTeammateIds: [],
        defaultResponderTeammateId: "",
      }));
      await input.refreshChannels();
    } catch (error) {
      reportFeedback("create-dialog", "draft", "mutation", error);
      throw error;
    }
  }

  async function saveChannelEdit(channelId: string, formOverride?: ChannelFormState): Promise<void> {
    const channelForm = formOverride ?? input.channelEditForm;
    if (!input.form.cwd.trim()) {
      reportFeedback("workspace", channelId, "validation", "本地工作区未就绪");
      return;
    }
    if (!channelForm.name.trim()) {
      reportFeedback("workspace", channelId, "validation", "请输入 channel name");
      return;
    }
    if (channelForm.allowedTools.length === 0) {
      reportFeedback("workspace", channelId, "validation", "请至少选择一个 allowed tool");
      return;
    }

    try {
      clearFeedback("workspace", channelId);
      const response = await updateChannel(input.form.cwd.trim(), channelId, channelForm);
      input.setSelectedChannelId(response.channel.id);
      input.setTaskRunProviderId("");
      input.setChannelEditForm((current) =>
        channelFormPersistenceKey(current) === channelFormPersistenceKey(channelForm)
          ? channelToForm(response.channel, input.form.cwd)
          : current
      );
      await input.refreshChannels();
    } catch (error) {
      reportFeedback("workspace", channelId, "mutation", error);
      throw error;
    }
  }

  async function saveChannelBranch(channelId: string, name: string): Promise<void> {
    await createSidebarChannelBranchWithState({
      cwd: input.form.cwd.trim(),
      channelId,
      name,
      setActiveView: input.setActiveView,
      setActiveSidebarTarget: input.setActiveSidebarTarget,
      setSelectedChannelId: input.setSelectedChannelId,
      setSelectedChannelBranchId: input.setSelectedChannelBranchId,
      setChannelBranches: input.setChannelBranches,
      reportError: (message) => reportFeedback("sidebar", channelId, "mutation", message),
      refreshChannels: input.refreshChannels,
    });
  }

  async function archiveSidebarChannel(channelId: string): Promise<void> {
    await archiveSidebarChannelWithState({
      cwd: input.form.cwd.trim(),
      channels: input.channels,
      channelId,
      selectedChannelId: input.selectedChannelId,
      activeSidebarTarget: input.activeSidebarTarget,
      setActiveSidebarTarget: input.setActiveSidebarTarget,
      setSelectedChannelId: input.setSelectedChannelId,
      setSelectedChannelBranchId: input.setSelectedChannelBranchId,
      setChannels: input.setChannels,
      setChannelBranches: input.setChannelBranches,
      reportError: (message) => reportFeedback("sidebar", channelId, "mutation", message),
      refreshChannels: input.refreshChannels,
    });
  }

  async function archiveSidebarChannelBranch(channelId: string, branchId: string): Promise<void> {
    await archiveSidebarChannelBranchWithState({
      cwd: input.form.cwd.trim(),
      channelId,
      branchId,
      setChannelBranches: input.setChannelBranches,
      reportError: (message) => reportFeedback("sidebar", branchId, "mutation", message),
      refreshChannels: input.refreshChannels,
    });
  }

  async function removeChannel(channelId: string): Promise<void> {
    await removeSidebarChannelWithState({
      cwd: input.form.cwd.trim(),
      channelId,
      selectedChannelId: input.selectedChannelId,
      activeSidebarTarget: input.activeSidebarTarget,
      setActiveSidebarTarget: input.setActiveSidebarTarget,
      setSelectedChannelId: input.setSelectedChannelId,
      reportError: (message) => reportFeedback("sidebar", channelId, "mutation", message),
      refreshChannels: input.refreshChannels,
    });
  }

  async function saveTask(): Promise<boolean> {
    if (!input.selectedChannelId) {
      reportFeedback("task", "unselected", "validation", "请先选择 channel");
      return false;
    }
    if (!input.taskForm.prompt.trim()) {
      reportFeedback("task", input.selectedChannelId, "validation", "请输入 task prompt");
      return false;
    }

    try {
      clearFeedback("task", input.selectedChannelId);
      const response = await createTask(input.form.cwd.trim(), input.selectedChannelId, {
        title: input.taskForm.title.trim() || titleFromPrompt(input.taskForm.prompt),
        prompt: input.taskForm.prompt,
        assigneeTeammateId: input.taskForm.assigneeTeammateId || input.channels.find((channel) => channel.id === input.selectedChannelId)?.defaultTeammateId,
      });
      input.setSelectedTaskId(response.task.id);
      input.setTaskForm(defaultTaskForm);
      await input.refreshTasks(input.selectedChannelId);
      return true;
    } catch (error) {
      reportFeedback("task", input.selectedChannelId, "mutation", error);
      return false;
    }
  }

  async function createTaskFromSlashCommand(commandInput: CreateTaskFromSlashCommandInput): Promise<void> {
    if (!input.selectedChannelId) {
      reportFeedback("composer", "unselected", "validation", "请先选择 channel");
      return;
    }
    if (!commandInput.prompt.trim()) {
      reportFeedback("composer", input.selectedChannelId, "validation", "Slash command prompt 不能为空");
      return;
    }

    try {
      clearFeedback("composer", input.selectedChannelId);
      const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
      const response = await createTask(input.form.cwd.trim(), input.selectedChannelId, {
        title: commandInput.title.trim() || titleFromPrompt(commandInput.prompt),
        prompt: commandInput.prompt,
        assigneeTeammateId: commandInput.assigneeTeammateId || selectedChannel?.defaultTeammateId,
        requestedSkillId: commandInput.requestedSkillId,
        attachmentIds: commandInput.attachmentIds,
      });
      input.setSelectedTaskId(response.task.id);
      await input.refreshTasks(input.selectedChannelId);
      await input.refreshChannelActivity();
    } catch (error) {
      reportFeedback("composer", input.selectedChannelId, "mutation", error);
      throw error;
    }
  }

  async function sendChannelMessage(messageInput: SendChannelMessageInput): Promise<ChannelMessageSendResult> {
    if (!input.selectedChannelId) {
      const errorMessage = reportFeedback("composer", "unselected", "validation", "请先选择 channel");
      return { errorMessage };
    }
    const channelId = input.selectedChannelId;
    const selectedChannel = input.channels.find((channel) => channel.id === channelId);
    const firstAiMention = messageInput.mentions.find((mention) => mention.kind === "ai-teammate");
    const providerPresetId = messageInput.requestAiReply
      ? selectedChannel?.defaultProviderPresetId
        || input.form.providerPresetId
        || input.providers.find(providerPreflightReady)?.id
      : undefined;
    try {
      clearFeedback("composer", channelId);
      let receivedAiReply = false;
      let autoStartedWorkflow = false;
      let streamErrorMessage = "";
      const response = await streamChannelMessage(input.form.cwd.trim(), channelId, {
        threadId: messageInput.threadId,
        body: messageInput.body,
        mentions: messageInput.mentions,
        attachmentIds: messageInput.attachmentIds,
        linkPreviewIds: messageInput.linkPreviewIds,
        fileRefs: messageInput.fileRefs,
        requestAiReply: messageInput.requestAiReply,
        ...(providerPresetId ? { providerPresetId } : {}),
        teammateId: firstAiMention?.id || selectedChannel?.defaultTeammateId,
      });
      await readSseResponse(response, (event) => {
        if (event.event === "ready") {
          const data = JSON.parse(event.data) as ChannelMessageStreamReadyEvent;
          const aiReplies = data.aiReplies?.length ? data.aiReplies : data.aiReply ? [data.aiReply] : [];
          receivedAiReply = receivedAiReply || aiReplies.length > 0;
          input.setChannelMessages((current) => upsertChannelMessages(current, [data.message, ...aiReplies]));
          return;
        }
        if (event.event === "delta") {
          const data = JSON.parse(event.data) as ChannelMessageStreamDeltaEvent;
          input.setChannelMessages((current) => current.map((message) => message.id === data.messageId ? { ...message, body: data.body, status: "pending" } : message));
          return;
        }
        if (event.event === "run_linked") {
          const data = JSON.parse(event.data) as ChannelMessageStreamRunLinkedEvent;
          input.setChannelMessages((current) => current.map((message) =>
            message.id === data.messageId ? { ...message, linkedRunId: data.linkedRunId } : message
          ));
          const workspaceCwd = input.form.cwd.trim();
          void Promise.allSettled([
            input.refreshRuns(workspaceCwd),
            input.refreshRuntimeState(workspaceCwd),
          ]);
          return;
        }
        if (event.event === "done") {
          const data = JSON.parse(event.data) as ChannelMessageStreamDoneEvent;
          const aiReplies = data.aiReplies?.length ? data.aiReplies : data.aiReply ? [data.aiReply] : [];
          receivedAiReply = receivedAiReply || aiReplies.length > 0;
          autoStartedWorkflow = Boolean(data.autoStartedWorkflow);
          input.setChannelMessages((current) => upsertChannelMessages(current, [data.message, ...aiReplies]));
          return;
        }
        if (event.event === "blocked") {
          const data = JSON.parse(event.data) as ChannelMessageStreamBlockedEvent;
          const aiReplies = data.aiReplies?.length ? data.aiReplies : data.aiReply ? [data.aiReply] : [];
          receivedAiReply = receivedAiReply || aiReplies.length > 0;
          input.setChannelMessages((current) => upsertChannelMessages(current, [data.message, ...aiReplies]));
          if (data.error) {
            streamErrorMessage = data.error;
          }
          return;
        }
        if (event.event === "error") {
          const data = JSON.parse(event.data) as ChannelMessageStreamErrorEvent;
          const messages = [data.message, ...(data.aiReplies?.length ? data.aiReplies : data.aiReply ? [data.aiReply] : [])]
            .filter((message): message is ChannelMessage => Boolean(message));
          receivedAiReply = receivedAiReply || messages.some((message) => message.kind === "ai_reply");
          if (messages.length > 0) {
            input.setChannelMessages((current) => upsertChannelMessages(current, messages));
          }
          if (data.error) {
            streamErrorMessage = data.error;
          }
        }
      });
      await input.refreshChannelExecutionProposals(channelId);
      await input.refreshChannelIntentDecisions(channelId);
      if (receivedAiReply) {
        await input.refreshUsedMemoryAudit(input.form.cwd.trim());
      }
      await input.refreshChannelMessageRouteDecisions(channelId);
      await input.refreshChannelFiles(channelId);
      if (autoStartedWorkflow) {
        await input.refreshChannelActivity();
      }
      if (streamErrorMessage) {
        reportFeedback("composer", channelId, "stream", streamErrorMessage);
        return { errorMessage: streamErrorMessage };
      }
      return {};
    } catch (error) {
      reportFeedback("composer", channelId, "stream", error);
      throw error;
    }
  }

  async function uploadChannelFiles(files: readonly File[]): Promise<readonly ChannelAttachment[]> {
    if (!input.selectedChannelId) {
      reportFeedback("composer", "unselected", "validation", "请先选择 channel");
      return [];
    }
    if (files.length === 0) {
      return [];
    }

    input.setChannelFilesLoading(true);
    try {
      clearFeedback("composer", input.selectedChannelId);
      const responses = await Promise.all(files.map((file) => uploadChannelAttachment(input.form.cwd.trim(), input.selectedChannelId, file)));
      const uploaded = responses.map((response) => response.attachment);
      input.setChannelAttachments((current) => [...uploaded, ...current]);
      return uploaded;
    } catch (error) {
      reportFeedback("composer", input.selectedChannelId, "mutation", error);
      throw error;
    } finally {
      input.setChannelFilesLoading(false);
    }
  }

  async function addChannelLinkPreview(url: string): Promise<ChannelLinkPreview | undefined> {
    if (!input.selectedChannelId) {
      reportFeedback("composer", "unselected", "validation", "请先选择 channel");
      return undefined;
    }
    try {
      clearFeedback("composer", input.selectedChannelId);
      const response = await createChannelLinkPreview(input.form.cwd.trim(), input.selectedChannelId, { url });
      input.setChannelLinkPreviews((current) => [
        response.linkPreview,
        ...current.filter((preview) => preview.id !== response.linkPreview.id),
      ]);
      return response.linkPreview;
    } catch (error) {
      reportFeedback("composer", input.selectedChannelId, "mutation", error);
      throw error;
    }
  }

  async function removeChannelAttachment(attachmentId: string): Promise<void> {
    const channelId = input.selectedChannelId || "unselected";
    try {
      clearFeedback("composer", channelId);
      await deleteChannelAttachment(input.form.cwd.trim(), attachmentId);
      input.setChannelAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    } catch (error) {
      reportFeedback("composer", channelId, "mutation", error);
    }
  }

  async function saveChannelBrief(request: UpdateChannelBriefRequest): Promise<void> {
    if (!input.selectedChannelId) {
      reportFeedback("protocol", "unselected", "validation", "请先选择 channel");
      return;
    }
    try {
      clearFeedback("protocol", input.selectedChannelId);
      const response = await updateChannelBrief(input.form.cwd.trim(), input.selectedChannelId, request);
      input.setChannelBrief(response.brief);
    } catch (error) {
      reportFeedback("protocol", input.selectedChannelId, "mutation", error);
    }
  }

  async function saveChannelProtocolPatch(
    request: UpdateChannelCollaborationProtocolRequest,
  ): Promise<ChannelCollaborationProtocolResponse | undefined> {
    if (!input.selectedChannelId) {
      const error = new Error("请先选择 channel");
      throw error;
    }
    try {
      const response = await updateChannelCollaborationProtocol(input.form.cwd.trim(), input.selectedChannelId, request);
      input.setChannelCollaborationProtocol(response);
      await input.refreshChannels();
      return response;
    } catch (error) {
      throw error;
    }
  }

  async function revertChannelProtocolSettings(): Promise<ChannelCollaborationProtocolResponse | undefined> {
    if (!input.selectedChannelId) {
      const error = new Error("请先选择 channel");
      throw error;
    }
    try {
      const response = await revertChannelCollaborationProtocol(input.form.cwd.trim(), input.selectedChannelId);
      input.setChannelCollaborationProtocol(response);
      await input.refreshChannels();
      return response;
    } catch (error) {
      throw error;
    }
  }

  async function supersedeChannelDecision(decision: ChannelDecision): Promise<void> {
    if (!input.selectedChannelId) {
      reportFeedback("protocol", "unselected", "validation", "请先选择 channel");
      return;
    }
    try {
      clearFeedback("protocol", input.selectedChannelId);
      await createChannelDecision(input.form.cwd.trim(), input.selectedChannelId, {
        title: `${decision.title} update`,
        decision: decision.decision,
        rationale: "Supersedes the previous active decision.",
        alternatives: decision.alternatives,
        supersedesDecisionId: decision.id,
        createdBy: "local-user",
      });
      await input.refreshChannelProtocol(input.selectedChannelId);
    } catch (error) {
      reportFeedback("protocol", input.selectedChannelId, "mutation", error);
    }
  }

  async function rejectChannelDecision(decision: ChannelDecision): Promise<void> {
    const channelId = input.selectedChannelId || decision.channelId;
    try {
      clearFeedback("protocol", channelId);
      const response = await updateChannelDecision(input.form.cwd.trim(), decision.id, { status: "rejected" });
      input.setChannelDecisions((current) => current.map((item) => item.id === response.decision.id ? response.decision : item));
    } catch (error) {
      reportFeedback("protocol", channelId, "mutation", error);
    }
  }

  async function createHandoffFromTask(task: Task): Promise<ChannelHandoff | undefined> {
    if (!input.selectedChannelId) {
      reportFeedback("task", task.id, "validation", "请先选择 channel");
      return undefined;
    }
    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    const teammateId = task.assigneeTeammateId ?? selectedChannel?.defaultTeammateId ?? "engineer";
    try {
      clearFeedback("task", task.id);
      const response = await createChannelHandoff(input.form.cwd.trim(), input.selectedChannelId, {
        sourceTaskId: task.id,
        fromParticipantId: "local-user",
        fromParticipantLabel: input.t("You"),
        toParticipantId: teammateId,
        toParticipantLabel: teammateId,
        reason: task.title,
        requiredInput: task.prompt,
        expectedOutput: "Complete or report blocker for this task.",
        createdBy: "local-user",
      });
      input.setChannelHandoffs((current) => [response.handoff, ...current]);
      return response.handoff;
    } catch (error) {
      reportFeedback("task", task.id, "mutation", error);
      return undefined;
    }
  }

  async function updateHandoffStatusValue(handoff: ChannelHandoff, status: ChannelHandoffStatus): Promise<void> {
    try {
      clearFeedback("workflow", handoff.id);
      const response = await updateChannelHandoff(input.form.cwd.trim(), handoff.id, { status });
      input.setChannelHandoffs((current) => current.map((item) => item.id === response.handoff.id ? response.handoff : item));
    } catch (error) {
      reportFeedback("workflow", handoff.id, "mutation", error);
    }
  }

  async function startWorkflowFromHandoff(handoff: ChannelHandoff): Promise<void> {
    if (!input.selectedChannelId) {
      reportFeedback("workflow", handoff.id, "validation", "请先选择 channel");
      return;
    }

    try {
      clearFeedback("workflow", handoff.id);
      const response = await createChannelWorkflowFromHandoff(input.form.cwd.trim(), handoff.id, {
        title: `${handoff.reason || "Handoff"} workflow`,
        objective: handoff.expectedOutput || handoff.requiredInput || handoff.reason,
        createdBy: "local-user",
      });
      input.setChannelWorkflows((current) => [response.workflow, ...current.filter((item) => item.id !== response.workflow.id)]);
      const createdStep = response.workflowStep;
      if (createdStep) {
        input.setChannelWorkflowSteps((current) => [createdStep, ...current.filter((item) => item.id !== createdStep.id)]);
      }
      await input.refreshChannelProtocol(input.selectedChannelId);
    } catch (error) {
      reportFeedback("workflow", handoff.id, "mutation", error);
    }
  }

  async function createTaskFromContextSummary(summary: ChannelContextSummary): Promise<void> {
    if (!input.selectedChannelId) {
      reportFeedback("task", summary.targetId, "validation", "请先选择 channel");
      return;
    }
    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    try {
      clearFeedback("task", summary.targetId);
      const response = await createTask(input.form.cwd.trim(), input.selectedChannelId, {
        title: titleFromPrompt(summary.summary),
        prompt: buildContextTaskPrompt(summary, input.channelDecisions),
        assigneeTeammateId: selectedChannel?.defaultTeammateId,
      });
      input.setSelectedTaskId("");
      input.setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
      await input.refreshTasks(input.selectedChannelId);
    } catch (error) {
      reportFeedback("task", summary.targetId, "mutation", error);
    }
  }

  async function runActivityTriageAction(draft: ChannelActivityTriageDraft): Promise<ChannelActivityTriageResult> {
    if (!input.selectedChannelId) {
      const error = new Error("请先选择 channel");
      reportFeedback("workspace", "unselected", "validation", error);
      throw error;
    }
    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    const sourceRefs = draft.sourceRefs;
    try {
      clearFeedback("workspace", input.selectedChannelId);
      if (draft.actionKind === "follow_up_task") {
        const response = await createTask(input.form.cwd.trim(), input.selectedChannelId, {
          title: draft.title.trim(),
          prompt: draft.prompt,
          assigneeTeammateId: draft.assigneeTeammateId || selectedChannel?.defaultTeammateId,
        });
        input.setSelectedTaskId(response.task.id);
        input.setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
        return { kind: "task", task: response.task };
      }

      if (draft.actionKind === "handoff") {
        const response = await createChannelHandoff(input.form.cwd.trim(), input.selectedChannelId, {
          ...(sourceRefs.sourceMessageId ? { sourceMessageId: sourceRefs.sourceMessageId } : {}),
          ...(sourceRefs.sourceTaskId ? { sourceTaskId: sourceRefs.sourceTaskId } : {}),
          ...(sourceRefs.sourceRunId ? { sourceRunId: sourceRefs.sourceRunId } : {}),
          fromParticipantId: "local-user",
          fromParticipantLabel: input.t("You"),
          toParticipantId: draft.toParticipantId.trim(),
          toParticipantLabel: draft.toParticipantLabel.trim(),
          reason: draft.reason.trim(),
          requiredInput: draft.requiredInput,
          expectedOutput: draft.expectedOutput,
          createdBy: "local-user",
        });
        input.setChannelHandoffs((current) => [response.handoff, ...current.filter((handoff) => handoff.id !== response.handoff.id)]);
        return { kind: "handoff", handoff: response.handoff };
      }

      if (draft.actionKind === "decision") {
        const response = await createChannelDecision(input.form.cwd.trim(), input.selectedChannelId, {
          ...(sourceRefs.sourceMessageId ? { sourceMessageId: sourceRefs.sourceMessageId } : {}),
          ...(sourceRefs.sourceTaskId ? { sourceTaskId: sourceRefs.sourceTaskId } : {}),
          ...(sourceRefs.sourceRunId ? { sourceRunId: sourceRefs.sourceRunId } : {}),
          title: draft.title.trim(),
          decision: draft.decision,
          rationale: draft.rationale,
          alternatives: [],
          createdBy: "local-user",
        });
        input.setChannelDecisions((current) => [response.decision, ...current.filter((decision) => decision.id !== response.decision.id)]);
        return { kind: "decision", decision: response.decision };
      }

      const response = await createChannelContextSummary(input.form.cwd.trim(), input.selectedChannelId, {
        targetType: sourceRefs.contextTargetType,
        targetId: sourceRefs.contextTargetId,
        sourceMessageIds: sourceRefs.sourceMessageIds,
        decisionIds: draft.decisionIds,
        summary: draft.summary,
        acceptanceCriteria: splitTextLines(draft.acceptanceCriteria),
        openQuestions: splitTextLines(draft.openQuestions),
        authorType: "local-user",
        authorId: "local-user",
      });
      input.setChannelContextSummaries((current) => [
        response.contextSummary,
        ...current.filter((summary) => summary.id !== response.contextSummary.id),
      ]);
      return { kind: "context_summary", contextSummary: response.contextSummary };
    } catch (error) {
      reportFeedback("workspace", input.selectedChannelId, "mutation", error);
      throw error;
    }
  }

  return {
    saveChannel,
    saveDefaultChannel,
    saveChannelEdit,
    saveChannelBranch,
    archiveSidebarChannel,
    archiveSidebarChannelBranch,
    removeChannel,
    saveTask,
    createTaskFromSlashCommand,
    sendChannelMessage,
    uploadChannelFiles,
    addChannelLinkPreview,
    removeChannelAttachment,
    saveChannelBrief,
    saveChannelProtocolPatch,
    revertChannelProtocolSettings,
    supersedeChannelDecision,
    rejectChannelDecision,
    createHandoffFromTask,
    updateHandoffStatusValue,
    startWorkflowFromHandoff,
    createTaskFromContextSummary,
    runActivityTriageAction,
  };
}
