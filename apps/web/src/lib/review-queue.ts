import { effectiveApprovalStatus } from "./approvals.js";
import type { ApprovalRequest, ExternalWorkActionView, RunSession } from "../types.js";

export type ReviewQueueItemCategory =
  | "approve_external_action"
  | "execute_approved_action"
  | "route"
  | "repair"
  | "offline_local_approval";

export interface ReviewQueueItem {
  readonly id: string;
  readonly category: ReviewQueueItemCategory;
  readonly approval: ApprovalRequest;
  readonly externalAction?: ExternalWorkActionView;
  readonly run?: RunSession;
  readonly title: string;
  readonly description: string;
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly createdAt: string;
}

export interface BuildReviewQueueItemsInput {
  readonly approvals: readonly ApprovalRequest[];
  readonly externalActionDetails?: Readonly<Record<string, ExternalWorkActionView>>;
  readonly runsById?: ReadonlyMap<string, RunSession>;
  readonly inlineApprovalIds?: ReadonlySet<string>;
}

export function buildReviewQueueItems(input: BuildReviewQueueItemsInput): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  for (const approval of input.approvals) {
    if (input.inlineApprovalIds?.has(approval.id)) {
      continue;
    }
    const externalAction = approval.externalWorkActionId ? input.externalActionDetails?.[approval.externalWorkActionId] : undefined;
    const run = approval.runId ? input.runsById?.get(approval.runId) : undefined;
    const status = effectiveApprovalStatus(approval);
    const category = reviewQueueCategoryForApproval(approval, externalAction, run);
    if (!category) {
      continue;
    }
    if (status !== "pending" && category !== "execute_approved_action" && category !== "repair") {
      continue;
    }
    items.push({
      id: `${category}:${approval.id}`,
      category,
      approval,
      externalAction,
      run,
      title: approval.title,
      description: approval.description,
      priority: reviewQueuePriority(approval),
      createdAt: approval.createdAt,
    });
  }
  return items.sort(compareReviewQueueItems);
}

export function reviewQueueCategoryLabel(category: ReviewQueueItemCategory): string {
  switch (category) {
    case "approve_external_action":
      return "Approve external action";
    case "execute_approved_action":
      return "Execute approved action";
    case "route":
      return "Route";
    case "repair":
      return "Repair";
    case "offline_local_approval":
      return "Offline local approval";
  }
}

function reviewQueueCategoryForApproval(
  approval: ApprovalRequest,
  externalAction: ExternalWorkActionView | undefined,
  run: RunSession | undefined,
): ReviewQueueItemCategory | undefined {
  const status = effectiveApprovalStatus(approval);
  if (approval.externalWorkActionId) {
    if (externalAction?.action.status === "approved" || status === "approved") {
      return "execute_approved_action";
    }
    if (status === "pending") {
      return "approve_external_action";
    }
    if (status === "expired" || status === "denied" || status === "cancelled" || externalAction?.action.status === "failed" || externalAction?.action.status === "stale_target") {
      return "repair";
    }
  }
  if (status === "expired") {
    return "repair";
  }
  if (run?.status === "failed" || run?.status === "cancelled") {
    return "repair";
  }
  if (status === "pending") {
    return approval.channelId ? "offline_local_approval" : "route";
  }
  return undefined;
}

function reviewQueuePriority(approval: ApprovalRequest): ReviewQueueItem["priority"] {
  if (approval.risk === "critical") {
    return "urgent";
  }
  if (approval.risk === "high") {
    return "high";
  }
  if (approval.risk === "medium") {
    return "normal";
  }
  return "low";
}

function compareReviewQueueItems(left: ReviewQueueItem, right: ReviewQueueItem): number {
  const priorityDelta = priorityRank(right.priority) - priorityRank(left.priority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

function priorityRank(priority: ReviewQueueItem["priority"]): number {
  switch (priority) {
    case "urgent":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    case "low":
      return 1;
  }
}
