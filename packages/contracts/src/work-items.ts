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
  | "automation_run"
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
  readonly linkedExecution?: WorkItemLinkedExecution;
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
  readonly planRevision?: string;
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

export interface WorkItemLinkedExecution {
  readonly kind: "channel_task" | "automation_run";
  readonly id: string;
  readonly status: string;
  readonly runId?: string;
}

export type NativeWorkIntakeSourceKind = WorkItemLinkedExecution["kind"];

export interface WorkIntakeBudget {
  readonly maxConcurrent: number;
  readonly maxStartsPerWindow: number;
  readonly windowMs: number;
}

export interface WorkIntakeQuietHours {
  readonly timeZone: string;
  readonly start: string;
  readonly end: string;
}

export interface NativeWorkIntakeReceipt {
  readonly receiptId: string;
  readonly workspaceId: string;
  readonly policyId: string;
  readonly policyRevision: string;
  readonly sourceKind: NativeWorkIntakeSourceKind;
  readonly sourceScope: string;
  readonly sourceEventId: string;
  readonly sourceRevision: string;
  readonly executionId: string;
  readonly outcome: "manual" | "suggested" | "accepted" | "suppressed" | "paused" | "deduplicated";
  readonly reasonCode: string;
  readonly workItemId?: string;
  readonly evaluatedAt: string;
  readonly previousReceiptId?: string;
  readonly dispatch?: {
    readonly status: "pending" | "admitted" | "held";
    readonly runId?: string;
    readonly reasonCode?: string;
  };
}

export interface ListNativeWorkIntakeRequest {
  readonly sourceKind: NativeWorkIntakeSourceKind;
  readonly sourceScope?: string;
  readonly limit?: number;
}

export interface RetryNativeWorkIntakeRequest {
  readonly receiptId: string;
  readonly idempotencyKey: string;
}

export interface ListNativeWorkIntakeResponse {
  readonly cwd: string;
  readonly receipts: readonly NativeWorkIntakeReceipt[];
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
  readonly code: "dependency_blocked" | "already_claimed" | "retry_budget_exhausted" | "terminal" | "control_blocked";
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
  readonly workflow?: import("./app-server.js").LingAppServerWorkItemWorkflowStages;
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
