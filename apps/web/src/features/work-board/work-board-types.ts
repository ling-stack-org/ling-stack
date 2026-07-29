import type { RunArtifact, WorkItemClaimBlocker } from "../../types.js";
import type {
  WorkItemSourceType,
  WorkItemStatus,
  WorkItemView,
  WorkItemWaitingReason,
} from "../../lib/work-items.js";

export type WorkBoardScope = "actionable" | "global" | "channel" | "mine" | "blocked" | "history";
export type WorkBoardSort = "updated-desc" | "priority" | "updated-asc";
export type WorkBoardFreshness = "initial" | "fresh" | "refreshing" | "partial" | "stale" | "capped" | "error";
export type WorkBoardMutation = "claim" | "heartbeat" | "release" | "complete" | "fail" | "route";

export interface WorkBoardOpenIntent {
  readonly requestId: number;
  readonly scope: WorkBoardScope;
  readonly itemId?: string;
}

export interface WorkBoardFilters {
  readonly channelId: string;
  readonly owner: "" | "unassigned" | "claimed" | `teammate:${string}`;
  readonly priority: "" | WorkItemView["priority"];
  readonly source: "" | WorkItemSourceType;
  readonly status: "" | WorkItemStatus;
  readonly waitingReason: "" | WorkItemWaitingReason;
}

export type WorkBoardSourceName =
  | "tasks"
  | "runs"
  | "approvals"
  | "work-items"
  | "workflows"
  | "external-ci"
  | "external-actions";

export interface WorkBoardSourceIssue {
  readonly kind: "load" | "capped";
  readonly source: WorkBoardSourceName;
  readonly message: string;
  readonly technicalMessage?: string;
}

export interface WorkBoardActionFailure {
  readonly action: WorkBoardMutation;
  readonly itemId: string;
  readonly message: string;
  readonly technicalMessage?: string;
}

export interface WorkBoardEvidenceState {
  readonly itemId: string;
  readonly runId: string;
  readonly status: "idle" | "loading" | "ready" | "empty" | "stale" | "error";
  readonly artifacts: readonly RunArtifact[];
  readonly issue?: WorkBoardSourceIssue;
}

export interface WorkBoardActionView {
  readonly id: string;
  readonly label: string;
  readonly kind: "primary" | "secondary" | "danger";
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly loading: boolean;
  readonly target?: "task" | "run" | "approval" | "channel" | "route" | "claim" | "heartbeat" | "release" | "complete" | "fail";
}

export interface WorkBoardGroupView {
  readonly key: string;
  readonly label: string;
  readonly items: readonly WorkItemView[];
}

export interface WorkBoardStats {
  readonly actionable: number;
  readonly running: number;
  readonly blocked: number;
  readonly completed: number;
}

export interface WorkBoardMutationProjection {
  readonly busyByWorkItemId?: ReadonlyMap<string, WorkBoardMutation>;
  readonly failureByWorkItemId?: ReadonlyMap<string, WorkBoardActionFailure>;
  readonly blockerByWorkItemId?: ReadonlyMap<string, WorkItemClaimBlocker>;
  readonly routingByExternalWorkId?: ReadonlySet<string>;
  readonly busyWorkItemId?: string;
  readonly routingExternalWorkId?: string;
}
