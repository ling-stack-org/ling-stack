import type { CodeAssessmentFinding, CodeAssessmentReviewRules, CodeAssessmentSnapshot, CodeFindingCloseReason } from "./code-assessments.js";
import type { ApprovalRequest } from "./approvals.js";
import type { RunArtifact } from "./artifacts.js";
import type { ApprovalSummary, ControlPlaneEventsResponse, ControlPlaneReplayWindow } from "./control-plane.js";
import type { ConversationContextProjectionMetadata } from "./conversation-continuity.js";
import type { RunSession } from "./runtime.js";
import type { ProviderPreset } from "./providers.js";
import type { SkillDefinition, SkillRegistryEntry } from "./skills.js";
import type { LingThread, LingThreadGoal, ProposedPlanWorkflowStepPreview } from "./threads.js";
import type { LingTurn, LingTurnRun } from "./turns.js";
import type { ManagedWorktreeEntry, ManagedWorktreeOwnerKind, WorktreeRecoverySnapshot } from "./worktrees.js";
import type { UserInputAnswerAcceptedResponseV1, UserInputAnswerCommandV1 } from "./user-input.js";
import type { UserInputRequestTranscriptV1 } from "./user-input-transcript.js";
import type { TurnWorkspaceChangesResponse } from "./workspace-changes.js";

/** Public Ling App Server protocol contract. Transport implementations may add
 * framing, authentication and backpressure, but they must preserve these names
 * and the durable request/notification semantics. */

export const LING_APP_SERVER_PROTOCOL_VERSION = "ling-app-server/1" as const;

export const LING_APP_SERVER_SUPPORTED_PROTOCOL_VERSIONS = [
  LING_APP_SERVER_PROTOCOL_VERSION,
] as const;

export const LING_APP_SERVER_CAPABILITIES = [
  "server/ping",
  "thread.events",
  "turn.control",
  "approval.respond",
  "input.respond",
  "development.verify",
  "development.review",
  "development.simplify",
  "development.instructions",
  "development.changes",
  "development.changeTransfer",
  "workItem.read",
  "workItem.control",
  "workItem.evidence",
  "workItem.device",
  "workItem.deliberation",
  "workItem.coordination",
  "externalAgent.federation",
] as const;

export type LingAppServerCapability = (typeof LING_APP_SERVER_CAPABILITIES)[number];

/** Capabilities backed by the currently shipped App Server adapter. */
export const LING_APP_SERVER_IMPLEMENTED_CAPABILITIES = [
  "server/ping",
  "thread.events",
  "turn.control",
  "approval.respond",
  "input.respond",
  "development.verify",
  "development.review",
  "development.simplify",
  "development.instructions",
  "development.changes",
  "development.changeTransfer",
  "workItem.read",
  "workItem.control",
  "workItem.evidence",
  "workItem.device",
  "workItem.deliberation",
  "workItem.coordination",
  "externalAgent.federation",
] as const satisfies readonly LingAppServerCapability[];

export type LingAppServerImplementedCapability = (typeof LING_APP_SERVER_IMPLEMENTED_CAPABILITIES)[number];

export const LING_APP_SERVER_METHODS = [
  "initialize",
  "server/capabilities",
  "server/ping",
  "server/grants/create",
  "server/grants/list",
  "server/grants/revoke",
  "server/recovery/read",
  "server/recovery/prepare",
  "server/recovery/reconcile",
  "workspace/list",
  "workspace/read",
  "worktree/list",
  "worktree/create",
  "worktree/refresh",
  "worktree/cleanup/preview",
  "worktree/cleanup",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/list",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/delete/preview",
  "thread/delete",
  "thread/turns/list",
  "thread/items/list",
  "thread/events/read",
  "item/read",
  "thread/subscribe",
  "thread/unsubscribe",
  "thread/snapshot",
  "submission/read",
  "thread/mode/get",
  "thread/mode/set",
  "plan/read",
  "plan/accept",
  "plan/refine",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/pause",
  "thread/goal/resume",
  "thread/goal/clear",
  "thread/goal/complete",
  "turn/start",
  "approval/respond",
  "input/respond",
  "turn/steer",
  "turn/queue",
  "turn/interrupt",
  "turn/retry",
  "turn/resume",
  "thread/fork",
  "thread/compact/start",
  "thread/revert",
  "context/inspect",
  "handoff/create",
  "handoff/read",
  "handoff/resume",
  "changes/capture",
  "changes/read",
  "changes/apply/preview",
  "changes/apply",
  "artifact/read",
  "verify/plan",
  "verify/start",
  "verify/status",
  "verify/cancel",
  "review/start",
  "review/status",
  "review/finding/update",
  "simplify/start",
  "simplify/status",
  "doctor/run",
  "instructions/init",
  "workItem/create",
  "workItem/read",
  "workItem/list",
  "workItem/accept",
  "workItem/workflow/bind",
  "workItem/plan/change/request",
  "workItem/plan/change/withdraw",
  "workItem/clarify",
  "workItem/pause",
  "workItem/resume",
  "workItem/cancel",
  "workItem/subscribe",
  "workItem/unsubscribe",
  "workItem/device/read",
  "workItem/device/bind",
  "workItem/device/receipt",
  "workItem/delivery/read",
  "workItem/intake/list",
  "workItem/intake/accept",
  "workItem/intake/retry",
  "workItem/feedback/add",
  "delivery/read",
  "github/subject/read",
  "github/intake/policy/list",
  "github/intake/poll",
  "github/intake/read",
  "github/delivery/reconcile",
  "github/delivery/enqueue",
  "github/delivery/queue/read",
  "workItem/evidence/read",
  "workItem/evidence/append",
  "workItem/collaboration/read",
  "workItem/collaboration/append",
  "workItem/deliberation/start",
  "workItem/deliberation/evaluate",
  "workItem/deliberation/open",
  "workItem/deliberation/read",
  "workItem/deliberation/cancel",
  "workItem/deliberation/decide",
  "workItem/stage/read",
  "workItem/stage/brief/read",
  "workItem/stage/recover",
  "workItem/coordination/start",
  "workItem/coordination/read",
  "workItem/coordination/close",
  "workItem/coordination/schedule/read",
  "workItem/coordination/schedule/set",
  "workItem/message/send",
  "workItem/message/read",
  "workItem/message/list",
  "workItem/question/ask",
  "workItem/question/read",
  "workItem/question/reply",
  "workItem/handoff/read",
  "workItem/handoff/accept",
  "workItem/handoff/return",
  "externalAgent/register",
  "externalAgent/capabilities/read",
  "externalAgent/task/start",
  "externalAgent/task/reconnect",
  "externalAgent/task/cancel",
  "provider/list",
  "model/list",
  "skill/list",
  "skill/read",
  "permissionProfile/list",
] as const;

export type LingAppServerMethod = (typeof LING_APP_SERVER_METHODS)[number];

export const LING_APP_SERVER_GRANT_SCOPES = ["observe", "control", "approve", "respond"] as const;
export type LingAppServerGrantScope = (typeof LING_APP_SERVER_GRANT_SCOPES)[number];

export type LingAppServerGrantSubject =
  | { readonly kind: "workspace" }
  | { readonly kind: "thread" | "workItem"; readonly id: string };

export interface LingAppServerGrant {
  readonly grantId: string;
  readonly label: string;
  readonly subject: LingAppServerGrantSubject;
  readonly scopes: readonly LingAppServerGrantScope[];
  readonly revision: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export type LingAppServerRecoveryJournalEntry = {
  readonly id: string;
  readonly recordedAt: string;
  readonly pending: boolean;
} & (
  | { readonly kind: "external_agent_dispatch"; readonly workItemId: string; readonly taskId: string; readonly completedAt?: string }
  | { readonly kind: "github_queue_enqueue"; readonly workItemId: string; readonly repositoryId: string;
      readonly pullRequestNumber: number; readonly headSha: string; readonly completedAt?: string }
  | { readonly kind: "github_delivery"; readonly workItemId: string; readonly mergedCommit: string }
  | { readonly kind: "grant_revocation" }
);

export interface LingAppServerRecoveryResult {
  readonly cwd: string;
  readonly revision: number;
  readonly status: "ready" | "reconciliation_required";
  readonly preparedAt?: string;
  readonly reconciledAt?: string;
  readonly pendingCount: number;
  readonly entries: readonly LingAppServerRecoveryJournalEntry[];
}

export interface LingAppServerRecoveryPrepareParams {
  readonly cwd?: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface LingAppServerRecoveryReconcileParams {
  readonly cwd?: string;
  readonly expectedRevision: number;
}

export interface LingAppServerGrantCreateParams {
  readonly label: string;
  readonly subject: LingAppServerGrantSubject;
  readonly scopes: readonly LingAppServerGrantScope[];
  readonly expiresAt: string;
  readonly credentialSha256: string;
  readonly idempotencyKey: string;
  readonly stageExecution?: LingAppServerStageMessageExecution;
}

export const LING_APP_SERVER_NOTIFICATION_METHODS = [
  "initialized",
  "thread/started",
  "thread/updated",
  "thread/archived",
  "thread/removed",
  "thread/goal/updated",
  "turn/started",
  "turn/status/changed",
  "turn/completed",
  "turn/plan/updated",
  "turn/projectInstructions/updated",
  "turn/diff/updated",
  "item/started",
  "item/delta",
  "item/completed",
  "serverRequest/resolved",
  "verification/updated",
  "review/updated",
  "handoff/created",
  "workItem/created",
  "workItem/claimed",
  "workItem/status/changed",
  "workItem/claim/expired",
  "workItem/thread/linked",
  "workItem/delivery/updated",
  "workItem/intake/updated",
  "workItem/feedback/received",
  "workItem/control/updated",
  "workItem/evidence/updated",
  "workItem/collaboration/updated",
  "workItem/deliberation/updated",
  "workItem/stage/updated",
  "workItem/plan/change/updated",
  "workItem/brief/updated",
  "workItem/coordination/updated",
  "workItem/message/updated",
  "workItem/question/updated",
  "workItem/handoff/updated",
  "workItem/device/updated",
  "externalAgent/registered",
  "externalAgent/task/started",
  "externalAgent/task/reconnected",
  "externalAgent/task/updated",
  "externalAgent/task/unknown",
  "github/subject/updated",
  "thread/replay/ready",
  "thread/resync/required",
  "workItem/replay/ready",
  "workItem/resync/required",
  "server/warning",
  "server/draining",
  "server/restarted",
  "server/pong",
  "$/control_plane_event",
  "$/run_event",
] as const;

export type LingAppServerNotificationMethod = (typeof LING_APP_SERVER_NOTIFICATION_METHODS)[number];

export const LING_APP_SERVER_NATIVE_INTAKE_PAGE_LIMIT = 50;

export const LING_APP_SERVER_ERROR_CODES = [
  "server_overloaded",
  "server_draining",
  "request_cancelled",
  "protocol_version_unsupported",
  "required_capability_unavailable",
  "authorization_required",
  "capability_denied",
  "stale_revision",
  "idempotency_conflict",
  "steer_unsupported",
  "turn_busy",
  "workspace_binding_invalid",
  "worktree_conflict",
  "request_expired",
  "request_already_resolved",
  "unknown_outcome",
  "resume_blocked",
  "snapshot_required",
  "goal_acceptance_incomplete",
  "candidate_stale",
] as const;

export type LingAppServerErrorCode = (typeof LING_APP_SERVER_ERROR_CODES)[number];

export const LING_APP_SERVER_ERROR_NUMERIC_CODES = {
  server_overloaded: -32001,
  server_draining: -32002,
  request_cancelled: -32003,
  protocol_version_unsupported: -32010,
  required_capability_unavailable: -32011,
  authorization_required: -32020,
  capability_denied: -32021,
  stale_revision: -32030,
  idempotency_conflict: -32031,
  steer_unsupported: -32032,
  turn_busy: -32033,
  workspace_binding_invalid: -32040,
  worktree_conflict: -32041,
  request_expired: -32050,
  request_already_resolved: -32051,
  unknown_outcome: -32060,
  resume_blocked: -32061,
  snapshot_required: -32070,
  goal_acceptance_incomplete: -32080,
  candidate_stale: -32081,
} as const satisfies Record<LingAppServerErrorCode, number>;

export type LingAppServerJsonRpcId = string | number;

export interface LingAppServerRequest<Params = unknown> {
  readonly jsonrpc: "2.0";
  readonly id?: LingAppServerJsonRpcId;
  readonly method: LingAppServerMethod;
  readonly params?: Params;
}

export interface LingAppServerNotification<Params = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: LingAppServerNotificationMethod;
  readonly params?: Params;
}

export interface LingAppServerResponse<Result = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: LingAppServerJsonRpcId | null;
  readonly result?: Result;
  readonly error?: LingAppServerError;
}

export interface LingAppServerError {
  readonly code: number;
  readonly message: string;
  readonly data?: {
    readonly code?: LingAppServerErrorCode;
    readonly retryable?: boolean;
    readonly targetRef?: string;
    readonly [key: string]: unknown;
  };
}

export interface LingAppServerClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface LingAppServerInitializeParams {
  readonly protocolVersions: readonly string[];
  readonly clientInfo: LingAppServerClientInfo;
  readonly requiredCapabilities?: readonly LingAppServerCapability[];
  readonly optionalCapabilities?: readonly LingAppServerCapability[];
  readonly workspaceScope?: readonly string[];
}

export interface LingAppServerLimits {
  readonly maxInboundFrameBytes: number;
  readonly maxOutboundFrameBytes: number;
  readonly maxPendingRequests?: number;
  readonly maxSubscriptions?: number;
  readonly maxBufferedBytes?: number;
}

export interface LingAppServerInitializeResult {
  readonly protocolVersion: typeof LING_APP_SERVER_PROTOCOL_VERSION;
  readonly serverInfo: LingAppServerClientInfo;
  readonly connectionId: string;
  readonly effectiveScopes: readonly string[];
  readonly capabilities: readonly LingAppServerCapability[];
  readonly limits: LingAppServerLimits;
  readonly serverInstanceId?: string;
  readonly storeIncarnation?: string;
  readonly authorizationEpoch?: string;
}

export interface LingAppServerRestarted {
  readonly previousServerInstanceId: string;
  readonly serverInstanceId: string;
  readonly storeIncarnation?: string;
  readonly authorizationEpoch?: string;
}

export interface LingAppServerCapabilitiesResult {
  readonly protocolVersion: typeof LING_APP_SERVER_PROTOCOL_VERSION;
  readonly capabilities: readonly LingAppServerCapability[];
  readonly methods: readonly LingAppServerMethod[];
  readonly notifications: readonly LingAppServerNotificationMethod[];
}

export interface LingAppServerArtifactReadParams {
  readonly cwd?: string;
  readonly artifactId: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly threadId?: string;
  readonly workItemId?: string;
  readonly runId?: string;
}

export const LING_APP_SERVER_ARTIFACT_RANGE_BYTES = 64 * 1024;

export interface LingAppServerArtifactReadResult {
  readonly cwd: string;
  readonly artifact: Omit<RunArtifact, "path" | "sealedPayload" | "contentSha256">;
  readonly contentBase64?: string;
  readonly offset?: number;
  readonly endExclusive?: number;
  readonly sizeBytes?: number;
  readonly partial?: boolean;
}

export interface LingAppServerModelListResult {
  readonly cwd: string;
  readonly models: readonly Pick<ProviderPreset,
    "id" | "displayName" | "providerId" | "model" | "enabled" | "capabilities" | "input">[];
  readonly nextOffset?: number;
}

export interface LingAppServerSkillReadResult {
  readonly cwd: string;
  readonly skill: Pick<SkillRegistryEntry, "id" | "packId" | "source" | "version" | "reviewStatus"> & {
    readonly definition: Pick<SkillDefinition, "name" | "summary" | "requiredTools" | "requiredProviderCapabilities">;
  };
}

export interface LingAppServerPermissionProfileListResult {
  readonly cwd: string;
  readonly profiles: readonly {
    readonly id: string;
    readonly authorizationModes: readonly string[];
    readonly workspaceAccessModes: readonly string[];
    readonly sessionPermissionModes: readonly string[];
  }[];
}

export interface LingAppServerEventSubject {
  readonly kind: "thread" | "workItem";
  readonly threadId?: string;
  readonly workItemId?: string;
}

export interface LingAppServerDurableNotice<Payload = unknown> {
  readonly subscriptionId: string;
  readonly cursor: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly subject: LingAppServerEventSubject;
  readonly turnId?: string;
  readonly runId?: string;
  readonly itemId?: string;
  readonly revision: string;
  readonly payload: Payload;
}

export interface LingAppServerTextDelta {
  readonly subscriptionId: string;
  readonly workspaceId: string;
  readonly subject: LingAppServerEventSubject & { readonly kind: "thread"; readonly threadId: string; readonly turnId: string };
  readonly runId: string;
  readonly itemId: string;
  readonly streamEpoch: string;
  /** Position in this Run's event log, ordered within a stream epoch. */
  readonly offset: number;
  readonly text: string;
  readonly truncated?: true;
}

export interface LingAppServerSubscriptionParams {
  readonly workspaceId?: string;
  readonly threadId?: string;
  readonly workItemId?: string;
  readonly cursor?: string;
}

export interface LingAppServerSubscriptionResult {
  readonly disposition: "complete" | "snapshot_required";
  readonly subscriptionId?: string;
  readonly cursor?: string;
  readonly snapshotId?: string;
  readonly reason?: "cursor_unavailable" | "retention_gap" | "window_exceeded" | "authorization_changed";
  readonly window?: ControlPlaneReplayWindow;
}

export interface LingAppServerThreadEventsResult extends ControlPlaneEventsResponse {
  /** Use the server-issued cursor to continue reading the same Thread. */
  readonly cursor?: string;
}

export type LingWorkItemControlState =
  | "active"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "blocked";

export interface LingWorkItemControlReceipt {
  readonly id: string;
  readonly action: "pause" | "resume" | "cancel";
  readonly generation: string;
  readonly requestedAt: string;
  readonly actorId: string;
  readonly reason?: string;
  readonly outcome: "accepted" | "settling" | "settled" | "blocked";
}

export interface LingWorkItemHold {
  readonly id: string;
  readonly kind: "plan" | "control" | "approval" | "unknown_effect" | "scope" | "dependency";
  readonly ownerRef: string;
  readonly reason: string;
  readonly blocksNewAdmission: boolean;
  readonly workflowStepIds?: readonly string[];
}

interface LingAppServerWorkItemPlanChangeBasis {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly planRevision: string;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
}

export interface LingAppServerWorkItemPlanChangeRequestParams extends LingAppServerWorkItemPlanChangeBasis {
  readonly affectedStageIds: readonly string[];
  readonly reason: string;
}

export interface LingAppServerWorkItemPlanChangeWithdrawParams extends LingAppServerWorkItemPlanChangeBasis {
  readonly changeId: string;
}

export interface LingAppServerWorkItemPlanChangeReceipt {
  readonly changeId: string;
  readonly status: "pending" | "withdrawn";
  readonly planRevision: string;
  readonly affectedStepIds: readonly string[];
}

export interface LingAppServerWorkItemPlanChangeResult extends LingAppServerWorkItemResult {
  readonly replayed: boolean;
  readonly receipt: LingAppServerWorkItemPlanChangeReceipt;
}

export interface LingWorkItemControlProjection {
  readonly state: LingWorkItemControlState;
  readonly generation: string;
  readonly receipt?: LingWorkItemControlReceipt;
  readonly unresolvedEffectIds: readonly string[];
  readonly recoveryOwner?: string;
}

export interface LingAppServerWorkItemSnapshot {
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly revision: string;
  readonly status: string;
  readonly planRevision?: string;
  readonly goalRevision?: string;
  readonly control: LingWorkItemControlProjection;
  readonly holds: readonly LingWorkItemHold[];
  readonly currentExecutionRefs: readonly string[];
  readonly linkedExecution?: import("./work-items.js").WorkItemLinkedExecution;
  readonly eventCursor?: string;
}

export interface LingAppServerWorkItemResult {
  readonly cwd: string;
  readonly workItem: LingAppServerWorkItemSnapshot;
  readonly sourceReceipt?: LingAppServerWorkItemSourceReceipt;
}

export interface LingAppServerWorkItemCreateParams {
  readonly cwd?: string;
  readonly workItemId?: string;
  readonly sourceType?: import("./work-items.js").WorkItemSourceType;
  readonly sourceId: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: "low" | "normal" | "high" | "urgent";
  readonly labels?: readonly string[];
  readonly idempotencyKey?: string;
  readonly gitHubSubject?: Omit<LingAppServerGitHubSubjectParams, "cwd">;
  /** Use the selected Task or AutomationRun as the execution owner. */
  readonly linkExistingExecution?: boolean;
}

export interface LingAppServerWorkItemConversationDispatch {
  readonly threadId: string;
  readonly message: string;
  readonly providerPresetId?: string;
}

export interface LingAppServerWorkItemAcceptParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
  readonly actorId?: string;
  readonly dispatch?: LingAppServerWorkItemConversationDispatch;
}

export interface LingAppServerWorkItemAcceptance {
  readonly id: string;
  readonly workItemId: string;
  readonly acceptedRevision: number;
  readonly workItemRevision: number;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly acceptedAt: string;
}

export interface LingAppServerWorkItemAcceptResult extends LingAppServerWorkItemResult {
  readonly accepted: true;
  readonly acceptance: LingAppServerWorkItemAcceptance;
  readonly replayed: boolean;
  readonly dispatch?: {
    readonly threadId: string;
    readonly submissionKey: string;
    readonly status: "pending" | "admitted" | "held";
    readonly runId?: string;
    readonly blocker?: string;
  };
}

export interface LingAppServerWorkItemReadResult extends LingAppServerWorkItemResult {
  readonly cursor: string;
  readonly intakeDispatch?: {
    readonly receiptId: string;
    readonly status: "pending" | "held" | "admitted";
    readonly reasonCode?: string;
    readonly runId?: string;
  };
}

export interface LingAppServerWorkItemWorkflowBindParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly planId: string;
  readonly expectedPlanRevision: number;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
  readonly previousWorkflowId?: string;
  readonly resolvedPlanChangeIds?: readonly string[];
  readonly retainStageResults?: readonly LingAppServerWorkflowStageResultSource[];
  readonly retainStageExecutions?: readonly LingAppServerWorkflowStageExecutionSource[];
}

export interface LingAppServerWorkflowStageResultSource {
  readonly sourceStepId: string;
  readonly expectedSourceRevision: string;
  readonly targetStepId: string;
}

export interface LingAppServerRetainedWorkflowStageResult extends LingAppServerWorkflowStageResultSource {
  readonly sourceWorkflowId: string;
  readonly sourceStageId: string;
  readonly sourceRunId: string;
  readonly sourceArtifactId: string;
}

export interface LingAppServerWorkflowStageExecutionSource extends LingAppServerWorkflowStageResultSource {
  readonly sourceRunId: string;
}

export interface LingAppServerRetainedWorkflowStageExecution extends LingAppServerWorkflowStageExecutionSource {
  readonly sourceWorkflowId: string;
  readonly sourceStageId: string;
}

export interface LingAppServerWorkItemWorkflowBinding {
  readonly workItemId: string;
  readonly workflowId: string;
  readonly threadId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly linkedAt: string;
  readonly previousWorkflowId?: string;
  readonly retainedStageResults?: readonly LingAppServerRetainedWorkflowStageResult[];
  readonly retainedStageExecutions?: readonly LingAppServerRetainedWorkflowStageExecution[];
}

export interface LingAppServerWorkItemWorkflowBindResult extends LingAppServerWorkItemResult {
  readonly binding: LingAppServerWorkItemWorkflowBinding;
  readonly replayed: boolean;
}

export interface LingAppServerPlanRefineParams {
  readonly cwd?: string;
  readonly threadId: string;
  readonly planId: string;
  readonly expectedRevision: number;
  readonly draft?: { readonly title: string; readonly bodyMarkdown: string };
}

export interface LingAppServerPlanWorkflowAcceptParams {
  readonly cwd?: string;
  readonly threadId: string;
  readonly planId: string;
  readonly expectedRevision: number;
  readonly mode: "workflow";
  readonly workflowTitle?: string;
  readonly workflowStepPreviews: readonly ProposedPlanWorkflowStepPreview[];
}

export interface LingAppServerWorkItemWorkflowStages {
  readonly workflowId: string;
  readonly planRevision: string;
  readonly workItemRevision?: number;
  readonly status: import("./workflows.js").ChannelWorkflowStatus;
  readonly admissionBlocker?: string;
  readonly usage?: LingAppServerWorkflowUsage;
  readonly goalBudget?: LingAppServerWorkflowGoalBudget;
  readonly nextOffset?: number;
  readonly steps: readonly {
    readonly stepId: string;
    readonly stageId?: string;
    readonly title: string;
    readonly status: import("./workflows.js").ChannelWorkflowStepStatus;
    readonly participantLabel: string;
    readonly dependencyIds: readonly string[];
    readonly admissionBlocker?: string;
    readonly retryBudget?: LingAppServerWorkItemStageRetryBudget;
    readonly usage?: LingAppServerWorkflowUsage;
    readonly progress?: LingAppServerWorkflowStageProgress;
    readonly recoveryVerification?: import("./threads.js").GoalVerificationRequirement;
    readonly recoveryReview?: import("./threads.js").StageRecoveryReviewRequirement;
    readonly updatedAt: string;
    readonly runId?: string;
    readonly outputArtifactId?: string;
    readonly brief?: string;
    readonly messageReceiver?: LingAppServerStageMessageExecution;
    readonly decision?: LingAppServerWorkItemStageDecision;
    readonly handoffs?: readonly LingAppServerStageHandoffProgress[];
    readonly retainedStageResults?: readonly LingAppServerRetainedWorkflowStageResult[];
    readonly retainedStageExecutions?: readonly (LingAppServerRetainedWorkflowStageExecution & {
      readonly status: "pending" | "available" | "unavailable";
    })[];
    readonly briefBasis?: {
      readonly transitionId: string;
      readonly committedAt: string;
    };
  }[];
}

export interface LingAppServerWorkItemStageRetryBudget {
  readonly starts: number;
  readonly stageRetriesRemaining: number;
  readonly workItemRetriesRemaining: number;
  readonly exhausted: boolean;
}

export interface LingAppServerWorkflowUsage {
  readonly runCount: number;
  readonly observedTokens: number;
  readonly tokenCoverage: "complete" | "partial";
  readonly toolCalls: number;
  readonly elapsedSeconds: number;
}

export interface LingAppServerWorkflowGoalBudget {
  readonly goalId: string;
  readonly tokenBudget?: number;
  readonly accountedTokens: number;
  readonly reservedTokens?: number;
  readonly tokensRemaining?: number;
  readonly maxTimeSeconds?: number;
  readonly timeUsedSeconds: number;
  readonly blocker?: "work_item_goal_token_budget_exhausted" | "work_item_goal_time_budget_exhausted" | "work_item_goal_usage_unconfirmed";
}

export interface LingAppServerWorkflowStageProgress {
  readonly lastVerified?: { readonly kind: "stage_completed" | "plan_change_accepted"; readonly id: string; readonly committedAt: string }
    | ({ readonly kind: "verification_passed" | "review_passed"; readonly id: string } & LingAppServerStageRecoveryEvidence);
  readonly blocker?: {
    readonly id: string;
    readonly kind: "provider" | "execution_loop";
    readonly code: string;
    readonly status: "observed" | "stalled";
    readonly failedStarts: number;
    readonly lastRunId: string;
    readonly sourceEventId: string;
    readonly recoveryOwnerId: string;
  };
}

export interface LingAppServerStageRecoveryEvidence {
  readonly workflowStepId: string;
  readonly blockerId: string;
  readonly failureEventId: string;
  readonly failedRunId: string;
  readonly failedAt: string;
  readonly operationId: string;
  readonly reviewRevision?: string;
  readonly candidateDigest: string;
  readonly committedAt: string;
}

export interface LingAppServerStageRecoverParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly workflowStepId: string;
  readonly planRevision: string;
  readonly expectedWorkItemRevision: number;
  readonly blockerId: string;
  readonly failureEventId: string;
  readonly operationId: string;
  readonly evidenceKind?: "verification" | "review";
  readonly idempotencyKey: string;
}

export interface LingAppServerStageRecoverResult {
  readonly cwd: string;
  readonly workItemRevision: number;
  readonly receipt: LingAppServerStageRecoveryEvidence & { readonly id: string };
  readonly replayed: boolean;
}

export interface LingAppServerWorkItemControlResult extends LingAppServerWorkItemResult {
  readonly controlReceipt: LingWorkItemControlReceipt;
  readonly replayed: boolean;
}

export interface LingAppServerWorkItemControlParams {
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly expectedWorkItemRevision: number;
  readonly expectedControlGeneration: number;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly reason?: string;
}

/** Durable collaboration records are append-only facts attached to a Work Item.
 * The payload is owned by the record kind and is intentionally opaque to the
 * transport so older clients can preserve records they do not understand. */
export const LING_APP_SERVER_COLLABORATION_KINDS = [
  "deliberation",
  "stage",
  "brief",
  "coordination",
  "message",
  "question",
  "handoff",
] as const;

export type LingAppServerCollaborationKind = (typeof LING_APP_SERVER_COLLABORATION_KINDS)[number];

export interface LingAppServerCoordinationSchedule {
  readonly automationId: string;
  readonly workItemId: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly kind: "checkpoint" | "retrospective";
  readonly durationMs: number;
}

export interface LingAppServerCoordinationScheduleParams extends Omit<LingAppServerCoordinationSchedule, "revision"> {
  readonly cwd?: string;
  readonly expectedRevision: number;
}

export interface LingAppServerScheduledCoordinationRound {
  readonly automationId: string;
  readonly automationRunId: string;
  readonly workItemId: string;
  readonly recordId: string;
  readonly policyRevision: number;
  readonly subjectRevision: number;
  readonly controlGeneration: number;
  readonly kind: LingAppServerCoordinationSchedule["kind"];
  readonly deadlineAt: string;
  readonly scheduledFor?: string;
  readonly closedRecordId?: string;
}

export const LING_APP_SERVER_COLLABORATION_ACTIONS = [
  "created",
  "updated",
  "accepted",
  "returned",
  "closed",
  "decided",
  "cancelled",
  "replied",
  "started",
] as const;

export type LingAppServerCollaborationAction = (typeof LING_APP_SERVER_COLLABORATION_ACTIONS)[number];

export interface LingAppServerWorkItemSourceRef {
  readonly type: string;
  readonly id: string;
  readonly revision?: string;
  readonly digest?: string;
}

export interface LingAppServerWorkItemCollaborationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly collaborationRevision: number;
  readonly workItemRevision: number;
  readonly kind: LingAppServerCollaborationKind;
  readonly action: LingAppServerCollaborationAction;
  readonly actorId: string;
  readonly payload: unknown;
  readonly parentRecordId?: string;
  readonly sourceRefs: readonly LingAppServerWorkItemSourceRef[];
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LingAppServerWorkItemCollaborationReadParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly kind?: LingAppServerCollaborationKind;
  readonly afterRevision?: number;
  readonly limit?: number;
}

export interface LingAppServerWorkItemCollaborationReadResult {
  readonly workItemId: string;
  readonly records: readonly LingAppServerWorkItemCollaborationRecord[];
  readonly nextAfterRevision: number;
  readonly workflow?: LingAppServerWorkItemWorkflowStages;
  readonly ballots?: readonly LingAppServerStageBallotProgress[];
  readonly deliberationWorkflows?: readonly LingAppServerDeliberationWorkflowProgress[];
}

export interface LingAppServerDeliberationWorkflowProgress {
  readonly roundId: string;
  readonly workflowId: string;
  readonly status: import("./workflows.js").ChannelWorkflowStatus;
  readonly deadlineAt: string;
  readonly proposalsCompleted: number;
  readonly challengesCompleted: number;
  readonly participants: number;
  readonly blocker?: string;
  readonly outcome?: LingAppServerDeliberationWorkflowOutcome;
}

export type LingAppServerDeliberationWorkflowOutcome =
  | { readonly status: "waiting" | "voting" | "verify_required" | "insufficient_evidence" }
  | { readonly status: "consensus"; readonly recommendation: string }
  | { readonly status: "tallied"; readonly summary: LingAppServerStageBallotTally; readonly recommendation?: string };

export interface LingAppServerStageBallotTally {
  readonly ballotKey: string;
  readonly quorum: number;
  readonly cast: number;
  readonly abstained: number;
  readonly tied: boolean;
  readonly tally: readonly { readonly option: string; readonly count: number }[];
}

export interface LingAppServerWorkItemStageDecision {
  readonly question: string;
  readonly status: "not_open" | "waiting" | "ready" | "quorum_unmet" | "decided" | "cancelled" | "stale";
  readonly ballot?: LingAppServerStageBallotTally;
  readonly selectedOption?: string;
  readonly reason?: string;
}

export const LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS = [
  "missing_artifact", "required_check_incomplete", "candidate_stale", "scope_unavailable", "upstream_effect_unknown",
] as const;
export type LingAppServerStageHandoffReturnReason = (typeof LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS)[number];

export interface LingAppServerStageHandoffParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly planRevision: string;
  readonly sourceStepId: string;
  readonly targetStepId: string;
  readonly expectedSourceRevision: string;
  readonly expectedTargetRevision: string;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
  /** The offered candidate on return and the current worktree candidate on acceptance. */
  readonly expectedCandidateDigest?: string;
  readonly previousHandoffId?: string;
  readonly verification?: { readonly operationId: string; readonly checkId: string };
  readonly reason?: LingAppServerStageHandoffReturnReason;
  readonly detail?: string;
}

export interface LingAppServerStageHandoffProgress {
  readonly sourceStepId: string;
  readonly sourceStageId?: string;
  readonly sourceRevision: string;
  readonly status: "awaiting_source" | "awaiting_acceptance" | "accepted" | "returned";
  readonly receiptId?: string;
  readonly candidateDigest?: string;
  readonly reason?: LingAppServerStageHandoffReturnReason;
}

export type LingAppServerStageBallotProgress = { readonly roundId: string } & (
  | { readonly status: "waiting" | "stale" }
  | { readonly status: "ready" | "quorum_unmet"; readonly summary: LingAppServerStageBallotTally }
);

export interface LingAppServerWorkItemCollaborationAppendParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly expectedWorkItemRevision?: number;
  readonly expectedCollaborationRevision?: number;
  readonly kind: LingAppServerCollaborationKind;
  readonly action: LingAppServerCollaborationAction;
  readonly actorId: string;
  readonly payload: unknown;
  readonly parentRecordId?: string;
  readonly sourceRefs?: readonly LingAppServerWorkItemSourceRef[];
  readonly idempotencyKey: string;
}

export interface LingAppServerStageMessageExecution {
  readonly runId: string;
  readonly attemptId: string;
}

export interface LingAppServerStageMessageDelivery extends LingAppServerStageMessageExecution {
  readonly status: "queued" | "input_admitted" | "superseded";
  readonly admittedAt?: string;
  readonly inputDigest?: string;
  readonly preparedInputFingerprint?: string;
}

export interface LingAppServerStageMessageSendParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly planRevision: string;
  readonly targetStepId: string;
  readonly expectedTargetRevision: string;
  readonly expectedWorkItemRevision: number;
  readonly expectedExecution?: LingAppServerStageMessageExecution;
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerStageQuestionAskParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly planRevision: string;
  readonly expectedWorkItemRevision: number;
  readonly waitingStepId: string;
  readonly respondentStepId: string;
  readonly question: string;
  readonly deadlineAt: string;
  readonly answerFromStageResult?: boolean;
  readonly predecessorQuestion?: { readonly id: string; readonly revision: number };
  readonly idempotencyKey: string;
}

export interface LingAppServerStageQuestionReplyParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly questionId: string;
  readonly expectedQuestionRevision: number;
  readonly expectedWorkItemRevision: number;
  readonly answer: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerWorkItemCollaborationAppendResult {
  readonly status: "appended" | "replayed";
  readonly record: LingAppServerWorkItemCollaborationRecord;
  readonly workItemRevision: number;
}

export type LingAppServerWorkItemDeviceStatus =
  | "bound"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface LingAppServerWorkItemDeviceReceipt {
  readonly receiptId: string;
  readonly bindingRevision: number;
  readonly ownerHostId: string;
  readonly ownerRouteGeneration: number;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly status: Exclude<LingAppServerWorkItemDeviceStatus, "bound" | "queued" | "running">;
  readonly resultRef: string;
  readonly receivedAt: string;
  readonly reconciled: boolean;
}

export interface LingAppServerWorkItemDeviceBinding {
  readonly bindingId: string;
  readonly workItemId: string;
  readonly graphId: string;
  readonly graphNodeId: string;
  readonly graphRevision: number;
  readonly ownerHostId: string;
  readonly ownerRouteGeneration: number;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly status: LingAppServerWorkItemDeviceStatus;
  readonly revision: number;
  readonly boundAt: string;
  readonly updatedAt: string;
  readonly receipt?: LingAppServerWorkItemDeviceReceipt;
}

export interface LingAppServerWorkItemDeviceReadResult {
  readonly cwd: string;
  readonly workItemId: string;
  readonly bindings: readonly LingAppServerWorkItemDeviceBinding[];
}

export interface LingAppServerWorkItemDeviceBindParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly graphId: string;
  readonly graphNodeId: string;
  readonly graphRevision: number;
  readonly ownerHostId: string;
  readonly ownerRouteGeneration: number;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
}

export interface LingAppServerWorkItemDeviceBindResult {
  readonly cwd: string;
  readonly binding: LingAppServerWorkItemDeviceBinding;
  readonly replayed: boolean;
}

export interface LingAppServerWorkItemDeviceReceiptParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly bindingId: string;
  readonly expectedBindingRevision: number;
  readonly expectedWorkItemRevision: number;
  readonly ownerHostId: string;
  readonly ownerRouteGeneration: number;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly status: Exclude<LingAppServerWorkItemDeviceStatus, "bound" | "queued" | "running">;
  readonly resultRef: string;
  readonly reconciled?: boolean;
  readonly idempotencyKey: string;
}

export interface LingAppServerWorkItemDeviceReceiptResult {
  readonly cwd: string;
  readonly binding: LingAppServerWorkItemDeviceBinding;
  readonly replayed: boolean;
}

export interface LingAppServerWorkItemFeedbackParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly expectedWorkItemRevision: number;
  readonly sourceRunId: string;
  readonly providerPresetId: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerWorkItemFeedbackResult {
  readonly cwd: string;
  readonly job: import("./learning-reviews.js").LearningReviewJob;
  readonly replayed: boolean;
}

export interface LingAppServerDeliberationTriggerPolicyV1 {
  readonly enabled: boolean;
  readonly onPlanFormation: boolean;
  readonly onDeclaredDecisionPoint: boolean;
  readonly onConflictingRecommendations: boolean;
  readonly onMaterialRequirementChange: boolean;
  readonly minimumParticipants: number;
  readonly maxRounds: number;
  readonly minimumMateriality?: "low" | "medium" | "high";
  readonly cooldownMs?: number;
}

export type LingAppServerDeliberationTriggerKindV1 =
  | "plan_formation"
  | "declared_decision_point"
  | "conflicting_recommendations"
  | "material_requirement_change"
  | "manual_request";

export interface LingAppServerDeliberationTriggerSignalV1 {
  readonly kind: LingAppServerDeliberationTriggerKindV1;
  readonly workItemRevision: number;
  readonly sourceRefs?: readonly LingAppServerWorkItemSourceRef[];
  readonly conflictCount?: number;
  readonly materiality?: "low" | "medium" | "high";
  readonly requestedBy?: string;
  readonly participantCount?: number;
  readonly priorRoundCount?: number;
  readonly lastTriggeredAt?: string;
  readonly evaluatedAt?: string;
}

export interface LingAppServerDeliberationTriggerDecisionV1 {
  readonly shouldOpen: boolean;
  readonly requiresHumanDecision: boolean;
  readonly reason: string;
  readonly triggerKind: LingAppServerDeliberationTriggerKindV1;
}

export const LING_APP_SERVER_DELIBERATION_CHECKPOINTS = [
  "plan_review", "verify_review_conflict", "blocked_stage_changed", "handoff_returned", "repeated_failure", "scheduled_checkpoint",
] as const;

export const LING_APP_SERVER_DELIBERATION_DECISION_KINDS = [
  "plan_or_contract", "implementation_tradeoff", "recovery_tradeoff", "review_disposition",
] as const;

export const LING_APP_SERVER_DECISION_MATERIALITIES = ["low", "medium", "high"] as const;
export const LING_APP_SERVER_DELIBERATION_OUTCOMES = [
  "clarify", "verify", "handoff_repair", "suggest", "start", "defer", "suppress",
] as const;

export type LingAppServerDeliberationCheckpoint = typeof LING_APP_SERVER_DELIBERATION_CHECKPOINTS[number];
export type LingAppServerDeliberationDecisionKind = typeof LING_APP_SERVER_DELIBERATION_DECISION_KINDS[number];
export type LingAppServerDecisionMateriality = typeof LING_APP_SERVER_DECISION_MATERIALITIES[number];

export type LingAppServerDeliberationSubject =
  | { readonly kind: "draft_plan"; readonly planId: string; readonly planRevision: number }
  | { readonly kind: "workflow_stage"; readonly workflowStepId: string; readonly planRevision: string };

export interface LingAppServerDeliberationEvaluateParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
  readonly decisionKey: string;
  readonly subject: LingAppServerDeliberationSubject;
  readonly checkpoint: LingAppServerDeliberationCheckpoint;
  readonly checkpointRef: string;
  readonly decisionKind: LingAppServerDeliberationDecisionKind;
  readonly materiality: LingAppServerDecisionMateriality;
  readonly question: string;
  readonly participantIds: readonly string[];
  readonly optionRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly decisionStepId?: string;
  readonly candidateDigest?: string;
  readonly unresolved?: "intent" | "fact" | "handoff";
  /** An operator request for an evaluation and explicit round admission. */
  readonly requestKind?: "manual_request";
}

export interface LingAppServerDeliberationEvaluation {
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly decisionRevision: string;
  readonly subjectRevision: string;
  readonly policyRevision: string;
  readonly checkpoint: LingAppServerDeliberationCheckpoint;
  readonly checkpointRef: string;
  readonly outcome: typeof LING_APP_SERVER_DELIBERATION_OUTCOMES[number];
  readonly reasonCode: string;
  readonly optionRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly participantIds: readonly string[];
  readonly decisionStepId?: string;
  readonly existingRoundId?: string;
  readonly candidateDigest?: string;
  readonly expiresAt: string;
  readonly evaluatedAt: string;
}

export interface LingAppServerDeliberationEvaluateResult {
  readonly cwd: string;
  readonly workItemRevision: number;
  readonly replayed: boolean;
  readonly evaluation: LingAppServerDeliberationEvaluation;
}

export interface LingAppServerDeliberationOpenParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly evaluationId: string;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
  /**
   * Shaping runs tool-free consultations for a draft. A linked Workflow
   * requires an accepted stage.
   */
  readonly execution?: "read_only_shaping" | "read_only_workflow";
  readonly shapingBudget?: { readonly maxTokens: number; readonly maxDurationMs: number };
  readonly ballotMode?: "when_unresolved";
}

export interface LingAppServerPlanShapingContribution {
  readonly participantId: string;
  readonly roleKey: string;
  readonly phase: "proposal" | "challenge";
  readonly disposition: "recommend" | "open_tradeoff" | "verify_required";
  readonly optionId?: string;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface LingAppServerPlanShapingResult {
  readonly roundId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly status: "consensus" | "open_tradeoff" | "verify_required" | "incomplete";
  readonly optionIds: readonly string[];
  readonly recommendedOptionId?: string;
  readonly contributions: readonly LingAppServerPlanShapingContribution[];
  readonly blocker?: "provider_unavailable" | "invalid_contribution" | "deadline_expired" | "interrupted";
  readonly decision?: { readonly recordId: string; readonly disposition: "selected" | "deferred" | "replan_required";
    readonly option?: string; readonly reason: string };
}

export type LingAppServerPlanReadResult = { readonly cwd: string; readonly threadId: string } & (
  | { readonly plan: import("./threads.js").ProposedPlanArtifact; readonly deliberations?: readonly LingAppServerPlanShapingResult[] }
  | { readonly plans: readonly import("./threads.js").ProposedPlanArtifact[] }
);

export interface LingAppServerDeliberationSettlementParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly roundId: string;
  readonly expectedRoundRevision: number;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface LingAppServerStageDeliberationStartParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly workflowStepId: string;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
}

export interface LingAppServerDeliberationDecideParams extends LingAppServerDeliberationSettlementParams {
  readonly decision: { readonly disposition: "selected"; readonly option: string }
    | { readonly disposition: "deferred" | "replan_required" };
}

export interface LingAppServerDeliberationAppliedDecision {
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly planRevision: string;
  readonly option: string;
  readonly candidateDigest: string;
}

export interface LingAppServerDeliberationDecideResult extends LingAppServerWorkItemCollaborationAppendResult {
  readonly appliedTo?: LingAppServerDeliberationAppliedDecision;
}

export const LING_APP_SERVER_SERVER_REQUEST_METHODS = ["approval/requestDecision", "input/requestAnswer"] as const;
export type LingAppServerServerRequestMethod = (typeof LING_APP_SERVER_SERVER_REQUEST_METHODS)[number];

export interface LingAppServerServerRequest<Params = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: LingAppServerJsonRpcId;
  readonly method: LingAppServerServerRequestMethod;
  readonly params: Params;
}

export interface LingAppServerApprovalRespondParams {
  readonly cwd?: string;
  readonly approvalId: string;
  readonly decision: "approve" | "deny";
  readonly expectedRevision?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly reason?: string;
  readonly decisionKind?: "approve_once";
}

export interface LingAppServerApprovalRespondResult {
  readonly cwd: string;
  readonly approval: ApprovalRequest;
  readonly postCommit?: { readonly status: "deferred" };
}

export interface LingAppServerPendingApproval extends ApprovalSummary {
  readonly revision?: string;
}

export interface LingAppServerInputRespondParams extends UserInputAnswerCommandV1 {
  readonly cwd?: string;
}

export interface LingAppServerInputRespondResult {
  readonly cwd: string;
  readonly receipt: UserInputAnswerAcceptedResponseV1["receipt"];
}

export interface LingAppServerCandidateReference {
  readonly workspaceId: string;
  readonly worktreeId?: string;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly candidateDigest: string;
  readonly filePaths?: readonly string[];
}

export interface LingAppServerCaptureChangesResult {
  readonly cwd: string;
  readonly candidate: LingAppServerCandidateReference;
  readonly coverage: "complete" | "partial";
  readonly headCommit: string;
}

export type LingAppServerChangeWorktree = Pick<LingAppServerWorktreeTarget, "ownerKind" | "ownerId">;

export interface LingAppServerCaptureChangesParams {
  readonly cwd?: string;
  readonly sourceWorktree?: LingAppServerChangeWorktree;
  readonly scope?: "working_tree" | "head";
}

export interface LingAppServerReadChangesParams extends Omit<LingAppServerCaptureChangesParams, "scope"> {
  readonly candidateDigest: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface LingAppServerChangeHunk {
  readonly id: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface LingAppServerReadChangesResult extends LingAppServerCaptureChangesResult {
  readonly files: readonly (Omit<CodeAssessmentSnapshot["files"][number], "diff"> & {
    readonly diff?: string;
    readonly diffOmitted?: "frame_limit";
    readonly hunks?: readonly LingAppServerChangeHunk[];
  })[];
  readonly exclusions: CodeAssessmentSnapshot["exclusions"];
  readonly exclusionCount: number;
  readonly totalFileCount: number;
  readonly nextOffset?: number;
}

export interface LingAppServerPreviewChangeRecoveryParams {
  readonly cwd?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly action: "undo" | "reapply";
}

export interface LingAppServerChangeRecoveryPreview extends LingAppServerCaptureChangesResult {
  readonly expectedRevision: string;
  readonly action: LingAppServerPreviewChangeRecoveryParams["action"];
  readonly changes: TurnWorkspaceChangesResponse;
}

export interface LingAppServerApplyChangesParams extends LingAppServerPreviewChangeRecoveryParams {
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
  readonly confirmed: true;
}

export interface LingAppServerApplyChangesResult {
  readonly cwd: string;
  readonly turnId: string;
  readonly action: LingAppServerPreviewChangeRecoveryParams["action"];
  readonly receiptId: string;
  readonly state: TurnWorkspaceChangesResponse["state"];
}

export interface LingAppServerPreviewChangeTransferParams extends LingAppServerCaptureChangesParams {
  readonly action: "apply";
  readonly targetWorktree: LingAppServerChangeWorktree;
  readonly candidateDigest: string;
  readonly hunkIds: readonly string[];
}

export interface LingAppServerChangeTransferPreview extends LingAppServerCaptureChangesResult {
  readonly action: "apply";
  readonly targetWorktree: LingAppServerChangeWorktree;
  readonly targetHeadCommit: string;
  readonly targetCandidateDigest: string;
  readonly expectedRevision: string;
  readonly selection: readonly { readonly path: string; readonly hunkIds: readonly string[] }[];
}

export interface LingAppServerApplyChangeTransferParams extends LingAppServerPreviewChangeTransferParams {
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
  readonly confirmed: true;
}

export interface LingAppServerApplyChangeTransferResult {
  readonly cwd: string;
  readonly action: "apply";
  readonly targetWorktree: LingAppServerChangeWorktree;
  readonly receiptId: string;
  readonly state: "applied" | "not_applied" | "unknown";
  readonly paths: readonly string[];
}

export interface LingAppServerWorktreeTarget {
  readonly cwd?: string;
  readonly ownerKind: ManagedWorktreeOwnerKind;
  readonly ownerId: string;
}

export interface LingAppServerWorktreeCreateParams extends LingAppServerWorktreeTarget {
  readonly baseBranch?: string;
}

export interface LingAppServerWorktreeResult {
  readonly cwd: string;
  readonly entry: ManagedWorktreeEntry;
}

export interface LingAppServerWorktreeCleanupPreview extends LingAppServerWorktreeResult {
  readonly expectedRevision: string;
}

export interface LingAppServerWorktreeCleanupParams extends LingAppServerWorktreeTarget {
  readonly expectedRevision: string;
  readonly confirmed: true;
}

export interface LingAppServerWorktreeCleanupResult extends LingAppServerWorktreeResult {
  readonly snapshot: WorktreeRecoverySnapshot;
}

export interface LingAppServerHandoffCreateParams {
  readonly cwd?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly idempotencyKey: string;
  readonly nextInstruction: string;
}

export interface LingAppServerHandoffReadParams {
  readonly cwd?: string;
  readonly handoffId: string;
}

export interface LingAppServerHandoffResumeParams extends LingAppServerHandoffReadParams {
  readonly providerPresetId: string;
}

export interface LingAppServerHandoff {
  readonly handoffId: string;
  readonly sourceThreadId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly sourceTurnRevision: string;
  readonly createdAt: string;
  readonly candidate: LingAppServerCandidateReference;
  readonly nextInstruction: string;
  readonly goal?: Pick<LingThreadGoal, "id" | "objective" | "updatedAt" | "status" | "lastContinuationStopReason"
    | "continuationDepth" | "completionEvidenceRefs" | "blockedReason" | "tokenBudget" | "tokensUsed">;
  readonly plan?: { readonly id: string; readonly revision: number };
  readonly artifactIds: readonly string[];
}

export interface LingAppServerHandoffResult {
  readonly cwd: string;
  readonly handoff: LingAppServerHandoff;
}

export interface LingAppServerHandoffResumeResult {
  readonly cwd: string;
  readonly handoffId: string;
  readonly thread: LingThread;
  readonly turn?: LingTurn;
  readonly run?: RunSession;
  readonly goalTransfer?: LingAppServerHandoffGoalTransfer;
  readonly replayed: boolean;
}

export interface LingAppServerHandoffGoalTransfer {
  readonly goalId: string;
  readonly sourceThreadId: string;
  readonly threadId: string;
  readonly sourceGoalRevision: string;
  readonly transferredAt: string;
}

export interface LingAppServerGitHubSubjectParams {
  readonly cwd?: string;
  readonly repository: string;
  readonly kind: "issue" | "pull_request";
  readonly number: number;
}

export interface LingAppServerGitHubSubject extends Omit<LingAppServerGitHubSubjectParams, "cwd"> {
  readonly githubInstanceId: "github.com";
  readonly repositoryId: string;
  readonly title: string;
  readonly labels?: readonly string[];
  readonly state: "open" | "closed";
  readonly sourceRevision: string;
  readonly baseRef?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly mergeSha?: string;
  readonly merged?: boolean;
}

interface GitHubIntakePolicyScope {
  readonly enabled: boolean;
  readonly requiredLabel?: string;
  readonly webhookSourceId?: string;
  readonly priority?: "low" | "normal" | "high" | "urgent";
}

export type LingAppServerGitHubIntakeBudget = import("./work-items.js").WorkIntakeBudget;
export type LingAppServerGitHubIntakeQuietHours = import("./work-items.js").WorkIntakeQuietHours;

export type LingAppServerGitHubIntakePolicy = GitHubIntakePolicyScope & (
  | { readonly mode: "manual" | "suggest" }
  | {
    readonly mode: "auto_start";
    readonly requiredLabel: string;
    readonly providerPresetId: string;
    readonly budget: LingAppServerGitHubIntakeBudget;
    readonly quietHours?: LingAppServerGitHubIntakeQuietHours;
  }
);

export interface LingAppServerGitHubIntakeReceipt {
  readonly receiptId: string;
  readonly sourceEventId: string;
  readonly origin: "webhook" | "poll";
  readonly repository: string;
  readonly policyRevision: string;
  readonly subject: { readonly kind: "issue" | "pull_request"; readonly number: number };
  readonly outcome: "manual" | "suggested" | "accepted" | "suppressed" | "paused" | "deduplicated";
  readonly reasonCode: string;
  readonly workItemId?: string;
  readonly evaluatedAt: string;
}

export interface LingAppServerGitHubIntakePollParams {
  readonly cwd?: string;
  readonly repository: string;
  readonly page?: number;
  readonly retryKey?: string;
}

export interface LingAppServerGitHubIntakePolicyList {
  readonly cwd: string;
  readonly sources: readonly {
    readonly repository: string;
    readonly revision: string;
    readonly policy: LingAppServerGitHubIntakePolicy;
    readonly providerAvailable?: boolean;
  }[];
}

export interface LingAppServerGitHubIntakePollResult {
  readonly cwd: string;
  readonly receipts: readonly LingAppServerGitHubIntakeReceipt[];
  readonly nextPage?: number;
}

export interface LingAppServerGitHubIntakeReadParams {
  readonly cwd?: string;
  readonly receiptId: string;
}

export interface LingAppServerGitHubSubjectResult {
  readonly cwd: string;
  readonly subject: LingAppServerGitHubSubject;
}

export type LingGitHubVerificationBasis = "head" | "integration" | "merge_group";

export interface LingGitHubRequiredCheck {
  readonly name: string;
  readonly appId: number;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly workflowSha256: string;
  readonly basis: LingGitHubVerificationBasis;
  readonly coverageRefs: readonly string[];
}

export interface LingGitHubCiEvidence {
  readonly check: LingGitHubRequiredCheck;
  readonly testedCommit?: string;
  readonly checkRunId?: number;
  readonly runId?: number;
  readonly runAttempt?: number;
  readonly jobId?: number;
  readonly outcome: "passed" | "failed" | "pending" | "unavailable";
  readonly reason?: "applicable_check_missing" | "current_attempt_pending" | "integration_unavailable"
    | "merge_group_membership_unavailable" | "ambiguous_run" | "observation_window_exceeded" | "workflow_source_changed";
}

export interface LingGitHubMergeGroupEvidence {
  readonly queueEntryId: string;
  readonly baseCommit: string;
  readonly testedCommit: string;
  readonly testedTree?: string;
  readonly membershipProofRef: string;
}

export interface LingAppServerGitHubDelivery {
  readonly deliveryId: string;
  readonly workItemId: string;
  readonly acceptanceId: string;
  readonly threadId: string;
  readonly candidateDigest: string;
  readonly policyRevision: string;
  readonly subject: LingAppServerGitHubSubject;
  readonly baseCommit: string;
  readonly checks: readonly LingGitHubCiEvidence[];
  readonly mergeGroup?: LingGitHubMergeGroupEvidence;
  readonly status: "ci_pending" | "ci_failed" | "delivery_pending" | "delivered";
  readonly mergedCommit?: string;
  readonly observedAt: string;
}

export interface LingAppServerReconcileGitHubDeliveryParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly threadId: string;
  readonly expectedWorkItemRevision: number;
  readonly candidateDigest: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
}

export interface LingAppServerGitHubDeliveryResult {
  readonly cwd: string;
  readonly delivery: LingAppServerGitHubDelivery;
}

export interface LingAppServerGitHubQueueParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly queueReceiptId: string;
}

export interface LingAppServerGitHubEnqueueParams {
  readonly cwd?: string;
  readonly workItemId: string;
  readonly deliveryId: string;
  readonly expectedWorkItemRevision: number;
  readonly idempotencyKey: string;
  readonly confirmed: true;
}

export interface LingAppServerGitHubQueueReceipt {
  readonly queueReceiptId: string;
  readonly workItemId: string;
  readonly deliveryId: string;
  readonly repository: string;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly status: "pending" | "enqueued" | "merged" | "rejected" | "unknown";
  readonly rejectedHttpStatus?: 401 | 429;
  readonly queueEntryId?: string;
  readonly mergedCommit?: string;
  readonly createdAt: string;
}

export interface LingAppServerGitHubQueueResult {
  readonly cwd: string;
  readonly receipt: LingAppServerGitHubQueueReceipt;
}

export interface LingAppServerWorkItemSourceReceipt {
  readonly workItemId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly targetKey: string;
}

export type LingAppServerVerificationCheckKind = "command" | "test" | "typecheck" | "browser" | "platform";
export type LingAppServerVerificationCheckStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "not_run"
  | "blocked"
  | "cancelled"
  | "unknown";

export interface LingAppServerVerificationCheckPlan {
  readonly checkId: string;
  readonly kind: LingAppServerVerificationCheckKind;
  readonly label: string;
  readonly command?: string;
  readonly recipeDigest: string;
  readonly verifierBasisRef?: string;
  readonly coverageDigest?: string;
  readonly producerRefs?: readonly string[];
  readonly required: boolean;
  readonly estimatedDurationMs?: number;
}

export interface LingAppServerVerifyPlanParams {
  readonly cwd?: string;
  readonly workItemId?: string;
  readonly threadId?: string;
  readonly candidate: LingAppServerCandidateReference;
  readonly planRevision?: string;
  readonly requestedChecks?: readonly string[];
  readonly idempotencyKey?: string;
}

export interface LingAppServerVerifyPlanResult {
  readonly planId: string;
  readonly planRevision: string;
  readonly threadId?: string;
  readonly workItemId?: string;
  readonly acceptedPlanRevision?: string;
  readonly candidate: LingAppServerCandidateReference;
  readonly checks: readonly LingAppServerVerificationCheckPlan[];
  readonly rationale: readonly string[];
  readonly requiredApproval?: string;
  readonly environmentRequirements: readonly string[];
}

export interface LingAppServerVerifyStartParams {
  readonly cwd?: string;
  readonly planId: string;
  readonly planRevision: string;
  readonly candidateDigest: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerCheckEvidence {
  readonly checkId: string;
  readonly candidateDigest: string;
  readonly planRevision: string;
  readonly recipeDigest: string;
  readonly environmentDigest: string;
  readonly verifierBasisRef?: string;
  readonly coverageDigest?: string;
  readonly producerRefs: readonly string[];
  readonly attemptId: string;
  readonly status: LingAppServerVerificationCheckStatus;
  readonly evidenceRefs: readonly string[];
  readonly execution?: LingAppServerVerificationExecution;
}

export interface LingAppServerVerificationExecution {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly outputTruncated: boolean;
}

export interface LingAppServerVerifyOperation {
  readonly operationId: string;
  readonly revision?: string;
  readonly planId: string;
  readonly threadId?: string;
  readonly workItemId?: string;
  readonly candidateDigest: string;
  readonly status: "queued" | "running" | "passed" | "failed" | "blocked" | "cancelled" | "unknown";
  readonly checks: readonly LingAppServerCheckEvidence[];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly blocker?: string;
}

export interface LingAppServerVerifyStatusParams {
  readonly cwd?: string;
  readonly operationId: string;
}

export interface LingAppServerVerifyStatusResult {
  readonly operation: LingAppServerVerifyOperation;
}

export interface WorkspaceVerificationReport {
  readonly cwd: string;
  readonly operation: LingAppServerVerifyOperation | null;
  readonly plan: LingAppServerVerifyPlanResult | null;
  readonly candidateState?: "current" | "changed" | "unavailable";
}

export interface StartWorkspaceVerificationRequest {
  readonly idempotencyKey: string;
  readonly threadId?: string;
}

export interface LingAppServerVerifyCancelParams {
  readonly cwd?: string;
  readonly operationId: string;
  readonly expectedRevision?: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerVerifyCancelResult {
  readonly operationId: string;
  readonly status: "cancel_requested" | "cancelled" | "already_terminal" | "unknown";
}

export interface LingAppServerReviewStartParams {
  readonly cwd?: string;
  readonly workItemId?: string;
  readonly planRevision?: string;
  readonly candidate: LingAppServerCandidateReference;
  readonly baseInstructions?: string;
  readonly reviewRulesRefs?: readonly string[];
  readonly providerPresetId?: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerReviewStartResult {
  readonly operationId: string;
  readonly assessmentId: string;
  readonly candidateDigest: string;
  readonly status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  readonly workItem?: import("./code-assessments.js").CodeAssessmentWorkItemScope;
}

export interface LingAppServerReviewStatusParams {
  readonly cwd?: string;
  readonly operationId?: string;
  readonly assessmentId?: string;
}

export interface LingAppServerReviewStatusResult extends LingAppServerReviewStartResult {
  readonly revision: string;
  readonly findingIds: readonly string[];
  readonly summary?: string;
  readonly errorMessage?: string;
  readonly reviewRules?: CodeAssessmentReviewRules;
}

export interface LingAppServerReviewFindingUpdateParams {
  readonly cwd?: string;
  readonly assessmentId: string;
  readonly findingId: string;
  readonly disposition: "open" | "acknowledged" | "resolved" | "dismissed";
  readonly closeReason?: CodeFindingCloseReason;
  readonly reason?: string;
  readonly expectedRevision?: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerReviewFindingUpdateResult {
  readonly assessmentId: string;
  readonly findingId: string;
  readonly revision: string;
  readonly disposition: LingAppServerReviewFindingUpdateParams["disposition"];
}

export interface LingAppServerSimplifyStartParams {
  readonly cwd?: string;
  readonly workItemId?: string;
  readonly candidate: LingAppServerCandidateReference;
  readonly providerPresetId?: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerSimplifyStartResult {
  readonly operationId: string;
  readonly candidateDigest: string;
  readonly status: LingAppServerReviewStartResult["status"];
  readonly suggestionArtifactId?: string;
}

export interface LingAppServerSimplifyStatusParams {
  readonly cwd?: string;
  readonly operationId: string;
  readonly offset?: number;
}

export type LingAppServerSimplificationSuggestion = Pick<CodeAssessmentFinding,
  "id" | "title" | "body" | "path" | "side" | "startLine" | "endLine" | "evidence"
>;

export interface LingAppServerSimplifyStatusResult extends LingAppServerSimplifyStartResult {
  readonly revision: string;
  readonly summary?: string;
  readonly errorMessage?: string;
  readonly suggestions: readonly LingAppServerSimplificationSuggestion[];
  readonly nextOffset?: number;
}

export interface LingAppServerDoctorRunParams {
  readonly cwd?: string;
  readonly includeLogTail?: boolean;
  readonly scope?: "workspace" | "project" | "candidate";
}

export interface LingAppServerDoctorRunResult {
  readonly doctorVersion: 1;
  readonly cwd: string;
  readonly overallStatus: "ok" | "warning" | "fail";
  readonly checks: readonly LingAppServerDoctorCheck[];
  readonly generatedAt: string;
  readonly logTail?: { readonly truncated: boolean; readonly lines: readonly string[] };
}

export interface LingAppServerDoctorCheck {
  readonly id: string;
  readonly category: "workspace" | "startup" | "logs" | "config" | "instructions" | "verification";
  readonly status: "ok" | "warning" | "fail" | "unchecked";
  readonly summary: string;
  readonly details?: string;
  readonly remediation?: string;
}

export interface LingAppServerInstructionsInitParams {
  readonly cwd?: string;
  readonly taskPath?: string;
  readonly sources?: readonly ("README" | "CI" | "package_scripts" | "existing_rules")[];
  readonly mode?: "preview" | "apply";
  readonly expectedWorkspaceRevision?: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerInstructionSource {
  readonly path: string;
  readonly digest: string;
  readonly scope: string;
  readonly applicable: boolean;
  readonly textBytes?: number;
  readonly origin?: "claude";
  readonly pathPatterns?: readonly string[];
}

export interface LingAppServerProjectInstructionManifest {
  readonly version: 1;
  readonly digest: string;
  readonly sources: readonly LingAppServerInstructionSource[];
  readonly omitted: readonly string[];
  readonly claudeProjectRules?: readonly string[];
}

export interface LingAppServerThreadSnapshotParams {
  readonly cwd?: string;
  readonly threadId: string;
}

export interface LingAppServerThreadSnapshotResult {
  readonly cwd: string;
  readonly cursor: string;
  readonly thread: LingThread;
  readonly turn: LingTurn | null;
  readonly goal: Pick<LingThreadGoal, "id" | "objective" | "status" | "tokenBudget" | "tokensUsed" | "timeUsedSeconds" | "updatedAt"> | null;
  readonly run: Pick<RunSession, "id" | "status" | "startedAt" | "endedAt"> | null;
  readonly pendingApprovals: readonly LingAppServerPendingApproval[];
  readonly pendingInputs: readonly UserInputRequestTranscriptV1[];
}

export interface LingAppServerTurnResumeParams {
  readonly cwd?: string;
  readonly turnId: string;
  readonly threadId?: string;
  readonly expectedTurnRevision?: string;
  readonly sourceRunId?: string;
  readonly idempotencyKey?: string;
  readonly instruction?: string;
}

export interface LingAppServerTurnResumeResult {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly run: RunSession | null;
  readonly runLinks: readonly LingTurnRun[];
  readonly disposition: "existing" | "recovered" | "continued";
  readonly resumedFromTurnId?: string;
}

export interface LingAppServerContextInspectParams extends LingAppServerThreadSnapshotParams {
  readonly turnId: string;
}

export interface LingAppServerContextInspectResult extends Omit<LingAppServerContextInspectParams, "cwd"> {
  readonly cwd: string;
  readonly projectInstructions: LingAppServerProjectInstructionManifest | null;
  readonly projectInstructionUpdates?: readonly LingAppServerProjectInstructionUpdate[];
  readonly context: ConversationContextProjectionMetadata | null;
}

export interface LingAppServerProjectInstructionUpdate {
  readonly runId: string;
  readonly manifest: LingAppServerProjectInstructionManifest;
  readonly presentedSourceCount: number;
}

export interface LingAppServerInstructionsInitResult {
  readonly proposalId: string;
  readonly status: "draft" | "applied" | "blocked";
  readonly sources: readonly LingAppServerInstructionSource[];
  readonly patchArtifactId?: string;
  readonly draft?: { readonly path: string; readonly content: string };
  readonly workspaceRevision?: string;
  readonly conflicts: readonly string[];
}

export const LING_APP_SERVER_EXTERNAL_AGENT_ADAPTER_KINDS = [
  "ling-app-server",
  "codex-app-server",
  "claude-agent",
  "acp",
  "mcp",
  "custom",
] as const;

export type LingAppServerExternalAgentAdapterKind = (typeof LING_APP_SERVER_EXTERNAL_AGENT_ADAPTER_KINDS)[number];

export const LING_APP_SERVER_EXTERNAL_AGENT_SOURCES = ["local", "workspace", "managed"] as const;
export type LingAppServerExternalAgentSource = (typeof LING_APP_SERVER_EXTERNAL_AGENT_SOURCES)[number];

export interface LingAppServerExternalAgentRegistration {
  readonly agentId: string;
  readonly adapterKind: LingAppServerExternalAgentAdapterKind;
  readonly protocolVersion: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly workspaceScopes: readonly string[];
  readonly toolScopes: readonly string[];
  readonly approvalModes: readonly string[];
  readonly source: LingAppServerExternalAgentSource;
  readonly version: string;
}

export interface LingAppServerExternalAgentRegisterParams {
  readonly registration: LingAppServerExternalAgentRegistration;
  readonly idempotencyKey: string;
}

export interface LingAppServerExternalAgentRegisterResult {
  readonly registrationId: string;
  readonly agentId: string;
  readonly acceptedCapabilities: readonly string[];
  readonly deniedCapabilities: readonly string[];
  readonly authorizationEpoch: string;
}

export interface LingAppServerExternalAgentCapabilitiesParams {
  readonly registrationId: string;
}

export interface LingAppServerExternalAgentCapabilitiesResult {
  readonly registrationId: string;
  readonly capabilities: readonly string[];
  readonly effectiveWorkspaceScopes: readonly string[];
  readonly effectiveToolScopes: readonly string[];
  readonly approvalModes: readonly string[];
  readonly authorizationEpoch: string;
}

export interface LingAppServerExternalAgentTaskSubmission {
  readonly workItemId: string;
  readonly workItemRevision: string;
  readonly objective: string;
  readonly acceptanceSnapshot: unknown;
  readonly workspaceId: string;
  readonly worktreeId?: string;
  readonly instructionManifestDigest: string;
  readonly skillSnapshot?: unknown;
  readonly parentLineage?: readonly string[];
  readonly idempotencyKey: string;
}

export interface LingAppServerExternalAgentTaskStartParams {
  readonly registrationId: string;
  readonly submission: LingAppServerExternalAgentTaskSubmission;
}

export interface LingAppServerExternalAgentTaskReceipt {
  readonly taskId: string;
  readonly submissionId: string;
  readonly workItemId: string;
  readonly workItemRevision: string;
  readonly status: "accepted" | "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled" | "unknown";
  readonly outcomeReason?: string;
  readonly eventCursor?: string;
  readonly parentRunId?: string;
  readonly dispatchDepth: number;
}

export interface LingAppServerExternalAgentTaskStartResult {
  readonly task: LingAppServerExternalAgentTaskReceipt;
  readonly replayed?: true;
}

export interface LingAppServerExternalAgentTaskReconnectParams {
  readonly registrationId: string;
  readonly taskId: string;
  readonly submissionId: string;
  readonly eventCursor?: string;
}

export interface LingAppServerExternalAgentTaskReconnectResult {
  readonly task: LingAppServerExternalAgentTaskReceipt;
  readonly events?: readonly {
    readonly cursor: string;
    readonly type: string;
    readonly payload?: unknown;
    readonly createdAt: string;
  }[];
  readonly resyncRequired: boolean;
  readonly reason?: "cursor_unavailable" | "submission_conflict" | "authorization_changed";
}

export interface LingAppServerExternalAgentTaskCancelParams {
  readonly registrationId: string;
  readonly taskId: string;
  readonly expectedTaskRevision?: string;
  readonly idempotencyKey: string;
}

export interface LingAppServerExternalAgentTaskCancelResult {
  readonly taskId: string;
  readonly status: "cancel_requested" | "cancelled" | "already_terminal" | "unknown";
}

export function isLingAppServerMethod(value: unknown): value is LingAppServerMethod {
  return typeof value === "string" && (LING_APP_SERVER_METHODS as readonly string[]).includes(value);
}

export function isLingAppServerNotificationMethod(value: unknown): value is LingAppServerNotificationMethod {
  return typeof value === "string" && (LING_APP_SERVER_NOTIFICATION_METHODS as readonly string[]).includes(value);
}

export function isLingAppServerErrorCode(value: unknown): value is LingAppServerErrorCode {
  return typeof value === "string" && (LING_APP_SERVER_ERROR_CODES as readonly string[]).includes(value);
}

export function isLingAppServerRequest(value: unknown): value is LingAppServerRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !isLingAppServerMethod(value.method)) return false;
  if ("id" in value && value.id !== undefined && !isJsonRpcId(value.id)) return false;
  return !(("params" in value) && value.params === undefined);
}

export function isLingAppServerNotification(value: unknown): value is LingAppServerNotification {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !isLingAppServerNotificationMethod(value.method)) return false;
  return !(("id" in value) && value.id !== undefined);
}

function isJsonRpcId(value: unknown): value is LingAppServerJsonRpcId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
