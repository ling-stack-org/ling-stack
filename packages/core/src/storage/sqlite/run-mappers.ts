import type { SQLOutputValue } from "node:sqlite";
import { isRunEventData, isRunEventType, type LingThreadRelationKindV2, type LingThreadSurfaceKindV2 } from "@ling-stack/contracts";
import { conversationModeKinds, runContinuationReasons, type ConversationModeKind, type ConversationModeState, type GoalContinuationEvidenceDelta, type GoalContinuationStopReason, type GoalEvidenceRef, type GoalUsageSource, type LingThread, type LingThreadGoal, type LingThreadGoalCompletionActor, type LingThreadGoalStatus, type LingThreadKind, type LingThreadMetadata, type LingThreadStatus, type LingTurn, type LingTurnKind, type LingTurnRun, type LingTurnRunRole, type LingTurnStatus, type ProposedPlanArtifact, type ProposedPlanArtifactStatus, type RunContinuationReason, type RunEventEnvelope, type RunSession, type RunStatus } from "../../run-types.js";
import { omitUndefined, parseJson, readNullableNumber, readNullableString, readNumber, readString } from "./helpers.js";

export function mapLingThread(row: Record<string, SQLOutputValue>): LingThread {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    kind: readString(row, "kind") as LingThreadKind,
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    teammateId: readNullableString(row, "teammate_id"),
    workflowId: readNullableString(row, "workflow_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    title: readString(row, "title"),
    objective: readString(row, "objective"),
    status: readString(row, "status") as LingThreadStatus,
    activeRunId: readNullableString(row, "active_run_id"),
    lastRunId: readNullableString(row, "last_run_id"),
    parentThreadId: readNullableString(row, "parent_thread_id"),
    parentTurnId: readNullableString(row, "parent_turn_id"),
    forkedFromRunId: readNullableString(row, "forked_from_run_id"),
    metadata: parseOptionalLingThreadMetadata(readNullableString(row, "metadata_json")),
    conversationMode: readConversationModeState(row),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    pinnedAt: readNullableString(row, "pinned_at"),
    archivedAt: readNullableString(row, "archived_at"),
    archivedReason: readNullableString(row, "archived_reason"),
    surfaceKind: readString(row, "surface_kind") as LingThreadSurfaceKindV2,
    relationKind: readString(row, "relation_kind") as LingThreadRelationKindV2,
    anchorItemId: readNullableString(row, "anchor_item_id"),
    forkContextSnapshotId: readNullableString(row, "fork_context_snapshot_id"),
    nextItemSequence: readNumber(row, "next_item_sequence"),
  });
}

export function mapLingThreadGoal(row: Record<string, SQLOutputValue>): LingThreadGoal {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    objective: readString(row, "objective"),
    status: readString(row, "status") as LingThreadGoalStatus,
    tokenBudget: readNullableNumber(row, "token_budget"),
    tokensUsed: readNumber(row, "tokens_used"),
    timeUsedSeconds: readNumber(row, "time_used_seconds"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at"),
    clearedAt: readNullableString(row, "cleared_at"),
    replacedByGoalId: readNullableString(row, "replaced_by_goal_id"),
    lastRunId: readNullableString(row, "last_run_id"),
    blockedReason: readNullableString(row, "blocked_reason"),
    completionEvidenceRefs: parseGoalEvidenceRefs(readString(row, "completion_evidence_refs_json")),
    completedBy: readNullableString(row, "completed_by") as LingThreadGoalCompletionActor | undefined,
    completedReason: readNullableString(row, "completed_reason"),
    completionVerificationSummary: readNullableString(row, "completion_verification_summary"),
    usageSource: readNullableString(row, "usage_source") as GoalUsageSource | undefined,
    continuationChainId: readNullableString(row, "continuation_chain_id"),
    continuationDepth: readNumber(row, "continuation_depth"),
    noEvidenceContinuationCount: readNumber(row, "no_evidence_continuation_count"),
    lastBlockerFingerprint: readNullableString(row, "last_blocker_fingerprint"),
    sameBlockerCount: readNumber(row, "same_blocker_count"),
    lastContinuationStopReason: readNullableString(row, "last_continuation_stop_reason") as GoalContinuationStopReason | undefined,
    lastContinuationStoppedAt: readNullableString(row, "last_continuation_stopped_at"),
    lastContinuationEvidenceDelta: parseGoalContinuationEvidenceDelta(readNullableString(row, "last_continuation_evidence_delta_json")),
  });
}

export function mapProposedPlanArtifact(row: Record<string, SQLOutputValue>): ProposedPlanArtifact {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    channelId: readNullableString(row, "channel_id"),
    goalId: readNullableString(row, "goal_id"),
    sourceAgentId: readNullableString(row, "source_agent_id"),
    ownerAgentId: readNullableString(row, "owner_agent_id"),
    sourceTurnId: readNullableString(row, "source_turn_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    parentPlanId: readNullableString(row, "parent_plan_id"),
    supersededByPlanId: readNullableString(row, "superseded_by_plan_id"),
    planGroupId: readNullableString(row, "plan_group_id"),
    version: readNullableNumber(row, "version"),
    title: readString(row, "title"),
    bodyMarkdown: readString(row, "body_markdown"),
    status: readString(row, "status") as ProposedPlanArtifactStatus,
    savedAt: readNullableString(row, "saved_at"),
    acceptedAt: readNullableString(row, "accepted_at"),
    convertedAt: readNullableString(row, "converted_at"),
    archivedAt: readNullableString(row, "archived_at"),
    archivedReason: readNullableString(row, "archived_reason"),
    acceptedTaskId: readNullableString(row, "accepted_task_id"),
    acceptedWorkflowId: readNullableString(row, "accepted_workflow_id"),
    acceptedWorkflowStepId: readNullableString(row, "accepted_workflow_step_id"),
    acceptedRunId: readNullableString(row, "accepted_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function readConversationModeState(row: Record<string, SQLOutputValue>): ConversationModeState {
  return omitUndefined({
    mode: normalizeConversationMode(readNullableString(row, "conversation_mode")),
    updatedAt: readNullableString(row, "conversation_mode_updated_at"),
  });
}

function normalizeConversationMode(value: string | undefined): ConversationModeKind {
  return conversationModeKinds.includes(value as ConversationModeKind) ? value as ConversationModeKind : "default";
}

function parseGoalEvidenceRefs(value: string): readonly GoalEvidenceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is GoalEvidenceRef => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }
    const record = item as Record<string, unknown>;
    return typeof record.kind === "string" && typeof record.id === "string";
  });
}

function parseGoalContinuationEvidenceDelta(value: string | undefined): GoalContinuationEvidenceDelta | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const newEvidenceRefs = readDeltaNumber(record, "newEvidenceRefs");
  const changedFiles = readDeltaNumber(record, "changedFiles");
  const acceptedPlans = readDeltaNumber(record, "acceptedPlans");
  const artifacts = readDeltaNumber(record, "artifacts");
  const statusChanged = record.statusChanged;
  if (
    newEvidenceRefs === undefined ||
    changedFiles === undefined ||
    acceptedPlans === undefined ||
    artifacts === undefined ||
    typeof statusChanged !== "boolean"
  ) {
    return undefined;
  }
  return {
    newEvidenceRefs,
    changedFiles,
    acceptedPlans,
    artifacts,
    statusChanged,
  };
}

function readDeltaNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function mapLingTurn(row: Record<string, SQLOutputValue>): LingTurn {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    kind: readString(row, "kind") as LingTurnKind,
    status: readString(row, "status") as LingTurnStatus,
    title: readString(row, "title"),
    userInstruction: readString(row, "user_instruction"),
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    teammateId: readNullableString(row, "teammate_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    automationId: readNullableString(row, "automation_id"),
    sourceItemId: readNullableString(row, "source_item_id"),
    sourceTurnId: readNullableString(row, "source_turn_id"),
    interventionId: readNullableString(row, "intervention_id"),
    activeRunId: readNullableString(row, "active_run_id"),
    lastRunId: readNullableString(row, "last_run_id"),
    createdByActor: readString(row, "created_by_actor") as LingTurn["createdByActor"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at"),
  });
}

export function mapLingTurnRun(row: Record<string, SQLOutputValue>): LingTurnRun {
  return {
    turnId: readString(row, "turn_id"),
    runId: readString(row, "run_id"),
    attemptNumber: readNumber(row, "attempt_number"),
    role: readString(row, "role") as LingTurnRunRole,
    createdAt: readString(row, "created_at"),
  };
}

export function mapRunSession(row: Record<string, SQLOutputValue>): RunSession {
  return omitUndefined({
    id: readString(row, "id"),
    status: readString(row, "status") as RunStatus,
    cwd: readString(row, "cwd"),
    taskId: readString(row, "task_id"),
    channelId: readNullableString(row, "channel_id"),
    teammateId: readNullableString(row, "teammate_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    selectedSkillId: readNullableString(row, "selected_skill_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    providerName: readString(row, "provider_name"),
    providerModel: readString(row, "provider_model"),
    taskSnapshot: parseJson(readString(row, "task_snapshot_json")),
    providerSnapshot: parseJson(readString(row, "provider_snapshot_json")),
    requestSnapshot: parseJson(readString(row, "request_snapshot_json")),
    eventLogPath: readString(row, "event_log_path"),
    threadId: readNullableString(row, "thread_id"),
    workUnitId: readNullableString(row, "work_unit_id"),
    parentRunId: readNullableString(row, "parent_run_id"),
    interventionId: readNullableString(row, "intervention_id"),
    continuationReason: readNullableRunContinuationReason(row, "continuation_reason"),
    contextViewId: readNullableString(row, "context_view_id"),
    contextViewCreatedAt: readNullableString(row, "context_view_created_at"),
    summaryPath: readNullableString(row, "summary_path"),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapRunEvent(row: Record<string, SQLOutputValue>): RunEventEnvelope {
  const type = readString(row, "type");
  if (!isRunEventType(type)) {
    throw new Error(`Unknown run event type from SQLite: ${type}`);
  }
  const data = parseJson(readString(row, "data_json"));
  if (!isRunEventData(type, data)) {
    throw new Error(`Invalid run event payload from SQLite: ${type}`);
  }
  return {
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    seq: readNumber(row, "seq"),
    ts: readString(row, "ts"),
    type,
    // SQLite stores the envelope payload as JSON. The boundary check above
    // rejects malformed rows; the discriminated union is preserved for all
    // typed consumers after the dynamic type column has been read.
    data,
  } as RunEventEnvelope;
}

function parseOptionalLingThreadMetadata(value: string | undefined): LingThreadMetadata | undefined {
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
  if (record.schemaVersion !== 1 || typeof record.rebuiltAt !== "string") {
    return undefined;
  }
  const pendingApprovalCount = readRequiredNonNegativeIntegerValue(record.pendingApprovalCount);
  const blockedCount = readRequiredNonNegativeIntegerValue(record.blockedCount);
  const failedAttemptCount = readRequiredNonNegativeIntegerValue(record.failedAttemptCount);
  const artifactCount = readRequiredNonNegativeIntegerValue(record.artifactCount);
  if (
    pendingApprovalCount === undefined ||
    blockedCount === undefined ||
    failedAttemptCount === undefined ||
    artifactCount === undefined
  ) {
    return undefined;
  }
  return omitUndefined({
    schemaVersion: 1 as const,
    summary: readOptionalStringValue(record.summary),
    pinnedAt: readOptionalStringValue(record.pinnedAt),
    lastTurnId: readOptionalStringValue(record.lastTurnId),
    lastActivityAt: readOptionalStringValue(record.lastActivityAt),
    pendingApprovalCount,
    blockedCount,
    failedAttemptCount,
    artifactCount,
    latestFailureRunId: readOptionalStringValue(record.latestFailureRunId),
    latestEvidenceArtifactId: readOptionalStringValue(record.latestEvidenceArtifactId),
    rebuiltAt: record.rebuiltAt,
  });
}

function readNullableRunContinuationReason(row: Record<string, SQLOutputValue>, key: string): RunContinuationReason | undefined {
  const value = readNullableString(row, key);
  return value && runContinuationReasons.includes(value as RunContinuationReason)
    ? value as RunContinuationReason
    : undefined;
}

export function runActivityAt(run: RunSession): string {
  return run.updatedAt || run.endedAt || run.startedAt || run.createdAt;
}

export function runStatusToLingTurnStatus(status: RunStatus): LingTurnStatus {
  if (status === "queued" || status === "running") {
    return "running";
  }
  return status;
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readRequiredNonNegativeIntegerValue(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}
