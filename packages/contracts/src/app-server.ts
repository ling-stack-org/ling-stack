import type { CodeAssessmentFinding, CodeAssessmentReviewRules, CodeFindingCloseReason } from "./code-assessments.js";
import type { ApprovalSummary, ControlPlaneEventsResponse, ControlPlaneReplayWindow } from "./control-plane.js";
import type { ConversationContextProjectionMetadata } from "./conversation-continuity.js";
import type { RunSession } from "./runtime.js";
import type { LingThread, LingThreadGoal } from "./threads.js";
import type { LingTurn, LingTurnRun } from "./turns.js";
import type { UserInputAnswerAcceptedResponseV1, UserInputAnswerCommandV1 } from "./user-input.js";
import type { UserInputRequestTranscriptV1 } from "./user-input-transcript.js";

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
  "workItem.read",
  "workItem.control",
  "workItem.evidence",
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
  "workItem.read",
  "workItem.control",
  "workItem.evidence",
  "workItem.deliberation",
  "workItem.coordination",
  "externalAgent.federation",
] as const satisfies readonly LingAppServerCapability[];

export type LingAppServerImplementedCapability = (typeof LING_APP_SERVER_IMPLEMENTED_CAPABILITIES)[number];

export const LING_APP_SERVER_METHODS = [
  "initialize",
  "server/capabilities",
  "server/ping",
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
  "workItem/clarify",
  "workItem/pause",
  "workItem/resume",
  "workItem/cancel",
  "workItem/subscribe",
  "workItem/unsubscribe",
  "workItem/delivery/read",
  "workItem/feedback/add",
  "delivery/read",
  "github/subject/read",
  "github/delivery/reconcile",
  "workItem/evidence/read",
  "workItem/evidence/append",
  "workItem/collaboration/read",
  "workItem/collaboration/append",
  "workItem/deliberation/start",
  "workItem/deliberation/read",
  "workItem/deliberation/cancel",
  "workItem/deliberation/decide",
  "workItem/stage/read",
  "workItem/stage/brief/read",
  "workItem/coordination/start",
  "workItem/coordination/read",
  "workItem/coordination/close",
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
  "workItem/feedback/received",
  "workItem/control/updated",
  "workItem/evidence/updated",
  "workItem/collaboration/updated",
  "workItem/deliberation/updated",
  "workItem/stage/updated",
  "workItem/brief/updated",
  "workItem/coordination/updated",
  "workItem/message/updated",
  "workItem/question/updated",
  "workItem/handoff/updated",
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
  readonly storeIncarnation?: string;
  readonly authorizationEpoch?: string;
}

export interface LingAppServerCapabilitiesResult {
  readonly protocolVersion: typeof LING_APP_SERVER_PROTOCOL_VERSION;
  readonly capabilities: readonly LingAppServerCapability[];
  readonly methods: readonly LingAppServerMethod[];
  readonly notifications: readonly LingAppServerNotificationMethod[];
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
  readonly eventCursor?: string;
}

export interface LingAppServerWorkItemResult {
  readonly cwd: string;
  readonly workItem: LingAppServerWorkItemSnapshot;
}

export interface LingAppServerWorkItemReadResult extends LingAppServerWorkItemResult {
  readonly cursor: string;
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
}

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

export interface LingAppServerWorkItemCollaborationAppendResult {
  readonly status: "appended" | "replayed";
  readonly record: LingAppServerWorkItemCollaborationRecord;
  readonly workItemRevision: number;
}

export interface LingAppServerDeliberationTriggerPolicyV1 {
  readonly enabled: boolean;
  readonly onPlanFormation: boolean;
  readonly onDeclaredDecisionPoint: boolean;
  readonly onConflictingRecommendations: boolean;
  readonly onMaterialRequirementChange: boolean;
  readonly minimumParticipants: number;
  readonly maxRounds: number;
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
}

export interface LingAppServerDeliberationTriggerDecisionV1 {
  readonly shouldOpen: boolean;
  readonly requiresHumanDecision: boolean;
  readonly reason: string;
  readonly triggerKind: LingAppServerDeliberationTriggerKindV1;
}

export interface LingAppServerServerRequest<Params = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: LingAppServerJsonRpcId;
  readonly method: "approval/requestDecision" | "input/requestAnswer";
  readonly params: Params;
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
}

export interface LingAppServerReviewStatusParams {
  readonly cwd?: string;
  readonly operationId?: string;
  readonly assessmentId?: string;
}

export interface LingAppServerReviewStatusResult {
  readonly operationId: string;
  readonly assessmentId: string;
  readonly candidateDigest: string;
  readonly status: LingAppServerReviewStartResult["status"];
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
}

export interface LingAppServerProjectInstructionManifest {
  readonly version: 1;
  readonly digest: string;
  readonly sources: readonly LingAppServerInstructionSource[];
  readonly omitted: readonly string[];
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
  readonly pendingApprovals: readonly ApprovalSummary[];
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
  readonly context: ConversationContextProjectionMetadata | null;
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
