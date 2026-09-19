import type { AiTeammate, ApprovalRequest, Channel, LingThreadStatus, RunSession, Task } from "../types.js";
import type {
  SidebarNotification,
  SidebarPrimaryStatus,
} from "../features/navigation/SidebarNavigation.js";
import { effectiveApprovalStatus } from "../lib/approvals.js";
import type { ChannelUnreadState } from "./app-shell-selectors.js";

interface ChannelProjectionInput {
  readonly approvals: readonly ApprovalRequest[];
  readonly channels: readonly Channel[];
  readonly channelUnreadById: Readonly<Record<string, ChannelUnreadState>>;
  readonly notificationLevels: Readonly<Record<string, string>>;
  readonly runs: readonly RunSession[];
  readonly selectedChannelId: string;
  readonly tasks: readonly Task[];
}

interface TeammateProjectionInput {
  readonly approvals: readonly ApprovalRequest[];
  readonly runs: readonly RunSession[];
  readonly tasks: readonly Task[];
  readonly teammates: readonly AiTeammate[];
}

export function buildSidebarChannelNotifications(
  input: ChannelProjectionInput,
): Readonly<Record<string, SidebarNotification>> {
  const runById = new Map(input.runs.map((item) => [item.id, item]));
  const taskById = new Map(input.tasks.map((item) => [item.id, item]));
  const pendingByChannel = countPendingApprovals(input.approvals, (approval) =>
    approval.channelId
      ?? (approval.runId ? runById.get(approval.runId)?.channelId : undefined)
      ?? (approval.taskId ? taskById.get(approval.taskId)?.channelId : undefined));
  const latestRunByChannel = latestByOwner(input.runs, (run) =>
    run.channelId ?? taskById.get(run.taskId)?.channelId);
  const latestTaskByChannel = latestByOwner(input.tasks, (task) => task.channelId);
  const notifications: Record<string, SidebarNotification> = {};

  for (const channel of input.channels) {
    const unreadState = input.channelUnreadById[channel.id];
    const notificationLevel = readChannelNotificationLevel(input.notificationLevels[channel.id]);
    const unread = channel.id !== input.selectedChannelId && unreadState?.unread === true && (
      notificationLevel === "all" ||
      (notificationLevel === "mentions" && unreadState.mentioned)
    );
    const count = pendingByChannel.get(channel.id) ?? 0;
    const primaryStatus = derivePrimaryStatus({
      paused: channel.status === "paused",
      pendingCount: count,
      run: latestRunByChannel.get(channel.id),
      task: latestTaskByChannel.get(channel.id),
    });
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
  const pendingByTeammate = countPendingApprovals(input.approvals, (approval) =>
    approval.taskId ? taskById.get(approval.taskId)?.assigneeTeammateId : undefined);
  const latestRunByTeammate = latestByOwner(input.runs, (run) =>
    run.teammateId ?? taskById.get(run.taskId)?.assigneeTeammateId);
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
): SidebarPrimaryStatus | undefined {
  if (status === "waiting_for_approval") return "waiting";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "running" || activeRunOrStream) return "running";
  return undefined;
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
  if (input.paused) return "paused";
  if (input.pendingCount > 0 || input.run?.status === "waiting_for_approval") return "waiting";
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

function readChannelNotificationLevel(value: string | undefined): "all" | "mentions" | "muted" {
  return value === "all" || value === "muted" ? value : "mentions";
}
