import type {
  AiTeammate,
  ChannelContextSummary,
  ChannelDecision,
  ChannelMessage,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ProviderPreset,
  RunSession,
  StateEntityType,
  Task,
} from "../types.js";
import type { LocalTeammateDraft } from "../features/teammates/index.js";
import { deriveChannelTasks } from "../lib/channel-artifacts.js";
import { providerCompactModelLabel } from "../lib/providers.js";
import type { ViewId } from "./view-types.js";

export function selectDesktopComputerUseConversation(input: {
  readonly activeView: ViewId;
  readonly selectedChannelId?: string;
  readonly selectedChannelBranchRootThreadId?: string;
  readonly selectedConversationThreadId?: string;
  readonly selectedAiTeammateId?: string;
  readonly teammateDirectThreadId?: string;
}): string | undefined {
  if (input.activeView === "workspace") {
    return input.selectedChannelId
      ? input.selectedChannelBranchRootThreadId || undefined
      : input.selectedConversationThreadId || undefined;
  }
  if (input.activeView === "teammates" && input.selectedAiTeammateId) {
    return input.teammateDirectThreadId || undefined;
  }
  return undefined;
}

export function buildContextTaskPrompt(summary: ChannelContextSummary, decisions: readonly ChannelDecision[]): string {
  const activeDecisions = decisions.filter((decision) => summary.decisionIds.includes(decision.id) && decision.status === "active");
  const decisionText = activeDecisions.length > 0
    ? `\n\nActive decisions:\n${activeDecisions.map((decision) => `- ${decision.title}: ${decision.decision}`).join("\n")}`
    : "";
  const criteriaText = summary.acceptanceCriteria.length > 0
    ? `\n\nAcceptance criteria:\n${summary.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
    : "";
  const questionText = summary.openQuestions.length > 0
    ? `\n\nOpen questions:\n${summary.openQuestions.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `Context summary:\n${summary.summary}${decisionText}${criteriaText}${questionText}`;
}

export function splitTextLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function aiTeammateToLocalDraft(
  teammate: AiTeammate,
  providers: readonly ProviderPreset[],
  channelIds: readonly string[] = [],
  workspaceDefaultProviderPresetId?: string,
): LocalTeammateDraft {
  const effectiveProviderPresetId = teammate.modelBindingMode === "workspace_default"
    ? workspaceDefaultProviderPresetId
    : teammate.providerPresetId;
  const provider = effectiveProviderPresetId
    ? providers.find((item) => item.id === effectiveProviderPresetId)
    : undefined;
  return {
    id: teammate.id,
    workspaceId: teammate.workspaceId,
    templateId: teammate.templateId,
    kind: teammate.kind,
    systemRole: teammate.systemRole,
    protectedProfile: teammate.protectedProfile,
    editableFields: teammate.editableFields,
    roleKey: teammate.roleKey,
    displayName: teammate.displayName,
    description: teammate.description,
    avatarTone: teammate.avatarTone,
    avatarImageAttachmentId: teammate.avatarImageAttachmentId,
    modelBindingMode: teammate.modelBindingMode,
    providerPresetId: teammate.providerPresetId,
    effectiveProviderPresetId,
    runnerId: teammate.runnerId,
    systemPrompt: teammate.systemPrompt,
    appendSystemPrompt: teammate.appendSystemPrompt,
    allowedTools: teammate.allowedTools,
    approvalProfile: teammate.approvalProfile,
    status: teammate.status,
    modelLabel: provider
      ? providerCompactModelLabel(provider)
      : teammate.modelBindingMode === "workspace_default"
        ? "Workspace default is not configured"
        : "No model selected",
    channelIds,
    pinned: teammate.pinned,
    hidden: teammate.hidden,
    disabled: teammate.status === "disabled",
    createdAt: teammate.createdAt,
    updatedAt: teammate.updatedAt,
  };
}

export interface ChannelUnreadState {
  readonly unread: boolean;
  readonly mentioned: boolean;
}

export function buildChannelUnreadState(
  messages: readonly ChannelMessage[],
  seenAt: string | undefined,
): ChannelUnreadState | undefined {
  const unreadMessages = seenAt
    ? messages.filter((message) => message.updatedAt > seenAt)
    : messages;
  if (unreadMessages.length === 0) {
    return undefined;
  }
  return {
    unread: true,
    mentioned: unreadMessages.some((message) =>
      message.mentions.some((mention) => mention.kind === "local-user")
    ),
  };
}

export function latestChannelMessageTimestamp(messages: readonly ChannelMessage[]): string {
  return messages.reduce((latest, message) => message.updatedAt > latest ? message.updatedAt : latest, "");
}

export function upsertChannelMessages(
  current: readonly ChannelMessage[],
  incoming: readonly ChannelMessage[],
): ChannelMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  const order = current.map((message) => message.id);
  for (const message of incoming) {
    if (!byId.has(message.id)) {
      order.push(message.id);
    }
    byId.set(message.id, message);
  }
  return order.map((id) => byId.get(id)!);
}

export function mergeWorkflowSteps(
  current: readonly ChannelWorkflowStep[],
  next: readonly ChannelWorkflowStep[],
): readonly ChannelWorkflowStep[] {
  const byId = new Map(current.map((step) => [step.id, step]));
  for (const step of next) {
    byId.set(step.id, step);
  }
  return [...byId.values()].sort((left, right) => {
    const workflowOrder = right.updatedAt.localeCompare(left.updatedAt);
    return workflowOrder !== 0 ? workflowOrder : left.position - right.position;
  });
}

interface ChannelTransitionEntity {
  readonly entityType: StateEntityType;
  readonly entityId: string;
  readonly updatedAt: string;
}

export function buildChannelTransitionEntities(
  channelId: string,
  tasks: readonly Task[],
  runs: readonly RunSession[],
  workflows: readonly ChannelWorkflow[],
  workflowSteps: readonly ChannelWorkflowStep[],
): readonly ChannelTransitionEntity[] {
  if (!channelId) {
    return [];
  }

  const channelTasks = deriveChannelTasks(channelId, tasks);
  const channelTaskIds = new Set(channelTasks.map((task) => task.id));
  const items: ChannelTransitionEntity[] = [
    ...channelTasks.map((task) => ({ entityType: "task" as const, entityId: task.id, updatedAt: task.updatedAt })),
    ...runs
      .filter((run) => run.channelId === channelId || channelTaskIds.has(run.taskId))
      .map((run) => ({ entityType: "run" as const, entityId: run.id, updatedAt: run.updatedAt })),
    ...workflows
      .filter((workflow) => workflow.channelId === channelId)
      .map((workflow) => ({ entityType: "workflow" as const, entityId: workflow.id, updatedAt: workflow.updatedAt })),
    ...workflowSteps
      .filter((step) => step.channelId === channelId)
      .map((step) => ({ entityType: "workflow_step" as const, entityId: step.id, updatedAt: step.updatedAt })),
  ];

  const deduped = new Map<string, ChannelTransitionEntity>();
  for (const item of items) {
    deduped.set(`${item.entityType}:${item.entityId}`, item);
  }

  return [...deduped.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20);
}
