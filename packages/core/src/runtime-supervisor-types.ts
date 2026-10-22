import { randomUUID } from "node:crypto";
import type { RuntimeAttemptFenceV1, WorkspaceRuntimeSettings } from "@ling-stack/contracts";

export type { RuntimeAttemptFenceV1 } from "@ling-stack/contracts";

export type RuntimeInstanceStatus = "healthy" | "starting" | "stopping" | "recovering";

export interface RuntimeInstance {
  readonly workspaceId: string;
  readonly runtimeInstanceId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: string;
  readonly version: string;
  readonly schemaVersion: number;
  readonly status: RuntimeInstanceStatus;
}

export type WorkUnitKind =
  | "task_run"
  | "conversation_run"
  | "approval_review"
  | "channel_turn_dispatch"
  | "channel_ai_reply"
  | "channel_terminal_report"
  | "teammate_direct_reply"
  | "external_work_step"
  | "external_work_action"
  | "media_job";

export type WorkUnitStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale";

export type WorkUnitAttemptStatus =
  | "created"
  | "started"
  | "waiting_for_approval"
  | "cancelling"
  | "yielded"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type RuntimeEventType =
  | "work_unit_created"
  | "work_unit_queued"
  | "work_unit_claimed"
  | "work_unit_started"
  | "work_unit_heartbeat"
  | "work_unit_progress"
  | "work_unit_approval_requested"
  | "work_unit_waiting_for_input"
  | "work_unit_cancelling"
  | "work_unit_succeeded"
  | "work_unit_failed"
  | "work_unit_cancelled"
  | "work_unit_stale"
  | "lease_acquired"
  | "lease_renewed"
  | "lease_released"
  | "semaphore_acquired"
  | "semaphore_released"
  | "artifact_created"
  | "tool_namespace_materialized"
  | "tool_hydration_rejected"
  | "web_evidence_recorded"
  | "stale_runner_completion_ignored"
  | "diagnostic_stuck_detected";

export type RuntimeSemaphoreResourceType = "provider" | "channel_parallel" | "runner" | "media_provider";

export type RuntimeSemaphoreSlotStatus = "active" | "released" | "expired";

export interface RuntimeTimeoutPolicy {
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly cancelGraceMs: number;
}

export const defaultRuntimeTimeoutPolicy: RuntimeTimeoutPolicy = {
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 45_000,
  idleTimeoutMs: 10 * 60_000,
  hardTimeoutMs: 60 * 60_000,
  cancelGraceMs: 15_000,
};

export interface RunnerFallbackReason {
  readonly code:
    | "missing_requested_runner"
    | "disabled_requested_runner"
    | "unsupported_provider_api"
    | "unsupported_tool"
    | "runner_tool_conformance_failed";
  readonly message: string;
}

export type RunnerFallbackPolicy = "disabled" | "allow_to_default";

export type RunnerRequestSource =
  | "product_default"
  | "workspace_default"
  | "teammate_default"
  | "workflow_step"
  | "run_request"
  | "user_explicit";

export type { WorkspaceRuntimeSettings } from "@ling-stack/contracts";

export interface WorkUnit {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: WorkUnitKind;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly idempotencyKey: string;
  readonly status: WorkUnitStatus;
  readonly priority: number;
  readonly attemptCount: number;
  readonly activeAttemptId?: string;
  readonly createdByClientId?: string;
  readonly createdByActor: "user" | "system" | "scheduler";
  readonly request: unknown;
  readonly timeoutPolicy: RuntimeTimeoutPolicy;
  readonly linkedRunId?: string;
  readonly linkedMessageId?: string;
  readonly linkedMediaJobId?: string;
  readonly linkedExternalWorkId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastEventAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface CreateWorkUnitInput {
  readonly id?: string;
  readonly workspaceId: string;
  readonly kind: WorkUnitKind;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly idempotencyKey: string;
  readonly status?: WorkUnitStatus;
  readonly priority?: number;
  readonly createdByClientId?: string;
  readonly createdByActor: WorkUnit["createdByActor"];
  readonly request: unknown;
  readonly timeoutPolicy?: RuntimeTimeoutPolicy;
  readonly linkedRunId?: string;
  readonly linkedMessageId?: string;
  readonly linkedMediaJobId?: string;
  readonly linkedExternalWorkId?: string;
  readonly now: string;
}

/** Discovery position in the descending creation-time, id ordering. */
export interface WorkUnitDiscoveryCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ListWorkUnitsOptions {
  readonly status?: WorkUnitStatus;
  readonly kind?: WorkUnitKind;
  readonly ownerType?: string;
  readonly ownerId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly linkedRunId?: string;
  readonly linkedMessageId?: string;
  readonly linkedMediaJobId?: string;
  readonly limit?: number;
  /** Exclusive discovery position; does not authorize recovery or execution. */
  readonly after?: WorkUnitDiscoveryCursor;
  /** Frozen sweep cutoff. Rows created later are discovered by a subsequent sweep. */
  readonly createdAtOrBefore?: string;
}

export interface WorkUnitAttempt {
  readonly id: string;
  readonly workUnitId: string;
  readonly attemptNumber: number;
  /** Decimal monotonic fence generation, serialized as text at the JS boundary. */
  readonly fencingToken: string;
  readonly runtimeInstanceId: string;
  readonly runnerId: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly providerPresetId?: string;
  readonly status: WorkUnitAttemptStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastEventAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly abortRequestedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Projects a persisted WorkUnitAttempt into the complete CAS fence required by
 * runtime-owned writes. Keeping this conversion in the core contract prevents
 * callers from accidentally using the storage id as an attempt id or omitting
 * the runtime instance/token pair during recovery.
 */
export function toRuntimeAttemptFence(attempt: WorkUnitAttempt): RuntimeAttemptFenceV1 {
  return {
    workUnitId: attempt.workUnitId,
    attemptId: attempt.id,
    runtimeInstanceId: attempt.runtimeInstanceId,
    fencingToken: attempt.fencingToken,
  };
}

export interface CreateWorkUnitAttemptInput {
  readonly id?: string;
  readonly workUnitId: string;
  readonly attemptNumber: number;
  readonly fencingToken?: string;
  readonly runtimeInstanceId: string;
  readonly runnerId: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly providerPresetId?: string;
  readonly status?: WorkUnitAttemptStatus;
  readonly now: string;
}

export interface RuntimeEvent {
  readonly id: string;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly runtimeInstanceId?: string;
  readonly fencingToken?: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: RuntimeEventType;
  readonly actor: "system" | "runner" | "provider" | "local-user";
  readonly data: unknown;
}

interface RuntimeEventFields {
  readonly type: RuntimeEventType;
  readonly actor: RuntimeEvent["actor"];
  readonly data: unknown;
  readonly ts: string;
}

export type AppendRuntimeEventInput = RuntimeEventFields & (
  | RuntimeAttemptFenceV1
  | {
      readonly workUnitId: string;
      readonly attemptId?: never;
      readonly runtimeInstanceId?: never;
      readonly fencingToken?: never;
    }
);

export type TerminalAttemptStatus = Extract<WorkUnitAttemptStatus, "succeeded" | "failed" | "cancelled" | "lost">;
export type TerminalRuntimeEventType = Extract<
  RuntimeEventType,
  "work_unit_succeeded" | "work_unit_failed" | "work_unit_cancelled" | "work_unit_stale"
>;

export interface TerminalAuditCapabilityV1 extends RuntimeAttemptFenceV1 {
  readonly attemptStatus: TerminalAttemptStatus;
  readonly transitionedAt: string;
}

export interface AppendTerminalRuntimeAuditInput extends Omit<RuntimeEventFields, "ts"> {
  readonly capability: TerminalAuditCapabilityV1;
  readonly type: TerminalRuntimeEventType;
}

export interface AppendRuntimeDiagnosticEventInput {
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly runtimeInstanceId?: string;
  readonly fencingToken?: string;
  readonly type: Extract<RuntimeEventType, "stale_runner_completion_ignored" | "diagnostic_stuck_detected">;
  readonly actor: RuntimeEvent["actor"];
  readonly data: unknown;
  readonly ts: string;
}

export interface ListRuntimeEventsOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface RuntimeHeartbeat {
  readonly id: string;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly runtimeInstanceId: string;
  readonly fencingToken: string;
  readonly ts: string;
  readonly source: "supervisor" | "runner" | "provider";
  readonly detail?: unknown;
}

export interface RecordRuntimeHeartbeatInput extends RuntimeAttemptFenceV1 {
  readonly ts: string;
  /** Trusted Host deadline, renewed atomically with the heartbeat. */
  readonly resourceExpiresAt: string;
  readonly source: RuntimeHeartbeat["source"];
  readonly detail?: unknown;
}

export interface RuntimeResourceRenewal {
  readonly renewedAt: string;
  readonly expiresAt: string;
}

export interface RuntimeSemaphoreSlot {
  readonly id: string;
  readonly workspaceId: string;
  readonly resourceType: RuntimeSemaphoreResourceType;
  readonly resourceKey: string;
  readonly ownerType: "work_unit_attempt" | "system";
  readonly ownerId: string;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly runtimeInstanceId: string;
  readonly fencingToken: string;
  readonly status: RuntimeSemaphoreSlotStatus;
  readonly acquiredAt: string;
  readonly lastRenewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
}

export interface AcquireRuntimeSemaphoreSlotInput extends RuntimeAttemptFenceV1 {
  readonly workspaceId: string;
  readonly resourceType: RuntimeSemaphoreResourceType;
  readonly resourceKey: string;
  readonly limit: number;
  readonly ownerType: RuntimeSemaphoreSlot["ownerType"];
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface ListRuntimeSemaphoreSlotsOptions {
  readonly status?: RuntimeSemaphoreSlotStatus;
  readonly resourceType?: RuntimeSemaphoreResourceType;
  readonly resourceKey?: string;
  readonly ownerId?: string;
  readonly workUnitId?: string;
  readonly limit?: number;
}

export interface RuntimeDiagnostics {
  readonly runtime: RuntimeInstance;
  readonly active: readonly WorkUnit[];
  readonly stuck: readonly WorkUnit[];
  readonly queued: readonly WorkUnit[];
  readonly stale: readonly WorkUnit[];
  readonly semaphoreSlots: readonly RuntimeSemaphoreSlot[];
}

export function createWorkUnitId(): string {
  return `work_unit_${randomUUID()}`;
}

export function createWorkUnitAttemptId(): string {
  return `work_unit_attempt_${randomUUID()}`;
}

export function createRuntimeEventId(): string {
  return `runtime_event_${randomUUID()}`;
}

export function createRuntimeHeartbeatId(): string {
  return `runtime_heartbeat_${randomUUID()}`;
}

export function createRuntimeSemaphoreSlotId(): string {
  return `semaphore_slot_${randomUUID()}`;
}
