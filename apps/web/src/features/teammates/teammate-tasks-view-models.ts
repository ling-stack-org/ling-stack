import type { StatusTone } from "../../shared/ui/index.js";
import type {
  Channel,
  EffectiveTeammateSkill,
  Task,
  TaskStatus,
  TeammateChannelMembership,
} from "../../types.js";

export type TeammateTaskFilter = "all" | "active" | "attention" | "completed";

export interface TeammateTaskCreateForm {
  readonly channelId: string;
  readonly requestedSkillId: string;
  readonly title: string;
  readonly prompt: string;
}

export interface TeammateTaskRowViewModel {
  readonly task: Task;
  readonly channelName: string;
  readonly requestedSkillName?: string;
  readonly statusLabelKey: string;
  readonly statusTone: StatusTone;
  readonly destination: "run" | "work-board";
  readonly searchText: string;
}

export interface TeammateTaskStats {
  readonly total: number;
  readonly active: number;
  readonly attention: number;
  readonly completed: number;
}

const activeStatuses = new Set<TaskStatus>(["todo", "claimed", "running", "review"]);
const attentionStatuses = new Set<TaskStatus>(["blocked", "failed"]);
const completedStatuses = new Set<TaskStatus>(["done", "cancelled"]);

export const emptyTeammateTaskCreateForm: TeammateTaskCreateForm = {
  channelId: "",
  requestedSkillId: "",
  title: "",
  prompt: "",
};

export function deriveActiveTeammateTaskChannels(
  channels: readonly Channel[],
  memberships: readonly TeammateChannelMembership[],
): readonly Channel[] {
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const seen = new Set<string>();
  const result: Channel[] = [];
  for (const membership of memberships) {
    const channel = channelById.get(membership.channelId);
    if (!channel || channel.status !== "active" || seen.has(channel.id)) continue;
    seen.add(channel.id);
    result.push(channel);
  }
  return result;
}

export function resolveTeammateTaskChannelId(
  requestedChannelId: string,
  channels: readonly Channel[],
  memberships: readonly TeammateChannelMembership[],
): string {
  if (requestedChannelId && channels.some((channel) => channel.id === requestedChannelId)) {
    return requestedChannelId;
  }
  const preferredMembership = memberships.find((membership) => membership.isDefault);
  if (preferredMembership && channels.some((channel) => channel.id === preferredMembership.channelId)) {
    return preferredMembership.channelId;
  }
  return channels[0]?.id ?? "";
}

export function buildTeammateTaskRows(input: {
  readonly tasks: readonly Task[];
  readonly channels: readonly Channel[];
  readonly skills: readonly EffectiveTeammateSkill[];
}): readonly TeammateTaskRowViewModel[] {
  const channelById = new Map(input.channels.map((channel) => [channel.id, channel]));
  const skillById = new Map(input.skills.map((skill) => [skill.skillId, skill]));
  return [...input.tasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((task) => {
      const channelName = channelById.get(task.channelId)?.name ?? task.channelId;
      const requestedSkillName = task.requestedSkillId
        ? skillById.get(task.requestedSkillId)?.skill.name ?? task.requestedSkillId
        : undefined;
      return {
        task,
        channelName,
        requestedSkillName,
        statusLabelKey: taskStatusLabelKey(task.status),
        statusTone: taskStatusTone(task.status),
        destination: task.currentRunId ? "run" : "work-board",
        searchText: [task.title, task.prompt, channelName, requestedSkillName, task.status]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase(),
      };
    });
}

export function filterTeammateTaskRows(
  rows: readonly TeammateTaskRowViewModel[],
  query: string,
  filter: TeammateTaskFilter,
): readonly TeammateTaskRowViewModel[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (normalizedQuery && !row.searchText.includes(normalizedQuery)) return false;
    if (filter === "active") return activeStatuses.has(row.task.status);
    if (filter === "attention") return attentionStatuses.has(row.task.status);
    if (filter === "completed") return completedStatuses.has(row.task.status);
    return true;
  });
}

export function summarizeTeammateTasks(rows: readonly TeammateTaskRowViewModel[]): TeammateTaskStats {
  return rows.reduce<TeammateTaskStats>((summary, row) => ({
    total: summary.total + 1,
    active: summary.active + (activeStatuses.has(row.task.status) ? 1 : 0),
    attention: summary.attention + (attentionStatuses.has(row.task.status) ? 1 : 0),
    completed: summary.completed + (completedStatuses.has(row.task.status) ? 1 : 0),
  }), { total: 0, active: 0, attention: 0, completed: 0 });
}

export function taskStatusLabelKey(status: TaskStatus): string {
  if (status === "todo") return "To do";
  if (status === "claimed") return "Claimed";
  if (status === "running") return "Running";
  if (status === "blocked") return "Blocked";
  if (status === "review") return "In review";
  if (status === "done") return "Done";
  if (status === "failed") return "Failed";
  return "Cancelled";
}

export function taskStatusTone(status: TaskStatus): StatusTone {
  if (status === "done") return "success";
  if (status === "blocked") return "warning";
  if (status === "failed") return "danger";
  if (status === "claimed" || status === "running" || status === "review") return "info";
  return "neutral";
}
