import type {
  ApprovalRequest,
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
import type { SidebarNotification } from "../features/navigation/SidebarNavigation.js";
import { effectiveApprovalStatus } from "../lib/approvals.js";
import { deriveChannelTasks } from "../lib/channel-artifacts.js";
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

export function aiTeammateToLocalDraft(teammate: AiTeammate, providers: readonly ProviderPreset[]): LocalTeammateDraft {
  const provider = teammate.providerPresetId ? providers.find((item) => item.id === teammate.providerPresetId) : undefined;
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
    providerPresetId: teammate.providerPresetId,
    runnerId: teammate.runnerId,
    systemPrompt: teammate.systemPrompt,
    appendSystemPrompt: teammate.appendSystemPrompt,
    allowedTools: teammate.allowedTools,
    approvalProfile: teammate.approvalProfile,
    status: teammate.status,
    modelLabel: provider ? `${provider.displayName} / ${provider.model}` : "No model selected",
    channelIds: [],
    pinned: teammate.pinned,
    hidden: teammate.hidden,
    disabled: teammate.status === "disabled",
    createdAt: teammate.createdAt,
    updatedAt: teammate.updatedAt,
  };
}

export function buildSidebarChannelNotifications(
  approvals: readonly ApprovalRequest[],
  runs: readonly RunSession[],
  tasks: readonly Task[],
  selectedChannelId: string,
  channelUnreadById: Readonly<Record<string, ChannelUnreadState>>,
  notificationLevels: Readonly<Record<string, string>>,
): Readonly<Record<string, SidebarNotification>> {
  const runById = new Map(runs.map((item) => [item.id, item]));
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const unread = new Set<string>();

  for (const approval of approvals) {
    if (effectiveApprovalStatus(approval) !== "pending") {
      continue;
    }
    const channelId = approval.channelId
      ?? (approval.runId ? runById.get(approval.runId)?.channelId : undefined)
      ?? (approval.taskId ? taskById.get(approval.taskId)?.channelId : undefined);
    if (channelId && channelId !== selectedChannelId) {
      unread.add(channelId);
    }
  }

  for (const [channelId, state] of Object.entries(channelUnreadById)) {
    const notificationLevel = readChannelNotificationLevel(notificationLevels[channelId]);
    const shouldNotify = state.unread && (
      notificationLevel === "all" ||
      (notificationLevel === "mentions" && state.mentioned)
    );
    if (shouldNotify && channelId !== selectedChannelId) {
      unread.add(channelId);
    }
  }

  return Object.fromEntries([...unread].map((channelId) => [channelId, { unread: true }]));
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

function readChannelNotificationLevel(value: string | undefined): "all" | "mentions" | "muted" {
  return value === "all" || value === "muted" ? value : "mentions";
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

export function buildSidebarTeammateNotifications(
  approvals: readonly ApprovalRequest[],
  tasks: readonly Task[],
): Readonly<Record<string, SidebarNotification>> {
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const counts = new Map<string, number>();

  for (const approval of approvals) {
    if (effectiveApprovalStatus(approval) !== "pending" || !approval.taskId) {
      continue;
    }
    const assigneeTeammateId = taskById.get(approval.taskId)?.assigneeTeammateId;
    if (assigneeTeammateId) {
      counts.set(assigneeTeammateId, (counts.get(assigneeTeammateId) ?? 0) + 1);
    }
  }

  return Object.fromEntries([...counts.entries()].map(([teammateId, count]) => [teammateId, { count }]));
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
