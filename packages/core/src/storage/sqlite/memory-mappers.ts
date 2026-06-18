import type { SQLOutputValue } from "node:sqlite";
import {
  type MemoryConsolidationJob,
  type MemoryConsolidationJobKind,
  type MemoryConsolidationJobStatus,
} from "../../memory-consolidation-types.js";
import {
  type MemoryObject,
  type MemoryReviewDecision,
  type MemoryReviewMode,
  type MemoryReviewOutcome,
  type MemoryReviewPolicy,
  type MemoryReviewState,
  type MemoryScopeType,
  type MemorySelfImprovingKind,
  type MemorySelfImprovingMetadata,
  type MemorySensitivity,
  type MemorySourceRef,
  type UsedMemoryEvent,
} from "../../memory-types.js";
import {
  isJsonRecord,
  omitUndefined,
  parseJson,
  parseJsonStringArray,
  readBoolean,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapMemoryObject(row: Record<string, SQLOutputValue>): MemoryObject {
  const id = readString(row, "id");
  return omitUndefined({
    id,
    workspaceId: readString(row, "workspace_id"),
    scopeType: readString(row, "scope_type") as MemoryScopeType,
    ownerId: readString(row, "owner_id"),
    title: readString(row, "title"),
    body: readString(row, "body"),
    tags: parseJsonStringArray(readString(row, "tags_json")),
    sourceRefs: ensureMemorySourceRefs(id, parseMemorySourceRefs(readString(row, "source_refs_json"))),
    reviewState: readString(row, "review_state") as MemoryReviewState,
    enabled: readBoolean(row, "enabled"),
    sensitivity: readString(row, "sensitivity") as MemorySensitivity,
    verifyBeforeUse: readBoolean(row, "verify_before_use"),
    retrievalProviderId: readNullableString(row, "retrieval_provider_id"),
    retrievalHandle: readNullableString(row, "retrieval_handle"),
    createdBy: readNullableString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    lastUsedAt: readNullableString(row, "last_used_at"),
  });
}

export function mapMemorySelfImprovingMetadata(row: Record<string, SQLOutputValue>): MemorySelfImprovingMetadata {
  return omitUndefined({
    memoryId: readString(row, "memory_id"),
    kind: readString(row, "kind") as MemorySelfImprovingKind,
    trigger: readString(row, "trigger") as MemorySelfImprovingMetadata["trigger"],
    lesson: readString(row, "lesson"),
    useWhen: parseJsonStringArray(readString(row, "use_when_json")),
    doNotUseWhen: parseJsonStringArray(readString(row, "do_not_use_when_json")),
    validUntil: readNullableString(row, "valid_until"),
    lastSeenAt: readNullableString(row, "last_seen_at"),
    evidenceCount: readNumber(row, "evidence_count"),
    supersededBy: readNullableString(row, "superseded_by"),
    lastUsedAt: readNullableString(row, "last_used_at"),
    useCount: readNumber(row, "use_count"),
  });
}

export function mapMemoryConsolidationJob(row: Record<string, SQLOutputValue>): MemoryConsolidationJob {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    kind: readString(row, "kind") as MemoryConsolidationJobKind,
    sourceRefs: parseMemorySourceRefs(readString(row, "source_refs_json")),
    status: readString(row, "status") as MemoryConsolidationJobStatus,
    createdCandidateIds: parseJsonStringArray(readString(row, "created_candidate_ids_json")),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapUsedMemoryEvent(row: Record<string, SQLOutputValue>): UsedMemoryEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    memoryIds: parseJsonStringArray(readString(row, "memory_ids_json")),
    intent: readString(row, "intent") as UsedMemoryEvent["intent"],
    recallQuery: readString(row, "recall_query"),
    teammateId: readNullableString(row, "teammate_id"),
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    responseId: readNullableString(row, "response_id"),
    policyVersion: readString(row, "policy_version"),
    createdAt: readString(row, "created_at"),
  });
}

export function mapMemoryReviewPolicy(row: Record<string, SQLOutputValue>): MemoryReviewPolicy {
  return {
    workspaceId: readString(row, "workspace_id"),
    mode: readString(row, "mode") as MemoryReviewMode,
    autoActiveSameScope: readBoolean(row, "auto_active_same_scope"),
    autoActiveUserExplicit: readBoolean(row, "auto_active_user_explicit"),
    requireManualForWorkspace: readBoolean(row, "require_manual_for_workspace"),
    requireManualForPersona: readBoolean(row, "require_manual_for_persona"),
    requireManualForCrossScope: readBoolean(row, "require_manual_for_cross_scope"),
    quarantineSecretAdjacent: readBoolean(row, "quarantine_secret_adjacent"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapMemoryReviewDecision(row: Record<string, SQLOutputValue>): MemoryReviewDecision {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    memoryId: readString(row, "memory_id"),
    outcome: readString(row, "outcome") as MemoryReviewOutcome,
    mode: readString(row, "mode") as MemoryReviewMode,
    reasonCode: readString(row, "reason_code"),
    reason: readString(row, "reason"),
    confidence: readString(row, "confidence") as MemoryReviewDecision["confidence"],
    requiresManualReview: readBoolean(row, "requires_manual_review"),
    quarantineReason: readNullableString(row, "quarantine_reason"),
    targetReviewState: readString(row, "target_review_state") as MemoryReviewState,
    targetSensitivity: readString(row, "target_sensitivity") as MemorySensitivity,
    sourceRefs: parseMemorySourceRefs(readString(row, "source_refs_json")),
    decidedBy: readString(row, "decided_by") as MemoryReviewDecision["decidedBy"],
    createdAt: readString(row, "created_at"),
  });
}

function parseMemorySourceRefs(value: string): MemorySourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected memory source refs array from SQLite");
  }
  return normalizeMemorySourceRefs(parsed);
}

export function normalizeMemorySourceRefs(values: readonly unknown[]): MemorySourceRef[] {
  return values.map((value, index) => {
    if (!isJsonRecord(value)) {
      throw new Error(`sourceRefs[${index}] must be an object`);
    }
    const type = value.type;
    if (!isMemorySourceType(type)) {
      throw new Error(`sourceRefs[${index}].type is not supported`);
    }
    if (typeof value.id !== "string" || value.id.trim().length === 0) {
      throw new Error(`sourceRefs[${index}].id must be a non-empty string`);
    }
    return omitUndefined({
      type,
      id: value.id.trim(),
      label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : undefined,
      url: typeof value.url === "string" && value.url.trim() ? value.url.trim() : undefined,
    });
  });
}

export function ensureMemorySourceRefs(memoryId: string, sourceRefs: readonly MemorySourceRef[]): readonly MemorySourceRef[] {
  if (sourceRefs.length > 0) {
    return sourceRefs;
  }
  return [{ type: "manual", id: memoryId, label: "Manual memory" }];
}

function isMemorySourceType(value: unknown): value is MemorySourceRef["type"] {
  return (
    value === "manual" ||
    value === "message" ||
    value === "decision" ||
    value === "doc" ||
    value === "attachment" ||
    value === "run-event" ||
    value === "artifact" ||
    value === "import"
  );
}
