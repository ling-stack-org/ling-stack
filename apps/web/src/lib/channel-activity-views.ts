import type { ChannelActivityAttention, ChannelActivityCategory, ChannelActivityItem } from "./channel-activity.js";

export type ChannelActivityViewCategoryFilter = "all" | ChannelActivityCategory;
export type ChannelActivityViewAttentionFilter = "all" | "needs_attention" | Exclude<ChannelActivityAttention, "none">;
export type ChannelAttentionQueueTarget =
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "approval"; readonly runId?: string }
  | { readonly kind: "protocol"; readonly mode: "brief" | "decisions" | "handoffs" | "runtime" };

export interface ChannelActivityViewFilter {
  readonly categoryFilter: ChannelActivityViewCategoryFilter;
  readonly attentionFilter: ChannelActivityViewAttentionFilter;
  readonly search: string;
}

export interface ChannelActivitySavedView {
  readonly id: string;
  readonly name: string;
  readonly filter: ChannelActivityViewFilter;
  readonly builtin: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelAttentionQueueItem {
  readonly id: string;
  readonly activityItemId: string;
  readonly attention: Exclude<ChannelActivityAttention, "none">;
  readonly category: ChannelActivityCategory;
  readonly createdAt: string;
  readonly title: string;
  readonly description: string;
  readonly target: ChannelAttentionQueueTarget;
}

export const maxCustomChannelActivitySavedViews = 8;
export const allChannelActivitySavedViewId = "builtin:all";

const savedViewsStoragePrefix = "ling-stack.channelActivitySavedViews";
const builtinCreatedAt = "1970-01-01T00:00:00.000Z";

export const builtinChannelActivitySavedViews: readonly ChannelActivitySavedView[] = [
  builtinView("all", "All", { categoryFilter: "all", attentionFilter: "all", search: "" }),
  builtinView("needs_attention", "Needs attention", { categoryFilter: "all", attentionFilter: "needs_attention", search: "" }),
  builtinView("blocked", "Blocked", { categoryFilter: "all", attentionFilter: "blocked", search: "" }),
  builtinView("failed", "Failed", { categoryFilter: "all", attentionFilter: "failed", search: "" }),
  builtinView("pending_approvals", "Pending approvals", { categoryFilter: "approval", attentionFilter: "pending", search: "" }),
  builtinView("failed_work", "Failed work", { categoryFilter: "work", attentionFilter: "failed", search: "" }),
  builtinView("runtime", "Runtime", { categoryFilter: "runtime", attentionFilter: "all", search: "" }),
];

export function applyActivityViewFilter(
  items: readonly ChannelActivityItem[],
  filter: ChannelActivityViewFilter,
): readonly ChannelActivityItem[] {
  const query = filter.search.trim().toLowerCase();
  return items.filter((item) => {
    const searchMatches = !query || item.searchText.includes(query);
    const categoryMatches = filter.categoryFilter === "all" || item.category === filter.categoryFilter;
    const attentionMatches = activityMatchesViewAttentionFilter(filter.attentionFilter, item.attention);
    return searchMatches && categoryMatches && attentionMatches;
  });
}

export function activityMatchesViewAttentionFilter(
  filter: ChannelActivityViewAttentionFilter,
  attention: ChannelActivityAttention,
): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "needs_attention") {
    return attention !== "none";
  }
  return attention === filter;
}

export function buildAttentionQueueItems(items: readonly ChannelActivityItem[]): readonly ChannelAttentionQueueItem[] {
  return items
    .filter((item) => item.attention !== "none")
    .map((item) => queueItemFromActivityItem(item))
    .filter((item): item is ChannelAttentionQueueItem => item !== undefined)
    .sort((left, right) => {
      const attentionComparison = attentionRank(left.attention) - attentionRank(right.attention);
      if (attentionComparison !== 0) {
        return attentionComparison;
      }
      const timeComparison = right.createdAt.localeCompare(left.createdAt);
      return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
    });
}

export function readCustomChannelActivitySavedViews(cwd: string, channelId: string): readonly ChannelActivitySavedView[] {
  if (!cwd.trim() || !channelId.trim()) {
    return [];
  }
  try {
    const raw = globalThis.localStorage?.getItem(savedViewsStorageKey(cwd, channelId));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.views)) {
      return [];
    }
    return parseCustomChannelActivitySavedViewsValue(parsed.views);
  } catch {
    return [];
  }
}

export function parseCustomChannelActivitySavedViewsValue(value: unknown): readonly ChannelActivitySavedView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((view) => parseCustomView(view))
    .filter((view): view is ChannelActivitySavedView => view !== undefined)
    .slice(0, maxCustomChannelActivitySavedViews);
}

export function writeCustomChannelActivitySavedViews(
  cwd: string,
  channelId: string,
  views: readonly ChannelActivitySavedView[],
): void {
  if (!cwd.trim() || !channelId.trim()) {
    return;
  }
  try {
    const customViews = views.filter((view) => !view.builtin).slice(0, maxCustomChannelActivitySavedViews);
    globalThis.localStorage?.setItem(
      savedViewsStorageKey(cwd, channelId),
      JSON.stringify({
        version: 1,
        views: customViews.map((view) => ({
          id: view.id,
          name: sanitizeSavedViewName(view.name),
          filter: sanitizeChannelActivityViewFilter(view.filter),
          createdAt: view.createdAt,
          updatedAt: view.updatedAt,
        })),
      }),
    );
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function createCustomChannelActivitySavedView(name: string, filter: ChannelActivityViewFilter): ChannelActivitySavedView {
  const now = new Date().toISOString();
  return {
    id: `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: sanitizeSavedViewName(name),
    filter: sanitizeChannelActivityViewFilter(filter),
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function sanitizeSavedViewName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 40) : "Custom view";
}

export function sanitizeChannelActivityViewFilter(filter: ChannelActivityViewFilter): ChannelActivityViewFilter {
  return {
    categoryFilter: isCategoryFilter(filter.categoryFilter) ? filter.categoryFilter : "all",
    attentionFilter: isAttentionFilter(filter.attentionFilter) ? filter.attentionFilter : "all",
    search: filter.search.trim().slice(0, 160),
  };
}

function builtinView(id: string, name: string, filter: ChannelActivityViewFilter): ChannelActivitySavedView {
  return {
    id: `builtin:${id}`,
    name,
    filter,
    builtin: true,
    createdAt: builtinCreatedAt,
    updatedAt: builtinCreatedAt,
  };
}

function queueItemFromActivityItem(item: ChannelActivityItem): ChannelAttentionQueueItem | undefined {
  const attention = item.attention === "none" ? undefined : item.attention;
  if (!attention) {
    return undefined;
  }
  if (item.kind === "decision") {
    return {
      id: `queue:${item.id}`,
      activityItemId: item.id,
      attention,
      category: item.category,
      createdAt: item.createdAt,
      title: item.record.title,
      description: item.record.status,
      target: { kind: "protocol", mode: "decisions" },
    };
  }
  if (item.kind === "handoff") {
    return {
      id: `queue:${item.id}`,
      activityItemId: item.id,
      attention,
      category: item.category,
      createdAt: item.createdAt,
      title: `${item.record.fromParticipantLabel} -> ${item.record.toParticipantLabel}`,
      description: item.record.status,
      target: { kind: "protocol", mode: "handoffs" },
    };
  }
  if (item.kind === "workflow") {
    return {
      id: `queue:${item.id}`,
      activityItemId: item.id,
      attention,
      category: item.category,
      createdAt: item.createdAt,
      title: item.record.title,
      description: item.record.status,
      target: { kind: "protocol", mode: "runtime" },
    };
  }
  if (item.kind === "workflow-step") {
    return {
      id: `queue:${item.id}`,
      activityItemId: item.id,
      attention,
      category: item.category,
      createdAt: item.createdAt,
      title: item.record.title,
      description: item.record.blocker ?? item.record.status,
      target: { kind: "protocol", mode: "runtime" },
    };
  }
  if (item.kind === "task") {
    return {
      id: `queue:${item.id}`,
      activityItemId: item.id,
      attention,
      category: item.category,
      createdAt: item.createdAt,
      title: item.record.title,
      description: item.record.status,
      target: { kind: "task", taskId: item.record.id },
    };
  }
  if (item.kind === "run") {
    const snapshotTitle = isRecord(item.record.taskSnapshot) && typeof item.record.taskSnapshot.title === "string"
      ? item.record.taskSnapshot.title
      : undefined;
    return {
      id: `queue:${item.id}`,
      activityItemId: item.id,
      attention,
      category: item.category,
      createdAt: item.createdAt,
      title: `Run ${item.record.id}`,
      description: `${item.task?.title ?? snapshotTitle ?? item.record.taskId} · ${item.record.status}`,
      target: { kind: "run", runId: item.record.id },
    };
  }
  if (item.kind === "approval") {
    return {
      id: `queue:${item.id}`,
      activityItemId: item.id,
      attention,
      category: item.category,
      createdAt: item.createdAt,
      title: item.record.title,
      description: item.record.status,
      target: { kind: "approval", runId: item.record.runId },
    };
  }
  if (item.kind === "state-transition") {
    return {
      id: `queue:${item.id}`,
      activityItemId: item.id,
      attention,
      category: item.category,
      createdAt: item.createdAt,
      title: `${item.record.entityType} ${item.record.toStatus}`,
      description: item.record.event,
      target: stateTransitionTarget(item.record.entityType, item.record.entityId),
    };
  }
  return undefined;
}

function stateTransitionTarget(entityType: string, entityId: string): ChannelAttentionQueueTarget {
  if (entityType === "task") {
    return { kind: "task", taskId: entityId };
  }
  if (entityType === "run") {
    return { kind: "run", runId: entityId };
  }
  if (entityType === "approval") {
    return { kind: "approval" };
  }
  return { kind: "protocol", mode: "runtime" };
}

function attentionRank(attention: Exclude<ChannelActivityAttention, "none">): number {
  if (attention === "blocked") {
    return 0;
  }
  if (attention === "failed") {
    return 1;
  }
  return 2;
}

function parseCustomView(value: unknown): ChannelActivitySavedView | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !isRecord(value.filter)) {
    return undefined;
  }
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  const categoryFilter = typeof value.filter.categoryFilter === "string" && isCategoryFilter(value.filter.categoryFilter)
    ? value.filter.categoryFilter
    : "all";
  const attentionFilter = typeof value.filter.attentionFilter === "string" && isAttentionFilter(value.filter.attentionFilter)
    ? value.filter.attentionFilter
    : "all";
  return {
    id: value.id.startsWith("custom:") ? value.id : `custom:${value.id}`,
    name: sanitizeSavedViewName(value.name),
    filter: sanitizeChannelActivityViewFilter({
      categoryFilter,
      attentionFilter,
      search: typeof value.filter.search === "string" ? value.filter.search : "",
    }),
    builtin: false,
    createdAt,
    updatedAt,
  };
}

function savedViewsStorageKey(cwd: string, channelId: string): string {
  return `${savedViewsStoragePrefix}.${encodeURIComponent(cwd.trim())}.${encodeURIComponent(channelId.trim())}`;
}

function isCategoryFilter(value: string): value is ChannelActivityViewCategoryFilter {
  return value === "all" || value === "message" || value === "work" || value === "approval" || value === "protocol" || value === "runtime";
}

function isAttentionFilter(value: string): value is ChannelActivityViewAttentionFilter {
  return value === "all" || value === "needs_attention" || value === "blocked" || value === "failed" || value === "pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
