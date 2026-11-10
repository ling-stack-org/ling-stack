import type { SQLOutputValue } from "node:sqlite";
import { type ResourceLease, type ResourceLeaseStatus, type StateTransitionEvent } from "../../channel-runtime-types.js";
import {
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeSemaphoreResourceType,
  type RuntimeSemaphoreSlot,
  type RuntimeSemaphoreSlotStatus,
  defaultRuntimeTimeoutPolicy,
  type RuntimeTimeoutPolicy,
  type RunnerFallbackReason,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitAttemptStatus,
  type WorkUnitKind,
  type WorkUnitStatus,
} from "../../runtime-supervisor-types.js";
import { type StateEntityType, type StateTransitionActor } from "../../state-machines.js";
import {
  type WorkItem,
  type WorkItemClaim,
  type WorkItemSourceType,
  type WorkItemStatus,
  type WorkItemWaitingReason,
} from "../../work-item-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";
import { normalizeRunnerId, normalizeRunnerIdsInSnapshot } from "../../runner-ids.js";

export function mapWorkItem(row: Record<string, SQLOutputValue>, dependencyIds: readonly string[], now?: string): WorkItem {
  const claim = mapWorkItemClaim(row, now);
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    sourceType: readString(row, "source_type") as WorkItemSourceType,
    sourceId: readString(row, "source_id"),
    title: readString(row, "title"),
    description: readNullableString(row, "description"),
    status: readString(row, "status") as WorkItemStatus,
    waitingReason: readNullableString(row, "waiting_reason") as WorkItemWaitingReason | undefined,
    priority: readString(row, "priority") as WorkItem["priority"],
    labels: parseJsonStringArray(readString(row, "labels_json")),
    assigneeTeammateId: readNullableString(row, "assignee_teammate_id"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    workflowId: readNullableString(row, "workflow_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    externalWorkActionId: readNullableString(row, "external_work_action_id"),
    approvalId: readNullableString(row, "approval_id"),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    proofArtifactIds: parseJsonStringArray(readString(row, "proof_artifact_ids_json")),
    dependencyIds: [...dependencyIds],
    claim,
    attemptCount: readNumber(row, "attempt_count"),
    retryBudget: readNumber(row, "retry_budget"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at"),
    failedAt: readNullableString(row, "failed_at"),
    failureReason: readNullableString(row, "failure_reason"),
  });
}

export function mapStateTransitionEvent(row: Record<string, SQLOutputValue>): StateTransitionEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    entityType: readString(row, "entity_type") as StateEntityType,
    entityId: readString(row, "entity_id"),
    fromStatus: readString(row, "from_status"),
    toStatus: readString(row, "to_status"),
    event: readString(row, "event"),
    actor: readString(row, "actor") as StateTransitionActor,
    reason: readNullableString(row, "reason"),
    idempotencyKey: readNullableString(row, "idempotency_key"),
    createdAt: readString(row, "created_at"),
  });
}

export function mapWorkUnit(row: Record<string, SQLOutputValue>): WorkUnit {
  const runnerId = normalizeStoredRunnerId(readNullableString(row, "runner_id"));
  const requestedRunnerId = normalizeStoredRunnerId(readNullableString(row, "requested_runner_id"));
  const effectiveRunnerId = normalizeStoredRunnerId(readNullableString(row, "effective_runner_id") ?? runnerId);
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    kind: readString(row, "kind") as WorkUnitKind,
    ownerType: readString(row, "owner_type"),
    ownerId: readString(row, "owner_id"),
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    teammateId: readNullableString(row, "teammate_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    runnerId,
    requestedRunnerId,
    effectiveRunnerId,
    fallbackReason: parseOptionalRunnerFallbackReason(readNullableString(row, "runner_fallback_reason_json")),
    idempotencyKey: readString(row, "idempotency_key"),
    status: readString(row, "status") as WorkUnitStatus,
    priority: readNumber(row, "priority"),
    attemptCount: readNumber(row, "attempt_count"),
    activeAttemptId: readNullableString(row, "active_attempt_id"),
    createdByClientId: readNullableString(row, "created_by_client_id"),
    createdByActor: readString(row, "created_by_actor") as WorkUnit["createdByActor"],
    request: normalizeRunnerIdsInSnapshot(parseJson(readString(row, "request_json"))),
    timeoutPolicy: parseRuntimeTimeoutPolicy(readString(row, "timeout_policy_json")),
    linkedRunId: readNullableString(row, "linked_run_id"),
    linkedMessageId: readNullableString(row, "linked_message_id"),
    linkedMediaJobId: readNullableString(row, "linked_media_job_id"),
    linkedExternalWorkId: readNullableString(row, "linked_external_work_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    lastEventAt: readNullableString(row, "last_event_at"),
    lastHeartbeatAt: readNullableString(row, "last_heartbeat_at"),
    errorCode: readNullableString(row, "error_code"),
    errorMessage: readNullableString(row, "error_message"),
  });
}

export function mapWorkUnitAttempt(row: Record<string, SQLOutputValue>): WorkUnitAttempt {
  const runnerId = normalizeStoredRunnerId(readString(row, "runner_id")) ?? readString(row, "runner_id");
  const requestedRunnerId = normalizeStoredRunnerId(readNullableString(row, "requested_runner_id"));
  const effectiveRunnerId = normalizeStoredRunnerId(readNullableString(row, "effective_runner_id") ?? runnerId) ?? runnerId;
  return omitUndefined({
    id: readString(row, "id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptNumber: readNumber(row, "attempt_number"),
    fencingToken: readString(row, "fencing_token"),
    runtimeInstanceId: readString(row, "runtime_instance_id"),
    runnerId,
    requestedRunnerId,
    effectiveRunnerId,
    fallbackReason: parseOptionalRunnerFallbackReason(readNullableString(row, "runner_fallback_reason_json")),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    status: readString(row, "status") as WorkUnitAttemptStatus,
    createdAt: readString(row, "created_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    lastEventAt: readNullableString(row, "last_event_at"),
    lastHeartbeatAt: readNullableString(row, "last_heartbeat_at"),
    abortRequestedAt: readNullableString(row, "abort_requested_at"),
    errorCode: readNullableString(row, "error_code"),
    errorMessage: readNullableString(row, "error_message"),
  });
}

export function mapRuntimeEvent(row: Record<string, SQLOutputValue>): RuntimeEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptId: readNullableString(row, "attempt_id"),
    runtimeInstanceId: readNullableString(row, "runtime_instance_id"),
    fencingToken: readNullableString(row, "fencing_token"),
    seq: readNumber(row, "seq"),
    ts: readString(row, "ts"),
    type: readString(row, "type") as RuntimeEventType,
    actor: readString(row, "actor") as RuntimeEvent["actor"],
    data: normalizeRunnerIdsInSnapshot(parseJson(readString(row, "data_json"))),
  });
}

export function mapRuntimeSemaphoreSlot(row: Record<string, SQLOutputValue>): RuntimeSemaphoreSlot {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    resourceType: readString(row, "resource_type") as RuntimeSemaphoreResourceType,
    resourceKey: readString(row, "resource_key"),
    ownerType: readString(row, "owner_type") as RuntimeSemaphoreSlot["ownerType"],
    ownerId: readString(row, "owner_id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptId: readString(row, "attempt_id"),
    runtimeInstanceId: readString(row, "runtime_instance_id"),
    fencingToken: readString(row, "fencing_token"),
    status: readString(row, "status") as RuntimeSemaphoreSlotStatus,
    acquiredAt: readString(row, "acquired_at"),
    lastRenewedAt: readString(row, "last_renewed_at"),
    expiresAt: readString(row, "expires_at"),
    releasedAt: readNullableString(row, "released_at"),
    releaseReason: readNullableString(row, "release_reason"),
  });
}

export function mapResourceLease(row: Record<string, SQLOutputValue>): ResourceLease {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    resourceType: readString(row, "resource_type") as ResourceLease["resourceType"],
    resourceKey: readString(row, "resource_key"),
    ownerType: readString(row, "owner_type") as ResourceLease["ownerType"],
    ownerId: readString(row, "owner_id"),
    status: readString(row, "status") as ResourceLeaseStatus,
    acquiredAt: readString(row, "acquired_at"),
    expiresAt: readString(row, "expires_at"),
    lastRenewedAt: readNullableString(row, "last_renewed_at"),
    releasedAt: readNullableString(row, "released_at"),
    releaseReason: readNullableString(row, "release_reason"),
    workUnitId: readNullableString(row, "work_unit_id"),
    attemptId: readNullableString(row, "attempt_id"),
    runtimeInstanceId: readNullableString(row, "runtime_instance_id"),
    fencingToken: readNullableString(row, "fencing_token"),
  });
}

export function normalizeStoredRunnerId(value: string | undefined): string | undefined {
  return normalizeRunnerId(value);
}

function mapWorkItemClaim(row: Record<string, SQLOutputValue>, now?: string): WorkItemClaim | undefined {
  const ownerId = readNullableString(row, "claim_owner_id");
  const token = readNullableString(row, "claim_token");
  const claimedAt = readNullableString(row, "claimed_at");
  const heartbeatAt = readNullableString(row, "heartbeat_at");
  const expiresAt = readNullableString(row, "claim_expires_at");
  if (!ownerId || !token || !claimedAt || !heartbeatAt || !expiresAt) {
    return undefined;
  }
  if (now && expiresAt <= now) {
    return undefined;
  }
  return { ownerId, token, claimedAt, heartbeatAt, expiresAt };
}

function parseRuntimeTimeoutPolicy(value: string): RuntimeTimeoutPolicy {
  try {
    const parsed = parseJsonObject(value);
    return {
      heartbeatIntervalMs: readRuntimePolicyNumber(parsed.heartbeatIntervalMs, defaultRuntimeTimeoutPolicy.heartbeatIntervalMs),
      heartbeatTimeoutMs: readRuntimePolicyNumber(parsed.heartbeatTimeoutMs, defaultRuntimeTimeoutPolicy.heartbeatTimeoutMs),
      idleTimeoutMs: readRuntimePolicyNumber(parsed.idleTimeoutMs, defaultRuntimeTimeoutPolicy.idleTimeoutMs),
      hardTimeoutMs: readRuntimePolicyNumber(parsed.hardTimeoutMs, defaultRuntimeTimeoutPolicy.hardTimeoutMs),
      cancelGraceMs: readRuntimePolicyNumber(parsed.cancelGraceMs, defaultRuntimeTimeoutPolicy.cancelGraceMs),
    };
  } catch {
    return defaultRuntimeTimeoutPolicy;
  }
}

function readRuntimePolicyNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseOptionalRunnerFallbackReason(value: string | undefined): RunnerFallbackReason | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const code = record.code;
  const message = record.message;
  if (
    (code === "missing_requested_runner" ||
      code === "disabled_requested_runner" ||
      code === "unsupported_provider_api" ||
      code === "unsupported_tool" ||
      code === "runner_tool_conformance_failed") &&
    typeof message === "string"
  ) {
    return { code, message };
  }
  return undefined;
}
