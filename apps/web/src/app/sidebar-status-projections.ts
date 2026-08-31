import type { AiTeammate, ApprovalRequest, Channel, ChannelWorkflowStep, LingThreadStatus, RunSession, Task, WorkUnit } from "../types.js";
import type {
  SidebarNotification,
  SidebarPrimaryStatus,
} from "../features/navigation/SidebarNavigation.js";
import { effectiveApprovalStatus } from "../lib/approvals.js";
import {
  channelNotificationAllows,
  readChannelNotificationLevel,
  type ChannelNotificationLevel,
} from "../lib/channel-notifications.js";
import { resolveRuntimeApprovalOwner, resolveRuntimeRunOwner } from "../lib/runtime-approval-ownership.js";
import type { ChannelUnreadState } from "./app-shell-selectors.js";

interface ChannelProjectionInput {
  readonly approvals: readonly ApprovalRequest[];
  readonly channels: readonly Channel[];
  readonly channelUnreadById: Readonly<Record<string, ChannelUnreadState>>;
  readonly notificationLevels: Readonly<Record<string, string>>;
  readonly runs: readonly RunSession[];
  readonly selectedChannelId: string;
  readonly tasks: readonly Task[];
  readonly workUnits: readonly WorkUnit[];
  readonly workflowSteps?: readonly ChannelWorkflowStep[];
}

interface TeammateProjectionInput {
  readonly approvals: readonly ApprovalRequest[];
  readonly runs: readonly RunSession[];
  readonly tasks: readonly Task[];
  readonly teammates: readonly AiTeammate[];
  readonly workUnits: readonly WorkUnit[];
}

export function buildSidebarChannelNotifications(
  input: ChannelProjectionInput,
): Readonly<Record<string, SidebarNotification>> {
  const taskById = new Map(input.tasks.map((item) => [item.id, item]));
  const ownershipContext = { runs: input.runs, tasks: input.tasks, workUnits: input.workUnits, workflowSteps: input.workflowSteps };
  const pendingByChannel = summarizePendingApprovals(input.approvals, (approval) => {
    const owner = resolveRuntimeApprovalOwner(approval, ownershipContext);
    return owner?.kind === "channel" ? owner.channelId : undefined;
  });
  const latestRunByChannel = latestByOwner(input.runs, (run) => {
    const owner = resolveRuntimeRunOwner(run, { workUnits: input.workUnits });
    if (owner?.kind === "channel") return owner.channelId;
    return owner ? undefined : taskById.get(run.taskId)?.channelId;
  });
  const latestTaskByChannel = latestByOwner(input.tasks, (task) => task.channelId);
  const notifications: Record<string, SidebarNotification> = {};

  for (const channel of input.channels) {
    const unreadState = input.channelUnreadById[channel.id];
    const notificationLevel = readChannelNotificationLevel(input.notificationLevels[channel.id]);
    const unread = channel.id !== input.selectedChannelId && unreadState?.unread === true && channelNotificationAllows(
      notificationLevel,
      unreadState.mentioned ? "mention" : "message",
    );
    const pending = pendingByChannel.get(channel.id) ?? { critical: 0, total: 0 };
    const primaryStatus = deriveChannelPrimaryStatus({
      notificationLevel,
      paused: channel.status === "paused",
      pendingCriticalCount: pending.critical,
      pendingTotalCount: pending.total,
      run: latestRunByChannel.get(channel.id),
      task: latestTaskByChannel.get(channel.id),
    });
    const count = primaryStatus === "waiting"
      ? notificationLevel === "muted" ? pending.critical : pending.total
      : 0;
    if (primaryStatus || unread) {
      notifications[channel.id] = {
        ...(count > 0 ? { count } : {}),
        ...(primaryStatus ? { primaryStatus } : {}),
        ...(unread ? { unread: true } : {}),
      };
    }
  }
  return notifications;
}

export function buildSidebarTeammateNotifications(
  input: TeammateProjectionInput,
): Readonly<Record<string, SidebarNotification>> {
  const taskById = new Map(input.tasks.map((item) => [item.id, item]));
  const ownershipContext = { runs: input.runs, tasks: input.tasks, workUnits: input.workUnits };
  const pendingByTeammate = countPendingApprovals(input.approvals, (approval) => {
    const owner = resolveRuntimeApprovalOwner(approval, ownershipContext);
    return owner?.kind === "teammate_direct" ? owner.teammateId : undefined;
  });
  const latestRunByTeammate = latestByOwner(input.runs, (run) => {
    const owner = resolveRuntimeRunOwner(run, { workUnits: input.workUnits });
    if (owner?.kind === "teammate_direct") return owner.teammateId;
    return owner || run.threadId
      ? undefined
      : run.teammateId ?? taskById.get(run.taskId)?.assigneeTeammateId;
  });
  const latestTaskByTeammate = latestByOwner(input.tasks, (task) => task.assigneeTeammateId);
  const notifications: Record<string, SidebarNotification> = {};

  for (const teammate of input.teammates) {
    const count = pendingByTeammate.get(teammate.id) ?? 0;
    const primaryStatus = derivePrimaryStatus({
      paused: teammate.status === "paused",
      pendingCount: count,
      run: latestRunByTeammate.get(teammate.id),
      task: latestTaskByTeammate.get(teammate.id),
    });
    if (primaryStatus) {
      notifications[teammate.id] = {
        ...(count > 0 ? { count } : {}),
        primaryStatus,
      };
    }
  }
  return notifications;
}

export function projectSidebarConversationStatus(
  status: LingThreadStatus,
  activeRunOrStream: boolean,
  pendingApproval = false,
  failureAcknowledged = false,
): SidebarPrimaryStatus | undefined {
  if (pendingApproval || status === "waiting_for_approval") return "waiting";
  if ((status === "failed" || status === "blocked") && !failureAcknowledged) return "failed";
  if (status === "running" || activeRunOrStream) return "running";
  return undefined;
}

export function buildSidebarConversationApprovalCounts(
  approvals: readonly ApprovalRequest[],
  runs: readonly RunSession[],
  workUnits: readonly WorkUnit[],
): ReadonlyMap<string, number> {
  return countPendingApprovals(approvals, (approval) => {
    const owner = resolveRuntimeApprovalOwner(approval, { runs, workUnits });
    return owner?.kind === "normal_conversation" ? owner.threadId : undefined;
  });
}

function countPendingApprovals(
  approvals: readonly ApprovalRequest[],
  ownerId: (approval: ApprovalRequest) => string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const approval of approvals) {
    if (effectiveApprovalStatus(approval) !== "pending") continue;
    const id = ownerId(approval);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function summarizePendingApprovals(
  approvals: readonly ApprovalRequest[],
  ownerId: (approval: ApprovalRequest) => string | undefined,
): Map<string, { readonly critical: number; readonly total: number }> {
  const counts = new Map<string, { readonly critical: number; readonly total: number }>();
  for (const approval of approvals) {
    if (effectiveApprovalStatus(approval) !== "pending") continue;
    const id = ownerId(approval);
    if (!id) continue;
    const current = counts.get(id) ?? { critical: 0, total: 0 };
    counts.set(id, {
      critical: current.critical + (approval.risk === "critical" ? 1 : 0),
      total: current.total + 1,
    });
  }
  return counts;
}

function latestByOwner<T extends { readonly updatedAt: string }>(
  items: readonly T[],
  ownerId: (item: T) => string | undefined,
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const item of items) {
    const id = ownerId(item);
    const current = id ? latest.get(id) : undefined;
    if (id && (!current || item.updatedAt > current.updatedAt)) latest.set(id, item);
  }
  return latest;
}

function derivePrimaryStatus(input: {
  readonly paused: boolean;
  readonly pendingCount: number;
  readonly run?: RunSession;
  readonly task?: Task;
}): SidebarPrimaryStatus | undefined {
  if (input.pendingCount > 0 || input.run?.status === "waiting_for_approval") return "waiting";
  if (input.paused) return "paused";
  if (input.run?.status === "failed" || input.task?.status === "failed" || input.task?.status === "blocked") {
    return "failed";
  }
  if (
    input.run?.status === "queued" || input.run?.status === "running" ||
    input.task?.status === "claimed" || input.task?.status === "running"
  ) {
    return "running";
  }
  return undefined;
}

function deriveChannelPrimaryStatus(input: {
  readonly notificationLevel: ChannelNotificationLevel;
  readonly paused: boolean;
  readonly pendingCriticalCount: number;
  readonly pendingTotalCount: number;
  readonly run?: RunSession;
  readonly task?: Task;
}): SidebarPrimaryStatus | undefined {
  const waitingForApproval = input.pendingTotalCount > 0 || input.run?.status === "waiting_for_approval";
  if (waitingForApproval && channelNotificationAllows(
    input.notificationLevel,
    input.pendingCriticalCount > 0 ? "critical_approval" : "approval",
  )) {
    return "waiting";
  }
  if (input.paused) return "paused";
  if (
    (input.run?.status === "failed" || input.task?.status === "failed" || input.task?.status === "blocked") &&
    channelNotificationAllows(input.notificationLevel, "blocker")
  ) {
    return "failed";
  }
  if (
    (
      input.run?.status === "queued" || input.run?.status === "running" ||
      input.task?.status === "claimed" || input.task?.status === "running"
    ) &&
    channelNotificationAllows(input.notificationLevel, "activity")
  ) {
    return "running";
  }
  return undefined;
}
