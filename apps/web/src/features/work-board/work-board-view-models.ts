import {
  isActionableWorkItem,
  isTerminalWorkItemView,
  workItemActionGroup,
  workItemActionGroupLabel,
  workItemActionGroupOrder,
  type WorkItemStatus,
  type WorkItemView,
} from "../../lib/work-items.js";
import type {
  WorkBoardActionView,
  WorkBoardFilters,
  WorkBoardGroupView,
  WorkBoardMutation,
  WorkBoardScope,
  WorkBoardSort,
  WorkBoardStats,
} from "./work-board-types.js";

export const workBoardScopeOrder: readonly WorkBoardScope[] = ["actionable", "global", "channel", "mine", "blocked", "history"];
export const workBoardSortOrder: readonly WorkBoardSort[] = ["updated-desc", "priority", "updated-asc"];
export const emptyWorkBoardFilters: WorkBoardFilters = {
  channelId: "",
  owner: "",
  priority: "",
  source: "",
  status: "",
  waitingReason: "",
};

export function workBoardScopeLabel(scope: WorkBoardScope): string {
  return ({ actionable: "Needs action", global: "All active", channel: "Channel", mine: "Mine", blocked: "Blocked", history: "History" })[scope];
}

export function workBoardScopeTitle(scope: WorkBoardScope): string {
  return ({ actionable: "Needs action", global: "All active work", channel: "Channel work", mine: "My work", blocked: "Blocked work", history: "Work history" })[scope];
}

export function workBoardSortLabel(sort: WorkBoardSort): string {
  return ({ "updated-desc": "Recently updated", priority: "Priority", "updated-asc": "Oldest updated" })[sort];
}

export function countActiveFilters(filters: WorkBoardFilters): number {
  return Object.values(filters).filter(Boolean).length;
}

export function filterAndSortWorkItems(input: {
  readonly items: readonly WorkItemView[];
  readonly scope: WorkBoardScope;
  readonly query: string;
  readonly filters: WorkBoardFilters;
  readonly sort: WorkBoardSort;
  readonly channelNames: ReadonlyMap<string, string>;
}): WorkItemView[] {
  const query = input.query.trim().toLocaleLowerCase();
  return input.items
    .filter((item) => matchesScope(item, input.scope))
    .filter((item) => matchesFilters(item, input.filters))
    .filter((item) => !query || searchableWorkItemText(item, input.channelNames).includes(query))
    .sort(workBoardComparator(input.sort));
}

export function buildWorkBoardGroups(items: readonly WorkItemView[], scope: WorkBoardScope): WorkBoardGroupView[] {
  if (scope === "history") {
    const dates = new Map<string, WorkItemView[]>();
    for (const item of items) {
      const key = item.updatedAt.slice(0, 10) || "Unknown date";
      dates.set(key, [...(dates.get(key) ?? []), item]);
    }
    return [...dates.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([key, group]) => ({ key, label: key, items: group }));
  }
  return workItemActionGroupOrder.map((key) => ({ key, label: workItemActionGroupLabel(key), items: items.filter((item) => workItemActionGroup(item) === key) }));
}

export function readWorkBoardStats(items: readonly WorkItemView[]): WorkBoardStats {
  return {
    actionable: items.filter(isActionableWorkItem).length,
    running: items.filter((item) => item.status === "running").length,
    blocked: items.filter((item) => item.status === "blocked" || item.status === "waiting").length,
    completed: items.filter(isTerminalWorkItemView).length,
  };
}

export function workItemStatusTone(status: WorkItemStatus): "neutral" | "info" | "warning" | "danger" | "success" {
  if (status === "running" || status === "triage") return "info";
  if (status === "waiting" || status === "review") return "warning";
  if (status === "blocked") return "danger";
  if (status === "done") return "success";
  return "neutral";
}

export function derivePrimaryWorkBoardAction(item: WorkItemView, input: {
  readonly busy?: WorkBoardMutation;
  readonly canClaim?: boolean;
  readonly canOpenTask?: boolean;
  readonly canOpenRun?: boolean;
  readonly canOpenApproval?: boolean;
  readonly canOpenChannel?: boolean;
  readonly canRoute?: boolean;
  readonly canHeartbeat?: boolean;
  readonly preferClaimControl?: boolean;
}): WorkBoardActionView | undefined {
  let target: WorkBoardActionView["target"];
  let label = "";
  if (item.approvalId && input.canOpenApproval) [target, label] = ["approval", "Handle approval"];
  else if (item.durable && !item.claim && !isTerminalWorkItemView(item) && input.canClaim) [target, label] = ["claim", "Claim"];
  else if (input.preferClaimControl && item.durable && item.claim && input.canHeartbeat) [target, label] = ["heartbeat", "Refresh claim"];
  else if (item.status === "blocked" && item.runId && input.canOpenRun) [target, label] = ["run", "View failure"];
  else if (item.runId && input.canOpenRun) [target, label] = ["run", "Open run"];
  else if (item.taskId && input.canOpenTask) [target, label] = ["task", "Open task"];
  else if (item.externalWorkId && !item.channelId && input.canRoute) [target, label] = ["route", "Route to channel"];
  else if (item.channelId && input.canOpenChannel) [target, label] = ["channel", "Open channel"];
  if (!target) return undefined;
  return { id: `${item.id}:${target}`, label, kind: "primary", target, disabled: Boolean(input.busy), loading: input.busy === target };
}

export function matchesScope(item: WorkItemView, scope: WorkBoardScope): boolean {
  if (scope === "actionable") return isActionableWorkItem(item);
  if (scope === "global") return !isTerminalWorkItemView(item);
  if (scope === "channel") return Boolean(item.channelId) && !isTerminalWorkItemView(item);
  if (scope === "mine") return Boolean(item.assigneeTeammateId || item.claim) && !isTerminalWorkItemView(item);
  if (scope === "blocked") return item.status === "blocked" || item.status === "waiting";
  return isTerminalWorkItemView(item);
}

function matchesFilters(item: WorkItemView, filters: WorkBoardFilters): boolean {
  if (filters.channelId && item.channelId !== filters.channelId) return false;
  if (filters.status && item.status !== filters.status) return false;
  if (filters.source && item.sourceType !== filters.source) return false;
  if (filters.waitingReason && item.waitingReason !== filters.waitingReason) return false;
  if (filters.priority && item.priority !== filters.priority) return false;
  if (filters.owner === "unassigned" && (item.assigneeTeammateId || item.claim)) return false;
  if (filters.owner === "claimed" && !item.claim) return false;
  if (filters.owner.startsWith("teammate:") && item.assigneeTeammateId !== filters.owner.slice(9)) return false;
  return true;
}

function searchableWorkItemText(item: WorkItemView, channelNames: ReadonlyMap<string, string>): string {
  return [item.title, item.subtitle, item.id, item.sourceId, item.sourceType, item.status, item.waitingReason, item.assigneeTeammateId,
    item.channelId ? channelNames.get(item.channelId) : undefined, item.taskId, item.runId, item.approvalId, ...item.labels]
    .filter(Boolean).join(" ").toLocaleLowerCase();
}

function workBoardComparator(sort: WorkBoardSort): (left: WorkItemView, right: WorkItemView) => number {
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
  if (sort === "priority") return (left, right) => priority[left.priority] - priority[right.priority] || right.updatedAt.localeCompare(left.updatedAt);
  if (sort === "updated-asc") return (left, right) => left.updatedAt.localeCompare(right.updatedAt);
  return (left, right) => right.updatedAt.localeCompare(left.updatedAt);
}
