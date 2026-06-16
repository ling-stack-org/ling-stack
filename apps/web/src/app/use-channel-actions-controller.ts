import type { Dispatch, SetStateAction } from "react";
import {
  createChannel,
  createChannelBranch,
  createChannelContextSummary,
  createChannelDecision,
  createChannelHandoff,
  createChannelLinkPreview,
  createChannelWorkflowFromHandoff,
  createTask,
  deleteChannel,
  deleteChannelBranch,
  deleteChannelAttachment,
  patchChannel,
  streamChannelMessage,
  updateChannel,
  updateChannelBranch,
  updateChannelBrief,
  updateChannelCollaborationProtocol,
  updateChannelDecision,
  updateChannelHandoff,
  uploadChannelAttachment,
  revertChannelCollaborationProtocol,
} from "../api.js";
import {
  channelToForm,
  defaultChannelCreateForm,
  defaultChannelEditForm,
} from "../lib/channels.js";
import type { ChannelActivityTriageDraft, ChannelActivityTriageResult } from "../lib/channel-activity-triage.js";
import { titleFromPrompt } from "../lib/formatting.js";
import { providerEffectiveBaseUrl, providerPreflightReady } from "../lib/providers.js";
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

export interface ChannelActionsController {
  readonly saveChannel: () => Promise<void>;
  readonly saveDefaultChannel: () => Promise<void>;
  readonly saveChannelEdit: (channelId: string) => Promise<void>;
  readonly saveChannelBranch: (channelId: string, name: string) => Promise<void>;
  readonly archiveSidebarChannel: (channelId: string) => Promise<void>;
  readonly archiveSidebarChannelBranch: (channelId: string, branchId: string) => Promise<void>;
  readonly removeChannel: (channelId: string) => Promise<void>;
  readonly saveTask: () => Promise<void>;
  readonly sendChannelMessage: (input: SendChannelMessageInput) => Promise<void>;
  readonly uploadChannelFiles: (files: readonly File[]) => Promise<readonly ChannelAttachment[]>;
  readonly addChannelLinkPreview: (url: string) => Promise<ChannelLinkPreview | undefined>;
  readonly removeChannelAttachment: (attachmentId: string) => Promise<void>;
  readonly saveChannelBrief: (input: UpdateChannelBriefRequest) => Promise<void>;
  readonly saveChannelProtocolPatch: (input: UpdateChannelCollaborationProtocolRequest) => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly revertChannelProtocolSettings: () => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly supersedeChannelDecision: (decision: ChannelDecision) => Promise<void>;
  readonly rejectChannelDecision: (decision: ChannelDecision) => Promise<void>;
  readonly createHandoffFromTask: (task: Task) => Promise<ChannelHandoff | undefined>;
  readonly updateHandoffStatusValue: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => Promise<void>;
  readonly startWorkflowFromHandoff: (handoff: ChannelHandoff) => Promise<void>;
  readonly createTaskFromContextSummary: (summary: ChannelContextSummary) => Promise<void>;
  readonly runActivityTriageAction: (draft: ChannelActivityTriageDraft) => Promise<ChannelActivityTriageResult>;
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
  readonly setErrorMessage: (message: string) => void;
  readonly t: (value: string, values?: Record<string, string | number>) => string;
  readonly addChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly setDefaultChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly resolveChannelMessageProviderPresetId: (channel: Channel | undefined, teammateId: string | undefined) => string;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
  readonly refreshTasks: (channelId?: string) => Promise<void>;
  readonly refreshChannelExecutionProposals: (channelId?: string) => Promise<void>;
  readonly refreshChannelFiles: (channelId?: string) => Promise<void>;
  readonly refreshChannelProtocol: (channelId?: string) => Promise<void>;
  readonly refreshExternalWorkCiTriage: (cwd?: string, channelId?: string) => Promise<void>;
  readonly refreshUsedMemoryAudit: (cwd?: string) => Promise<void>;
  readonly refreshChannelMessageRouteDecisions: (channelId?: string) => Promise<void>;
  readonly refreshChannelIntentDecisions: (channelId?: string) => Promise<void>;
  readonly refreshChannelActivity: () => Promise<void>;
}): ChannelActionsController {
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

  function selectedCreateTeammateIds(form: ChannelCreateFormState): readonly string[] {
    return [...new Set(form.selectedTeammateIds.filter(Boolean))];
  }

  async function applyCreatedChannelTeammates(channelId: string, form: ChannelCreateFormState): Promise<void> {
    const teammateIds = selectedCreateTeammateIds(form);
    for (const teammateId of teammateIds) {
      await input.addChannelTeammate(channelId, teammateId);
    }
  }

  async function saveChannel(): Promise<void> {
    if (!input.form.cwd.trim()) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }
    if (!input.channelForm.name.trim()) {
      input.setErrorMessage("请输入 channel name");
      return;
    }

    try {
      input.setErrorMessage("");
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
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function saveDefaultChannel(): Promise<void> {
    if (!input.form.cwd.trim()) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }

    const readyProvider = input.providers.find(providerPreflightReady);
    try {
      input.setErrorMessage("");
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
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function saveChannelEdit(channelId: string): Promise<void> {
    if (!input.form.cwd.trim()) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }
    if (!input.channelEditForm.name.trim()) {
      input.setErrorMessage("请输入 channel name");
      return;
    }
    if (input.channelEditForm.allowedTools.length === 0) {
      input.setErrorMessage("请至少选择一个 allowed tool");
      return;
    }

    try {
      input.setErrorMessage("");
      const response = await updateChannel(input.form.cwd.trim(), channelId, input.channelEditForm);
      input.setSelectedChannelId(response.channel.id);
      input.setTaskRunProviderId("");
      input.setChannelEditForm(channelToForm(response.channel, input.form.cwd));
      await input.refreshChannels();
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function saveChannelBranch(channelId: string, name: string): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }
    try {
      input.setErrorMessage("");
      const response = await createChannelBranch(workspaceCwd, channelId, { name, status: "active" });
      input.setSelectedChannelId(channelId);
      input.setSelectedChannelBranchId(response.branch.id);
      input.setActiveView("workspace");
      input.setActiveSidebarTarget(channelSidebarTarget(channelId));
      await input.refreshChannels(workspaceCwd);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function archiveSidebarChannel(channelId: string): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    const channel = input.channels.find((item) => item.id === channelId);
    if (!workspaceCwd || !channel) {
      return;
    }
    try {
      input.setErrorMessage("");
      await patchChannel(workspaceCwd, channelId, { status: "archived" });
      input.setChannels((current) => current.filter((item) => item.id !== channelId));
      input.setChannelBranches((current) => current.filter((branch) => branch.channelId !== channelId));
      if (input.selectedChannelId === channelId) {
        input.setSelectedChannelId("");
        input.setSelectedChannelBranchId("");
        input.setActiveSidebarTarget("workspace");
      }
      await input.refreshChannels(workspaceCwd);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function archiveSidebarChannelBranch(channelId: string, branchId: string): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    if (!workspaceCwd) {
      return;
    }
    try {
      input.setErrorMessage("");
      await updateChannelBranch(workspaceCwd, channelId, branchId, { status: "archived" });
      input.setChannelBranches((current) => current.filter((branch) => branch.id !== branchId));
      await input.refreshChannels(workspaceCwd);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeChannel(channelId: string): Promise<void> {
    try {
      input.setErrorMessage("");
      await deleteChannel(input.form.cwd.trim(), channelId);
      if (input.selectedChannelId === channelId) {
        input.setSelectedChannelId("");
      }
      if (input.activeSidebarTarget === channelSidebarTarget(channelId)) {
        input.setActiveSidebarTarget("workspace");
      }
      await input.refreshChannels();
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTask(): Promise<void> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return;
    }
    if (!input.taskForm.prompt.trim()) {
      input.setErrorMessage("请输入 task prompt");
      return;
    }

    try {
      input.setErrorMessage("");
      const response = await createTask(input.form.cwd.trim(), input.selectedChannelId, {
        title: input.taskForm.title.trim() || titleFromPrompt(input.taskForm.prompt),
        prompt: input.taskForm.prompt,
        assigneeTeammateId: input.taskForm.assigneeTeammateId || input.channels.find((channel) => channel.id === input.selectedChannelId)?.defaultTeammateId,
      });
      input.setSelectedTaskId(response.task.id);
      input.setTaskForm(defaultTaskForm);
      await input.refreshTasks(input.selectedChannelId);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendChannelMessage(messageInput: SendChannelMessageInput): Promise<void> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    const firstAiMention = messageInput.mentions.find((mention) => mention.kind === "ai-teammate");
    const providerPresetId = input.resolveChannelMessageProviderPresetId(
      selectedChannel,
      firstAiMention?.id || selectedChannel?.defaultTeammateId,
    );
    try {
      input.setErrorMessage("");
      let receivedAiReply = false;
      let autoStartedWorkflow = false;
      const response = await streamChannelMessage(input.form.cwd.trim(), input.selectedChannelId, {
        threadId: messageInput.threadId,
        body: messageInput.body,
        mentions: messageInput.mentions,
        attachmentIds: messageInput.attachmentIds,
        linkPreviewIds: messageInput.linkPreviewIds,
        fileRefs: messageInput.fileRefs,
        requestAiReply: messageInput.requestAiReply,
        providerPresetId: providerPresetId || undefined,
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
            input.setErrorMessage(data.error);
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
            input.setErrorMessage(data.error);
          }
        }
      });
      await input.refreshChannelExecutionProposals(input.selectedChannelId);
      await input.refreshChannelIntentDecisions(input.selectedChannelId);
      if (receivedAiReply) {
        await input.refreshUsedMemoryAudit(input.form.cwd.trim());
      }
      await input.refreshChannelMessageRouteDecisions(input.selectedChannelId);
      await input.refreshChannelFiles(input.selectedChannelId);
      if (autoStartedWorkflow) {
        await input.refreshChannelActivity();
      }
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function uploadChannelFiles(files: readonly File[]): Promise<readonly ChannelAttachment[]> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return [];
    }
    if (files.length === 0) {
      return [];
    }

    input.setChannelFilesLoading(true);
    try {
      input.setErrorMessage("");
      const responses = await Promise.all(files.map((file) => uploadChannelAttachment(input.form.cwd.trim(), input.selectedChannelId, file)));
      const uploaded = responses.map((response) => response.attachment);
      input.setChannelAttachments((current) => [...uploaded, ...current]);
      return uploaded;
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      input.setChannelFilesLoading(false);
    }
  }

  async function addChannelLinkPreview(url: string): Promise<ChannelLinkPreview | undefined> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return undefined;
    }
    try {
      input.setErrorMessage("");
      const response = await createChannelLinkPreview(input.form.cwd.trim(), input.selectedChannelId, { url });
      input.setChannelLinkPreviews((current) => [
        response.linkPreview,
        ...current.filter((preview) => preview.id !== response.linkPreview.id),
      ]);
      return response.linkPreview;
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function removeChannelAttachment(attachmentId: string): Promise<void> {
    try {
      input.setErrorMessage("");
      await deleteChannelAttachment(input.form.cwd.trim(), attachmentId);
      input.setChannelAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveChannelBrief(request: UpdateChannelBriefRequest): Promise<void> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return;
    }
    try {
      input.setErrorMessage("");
      const response = await updateChannelBrief(input.form.cwd.trim(), input.selectedChannelId, request);
      input.setChannelBrief(response.brief);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveChannelProtocolPatch(request: UpdateChannelCollaborationProtocolRequest): Promise<ChannelCollaborationProtocolResponse | undefined> {
    if (!input.selectedChannelId) {
      const error = new Error("请先选择 channel");
      input.setErrorMessage(error.message);
      throw error;
    }
    try {
      input.setErrorMessage("");
      const response = await updateChannelCollaborationProtocol(input.form.cwd.trim(), input.selectedChannelId, request);
      input.setChannelCollaborationProtocol(response);
      await input.refreshChannels();
      return response;
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function revertChannelProtocolSettings(): Promise<ChannelCollaborationProtocolResponse | undefined> {
    if (!input.selectedChannelId) {
      const error = new Error("请先选择 channel");
      input.setErrorMessage(error.message);
      throw error;
    }
    try {
      input.setErrorMessage("");
      const response = await revertChannelCollaborationProtocol(input.form.cwd.trim(), input.selectedChannelId);
      input.setChannelCollaborationProtocol(response);
      await input.refreshChannels();
      return response;
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function supersedeChannelDecision(decision: ChannelDecision): Promise<void> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return;
    }
    try {
      input.setErrorMessage("");
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
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function rejectChannelDecision(decision: ChannelDecision): Promise<void> {
    try {
      input.setErrorMessage("");
      const response = await updateChannelDecision(input.form.cwd.trim(), decision.id, { status: "rejected" });
      input.setChannelDecisions((current) => current.map((item) => item.id === response.decision.id ? response.decision : item));
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createHandoffFromTask(task: Task): Promise<ChannelHandoff | undefined> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return undefined;
    }
    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    const teammateId = task.assigneeTeammateId ?? selectedChannel?.defaultTeammateId ?? "engineer";
    try {
      input.setErrorMessage("");
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
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async function updateHandoffStatusValue(handoff: ChannelHandoff, status: ChannelHandoffStatus): Promise<void> {
    try {
      input.setErrorMessage("");
      const response = await updateChannelHandoff(input.form.cwd.trim(), handoff.id, { status });
      input.setChannelHandoffs((current) => current.map((item) => item.id === response.handoff.id ? response.handoff : item));
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function startWorkflowFromHandoff(handoff: ChannelHandoff): Promise<void> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return;
    }

    try {
      input.setErrorMessage("");
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
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createTaskFromContextSummary(summary: ChannelContextSummary): Promise<void> {
    if (!input.selectedChannelId) {
      input.setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    try {
      input.setErrorMessage("");
      const response = await createTask(input.form.cwd.trim(), input.selectedChannelId, {
        title: titleFromPrompt(summary.summary),
        prompt: buildContextTaskPrompt(summary, input.channelDecisions),
        assigneeTeammateId: selectedChannel?.defaultTeammateId,
      });
      input.setSelectedTaskId("");
      input.setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
      await input.refreshTasks(input.selectedChannelId);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function runActivityTriageAction(draft: ChannelActivityTriageDraft): Promise<ChannelActivityTriageResult> {
    if (!input.selectedChannelId) {
      const error = new Error("请先选择 channel");
      input.setErrorMessage(error.message);
      throw error;
    }
    const selectedChannel = input.channels.find((channel) => channel.id === input.selectedChannelId);
    const sourceRefs = draft.sourceRefs;
    try {
      input.setErrorMessage("");
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
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
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
