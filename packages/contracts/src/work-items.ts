export type WorkItemStatus =
  | "intake"
  | "triage"
  | "backlog"
  | "ready"
  | "running"
  | "waiting"
  | "review"
  | "blocked"
  | "done"
  | "archived";

export type WorkItemSourceType =
  | "channel_task"
  | "channel_workflow_step"
  | "external_work"
  | "external_work_action"
  | "approval"
  | "run"
  | "manual";

export type WorkItemWaitingReason = "approval" | "external" | "handoff" | "resource" | "user" | "scheduler" | "provider";

export type WorkItemPriority = "low" | "normal" | "high" | "urgent";

export interface WorkItemClaim {
  readonly ownerId: string;
  readonly token: string;
  readonly claimedAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface WorkItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly sourceType: WorkItemSourceType;
  readonly sourceId: string;
  readonly title: string;
  readonly description?: string;
  readonly status: WorkItemStatus;
  readonly waitingReason?: WorkItemWaitingReason;
  readonly priority: WorkItemPriority;
  readonly labels: readonly string[];
  readonly assigneeTeammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly externalWorkActionId?: string;
  readonly approvalId?: string;
  readonly artifactIds: readonly string[];
  readonly proofArtifactIds: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly claim?: WorkItemClaim;
  readonly attemptCount: number;
  readonly retryBudget: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly failureReason?: string;
}

export type WorkItemView = WorkItem;

export interface ListWorkItemsRequest {
  readonly channelId?: string;
  readonly status?: WorkItemStatus;
  readonly sourceType?: WorkItemSourceType;
  readonly assigneeTeammateId?: string;
  readonly limit?: number;
}

export interface WorkItemRouteRequest {
  readonly channelId?: string;
  readonly priority?: WorkItemPriority;
  readonly assigneeTeammateId?: string | null;
}

export interface WorkItemClaimRequest {
  readonly ownerId: string;
  readonly leaseMs?: number;
}

export interface WorkItemHeartbeatRequest {
  readonly claimToken: string;
  readonly leaseMs?: number;
}

export interface WorkItemClaimBlocker {
  readonly code: "dependency_blocked" | "already_claimed" | "retry_budget_exhausted" | "terminal";
  readonly message: string;
  readonly dependencyIds?: readonly string[];
  readonly claimedBy?: string;
  readonly claimExpiresAt?: string;
}

export interface WorkItemListResponse {
  readonly cwd: string;
  readonly workItems: readonly WorkItemView[];
}

export interface WorkItemDetailResponse {
  readonly cwd: string;
  readonly workItem: WorkItemView;
}

export interface WorkItemMutationResponse {
  readonly cwd: string;
  readonly workItem: WorkItemView;
}

export interface WorkItemClaimResponse extends WorkItemMutationResponse {
  readonly claimToken?: string;
  readonly blocker?: WorkItemClaimBlocker;
}

export interface WorkItemReleaseRequest {
  readonly claimToken: string;
}

export interface WorkItemCompleteRequest {
  readonly claimToken: string;
  readonly proofArtifactIds?: readonly string[];
}

export interface WorkItemFailRequest {
  readonly claimToken: string;
  readonly reason: string;
  readonly retry?: boolean;
}
