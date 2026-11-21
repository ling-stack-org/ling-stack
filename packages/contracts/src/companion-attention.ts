import type { ApprovalRisk, ApprovalStatus } from "./approvals.js";
import type { UserInputAnswerAuthorityV1, UserInputQuestionV1, UserInputRequestStatusV1 } from "./user-input.js";

/**
 * Workspace-scoped work that can be surfaced by the Companion without making
 * the floating surface a second conversation or workflow store.
 */
export const companionAttentionKinds = [
  "user_input",
  "approval",
  "blocker",
  "handoff",
  "terminal_report",
  "progress",
] as const;
export type CompanionAttentionKind = (typeof companionAttentionKinds)[number];

export const companionAttentionStatuses = ["pending", "active", "resolved", "stale"] as const;
export type CompanionAttentionStatus = (typeof companionAttentionStatuses)[number];

export const companionAttentionPriorityClasses = [
  "required_input",
  "approval",
  "optional_input",
  "blocker",
  "handoff",
  "result",
  "progress",
] as const;
export type CompanionAttentionPriorityClass = (typeof companionAttentionPriorityClasses)[number];

const companionAttentionPriorityRank: Readonly<Record<CompanionAttentionPriorityClass, number>> = {
  required_input: 0,
  approval: 1,
  optional_input: 2,
  blocker: 3,
  handoff: 4,
  result: 5,
  progress: 6,
};

export interface CompanionAttentionActor {
  readonly teammateId?: string;
  readonly label: string;
  readonly kind: "teammate" | "workflow" | "system";
}

/**
 * Typed source identity for deep links and actions. IDs remain canonical IDs
 * from the owning domain and are never inferred from display text.
 */
export interface CompanionAttentionSource {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly kind: CompanionAttentionKind;
  readonly id: string;
  readonly sourceItemId?: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly workflowStepId?: string;
  readonly requestId?: string;
  readonly approvalId?: string;
  readonly reportId?: string;
  readonly revision?: number;
}

export type CompanionAttentionAction =
  | { readonly kind: "answer"; readonly enabled: boolean; readonly source: CompanionAttentionSource }
  | { readonly kind: "approve"; readonly enabled: boolean; readonly source: CompanionAttentionSource }
  | { readonly kind: "open_source"; readonly enabled: boolean; readonly source: CompanionAttentionSource };

export interface CompanionAttentionUserInputPayload {
  readonly kind: "user_input";
  readonly requestId: string;
  readonly requestVersion: number;
  readonly statusRevision: number;
  readonly status: UserInputRequestStatusV1;
  readonly waitMode: "optional" | "required";
  readonly questions: readonly UserInputQuestionV1[];
  readonly answerAuthority?: UserInputAnswerAuthorityV1;
}

export interface CompanionAttentionApprovalPayload {
  readonly kind: "approval";
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly risk: ApprovalRisk;
  readonly expiresAt?: string;
}

export interface CompanionAttentionBlockerPayload {
  readonly kind: "blocker";
  readonly blockerCode?: string;
  readonly nextAction?: string;
}

export interface CompanionAttentionHandoffPayload {
  readonly kind: "handoff";
  readonly handoffId: string;
  readonly fromParticipant?: string;
  readonly toParticipant?: string;
  readonly requestedOutput?: string;
}

export interface CompanionAttentionReportPayload {
  readonly kind: "terminal_report";
  readonly reportId: string;
  readonly outcomeStatus: "succeeded" | "partially_succeeded" | "blocked" | "failed" | "cancelled";
  readonly verificationSummary?: string;
  readonly artifactId?: string;
}

export interface CompanionAttentionProgressPayload {
  readonly kind: "progress";
  readonly runId?: string;
  readonly workflowStepId?: string;
  readonly phase?: string;
}

export type CompanionAttentionPayload =
  | CompanionAttentionUserInputPayload
  | CompanionAttentionApprovalPayload
  | CompanionAttentionBlockerPayload
  | CompanionAttentionHandoffPayload
  | CompanionAttentionReportPayload
  | CompanionAttentionProgressPayload;

export interface CompanionAttentionItem {
  readonly schemaVersion: 1;
  /** Stable presentation key, normally `${source.kind}:${source.id}`. */
  readonly id: string;
  readonly priority: CompanionAttentionPriorityClass;
  readonly status: CompanionAttentionStatus;
  readonly source: CompanionAttentionSource;
  readonly actor?: CompanionAttentionActor;
  readonly title: string;
  readonly summary: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payload: CompanionAttentionPayload;
  readonly action?: CompanionAttentionAction;
}

export interface CompanionAttentionProjection {
  readonly schemaVersion: 1;
  readonly cwd: string;
  readonly generatedAt: string;
  readonly items: readonly CompanionAttentionItem[];
}

export type CompanionAttentionProjectionResponse = CompanionAttentionProjection;

/** Actionable items stay ahead of resolved result briefs. */
export function isCompanionAttentionPending(item: CompanionAttentionItem): boolean {
  return item.status === "pending" || item.status === "active";
}

/**
 * Deduplicate replayed source records, then order the queue deterministically.
 * The input is never mutated and source revisions win over stale replays.
 */
export function orderCompanionAttentionItems(
  items: readonly CompanionAttentionItem[],
): CompanionAttentionItem[] {
  const latest = new Map<string, CompanionAttentionItem>();
  for (const item of items) {
    const key = companionAttentionSourceKey(item.source);
    const current = latest.get(key);
    if (!current || isNewerCompanionAttentionItem(item, current)) latest.set(key, item);
  }
  return [...latest.values()].sort(compareCompanionAttentionItems);
}

export function companionAttentionSourceKey(source: CompanionAttentionSource): string {
  return `${source.kind}:${source.id}`;
}

function isNewerCompanionAttentionItem(next: CompanionAttentionItem, current: CompanionAttentionItem): boolean {
  if (next.revision !== current.revision) return next.revision > current.revision;
  if (next.updatedAt !== current.updatedAt) return next.updatedAt > current.updatedAt;
  return next.id > current.id;
}

function compareCompanionAttentionItems(left: CompanionAttentionItem, right: CompanionAttentionItem): number {
  const leftPending = isCompanionAttentionPending(left);
  const rightPending = isCompanionAttentionPending(right);
  if (leftPending !== rightPending) return leftPending ? -1 : 1;
  const priority = companionAttentionPriorityRank[left.priority] - companionAttentionPriorityRank[right.priority];
  if (priority !== 0) return priority;
  if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
  return left.id.localeCompare(right.id);
}
