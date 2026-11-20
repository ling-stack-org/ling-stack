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
  "workItem.read",
  "workItem.control",
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

export interface LingAppServerServerRequest<Params = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: LingAppServerJsonRpcId;
  readonly method: "approval/requestDecision" | "input/requestAnswer";
  readonly params: Params;
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
