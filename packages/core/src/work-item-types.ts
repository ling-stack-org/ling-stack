import { randomUUID } from "node:crypto";
import type {
  LingAppServerGitHubDelivery, LingAppServerGitHubIntakeReceipt, LingAppServerWorkItemAcceptance,
  LingAppServerWorkItemConversationDispatch, LingAppServerWorkItemSourceReceipt,
} from "@ling-stack/contracts";
import type { ControlPlaneEvent } from "./run-types.js";

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
  | "cancelled"
  | "superseded"
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

export type WorkItemControlState = "active" | "pausing" | "paused" | "cancelling" | "cancelled" | "blocked";
export type WorkItemControlAction = "pause" | "resume" | "cancel";

export interface WorkItemControlReceipt {
  readonly id: string;
  readonly action: WorkItemControlAction;
  readonly generation: number;
  readonly requestedAt: string;
  readonly actorId: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
  readonly outcome: "accepted" | "settling" | "settled" | "blocked";
}

export interface WorkItemHold {
  readonly id: string;
  readonly kind: "plan" | "control" | "approval" | "unknown_effect" | "scope" | "dependency";
  readonly ownerRef: string;
  readonly reason: string;
  readonly blocksNewAdmission: boolean;
}

export interface WorkItemControlProjection {
  readonly state: WorkItemControlState;
  readonly generation: number;
  readonly receipt?: WorkItemControlReceipt;
  readonly unresolvedEffectIds: readonly string[];
  readonly recoveryOwner?: string;
}

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
  readonly revision: number;
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
  readonly planRevision?: string;
  readonly control: WorkItemControlProjection;
  readonly holds: readonly WorkItemHold[];
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

export interface UpsertWorkItemInput {
  readonly id?: string;
  readonly channelId?: string;
  readonly sourceType: WorkItemSourceType;
  readonly sourceId: string;
  readonly title: string;
  readonly description?: string;
  readonly status?: WorkItemStatus;
  readonly initialStatus?: WorkItemStatus;
  readonly waitingReason?: WorkItemWaitingReason;
  readonly priority?: WorkItemPriority;
  readonly labels?: readonly string[];
  readonly assigneeTeammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly externalWorkActionId?: string;
  readonly approvalId?: string;
  readonly artifactIds?: readonly string[];
  readonly proofArtifactIds?: readonly string[];
  readonly dependencyIds?: readonly string[];
  readonly retryBudget?: number;
}

export interface CreateWorkItemInput extends Pick<UpsertWorkItemInput,
  "id" | "sourceType" | "sourceId" | "title" | "description" | "initialStatus" | "priority" | "labels"
> {
  readonly idempotencyKey?: string;
  /** Host-resolved target identity shared by the source occurrences. */
  readonly verifiedTargetKey?: string;
  readonly gitHubIntake?: Omit<LingAppServerGitHubIntakeReceipt, "outcome" | "reasonCode" | "workItemId">;
}

export interface CreateWorkItemResult {
  readonly workItem: WorkItem;
  readonly event?: ControlPlaneEvent;
  readonly sourceReceipt?: LingAppServerWorkItemSourceReceipt;
  readonly gitHubIntakeReceipt?: LingAppServerGitHubIntakeReceipt;
}

export interface CommitWorkItemGitHubDeliveryInput {
  readonly delivery: LingAppServerGitHubDelivery;
  readonly targetKey: string;
  readonly expectedWorkItemRevision: number;
  readonly expectedDeliveryRevision: number;
}

export interface CommitWorkItemGitHubDeliveryResult {
  readonly delivery: LingAppServerGitHubDelivery;
  readonly event?: ControlPlaneEvent;
}

export interface ListWorkItemsOptions {
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

export interface WorkItemAcceptanceRequest {
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly dispatch?: LingAppServerWorkItemConversationDispatch;
}

export interface WorkItemConversationBinding {
  readonly workItemId: string;
  readonly acceptanceId: string;
  readonly submissionKey: string;
}

export interface WorkItemAcceptanceReceipt extends LingAppServerWorkItemAcceptance {
  readonly dispatch?: LingAppServerWorkItemConversationDispatch & { readonly submissionKey: string };
}

export interface WorkItemAcceptanceResult {
  readonly workItem: WorkItem;
  readonly receipt: WorkItemAcceptanceReceipt;
  readonly replayed: boolean;
  readonly event?: ControlPlaneEvent;
}

export type WorkItemControlResult =
  | { readonly status: "not_found" | "stale_revision" | "idempotency_conflict" }
  | { readonly status: "blocked"; readonly workItem: WorkItem }
  | { readonly status: "applied" | "replayed"; readonly workItem: WorkItem; readonly receipt: WorkItemControlReceipt; readonly event?: ControlPlaneEvent };

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

export interface WorkItemControlRequest {
  readonly expectedRevision: number;
  readonly expectedControlGeneration: number;
  readonly actorId: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export function createWorkItemId(): string {
  return `work_item_${randomUUID().replaceAll("-", "")}`;
}
