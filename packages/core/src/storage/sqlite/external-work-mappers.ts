import type { SQLOutputValue } from "node:sqlite";
import {
  type ExternalWorkAction,
  type ExternalWorkCiTriageRecord,
  type ExternalWorkItem,
  type ExternalWorkRecord,
  type ExternalWorkSchedulerState,
} from "../../external-work-types.js";
import { type ArtifactType, type RunArtifact } from "../../run-types.js";
import {
  omitUndefined,
  parseJsonObject,
  parseJsonStringArray,
  readNullableNumber,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapArtifact(row: Record<string, SQLOutputValue>): RunArtifact {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readNullableString(row, "run_id"),
    mediaJobId: readNullableString(row, "media_job_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    type: readString(row, "type") as ArtifactType,
    path: readString(row, "path"),
    title: readNullableString(row, "title"),
    contentType: readNullableString(row, "content_type"),
    sizeBytes: readNullableNumber(row, "size_bytes"),
    createdAt: readString(row, "created_at"),
  });
}

export function mapExternalWorkRecord(row: Record<string, SQLOutputValue>): ExternalWorkRecord {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkRecord["sourceKind"],
    workItemKind: readString(row, "work_item_kind") as ExternalWorkRecord["workItemKind"],
    externalId: readString(row, "external_id"),
    identifier: readString(row, "identifier"),
    idempotencyKey: readString(row, "idempotency_key"),
    workflowId: readString(row, "workflow_id"),
    workflowStepId: readString(row, "workflow_step_id"),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    item: parseJsonObject(readString(row, "item_json")) as unknown as ExternalWorkItem,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapExternalWorkSchedulerState(row: Record<string, SQLOutputValue>): ExternalWorkSchedulerState {
  return omitUndefined({
    externalWorkId: readString(row, "external_work_id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    subjectKey: readString(row, "subject_key"),
    sourceKey: readString(row, "source_key"),
    workflowId: readString(row, "workflow_id"),
    workflowStepId: readString(row, "workflow_step_id"),
    schedulerStatus: readString(row, "scheduler_status") as ExternalWorkSchedulerState["schedulerStatus"],
    attemptCount: readNumber(row, "attempt_count"),
    lastAttemptAt: readNullableString(row, "last_attempt_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    maxRetryBackoffMs: readNumber(row, "max_retry_backoff_ms"),
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    workspacePath: readNullableString(row, "workspace_path"),
    workspaceMode: readNullableString(row, "workspace_mode") as ExternalWorkSchedulerState["workspaceMode"],
    hookArtifactIds: parseJsonStringArray(readString(row, "hook_artifact_ids_json")),
    lastReconciledAt: readNullableString(row, "last_reconciled_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapExternalWorkAction(row: Record<string, SQLOutputValue>): ExternalWorkAction {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    externalWorkId: readString(row, "external_work_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkAction["sourceKind"],
    actionKind: readString(row, "action_kind") as ExternalWorkAction["actionKind"],
    status: readString(row, "status") as ExternalWorkAction["status"],
    approvalId: readNullableString(row, "approval_id"),
    idempotencyKey: readString(row, "idempotency_key"),
    target: parseJsonObject(readString(row, "target_json")) as unknown as ExternalWorkAction["target"],
    payload: parseJsonObject(readString(row, "payload_json")) as unknown as ExternalWorkAction["payload"],
    approvalRequirement: readString(row, "approval_requirement") as ExternalWorkAction["approvalRequirement"],
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    executionAttemptCount: readNumber(row, "execution_attempt_count"),
    lastAttemptAt: readNullableString(row, "last_attempt_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    executedAt: readNullableString(row, "executed_at"),
  });
}

export function mapExternalWorkCiTriage(row: Record<string, SQLOutputValue>): ExternalWorkCiTriageRecord {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    externalWorkId: readString(row, "external_work_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkCiTriageRecord["sourceKind"],
    repository: readString(row, "repository"),
    subjectKind: readString(row, "subject_kind") as ExternalWorkCiTriageRecord["subjectKind"],
    subjectNumber: readNumber(row, "subject_number"),
    headSha: readString(row, "head_sha"),
    failureKey: readString(row, "failure_key"),
    status: readString(row, "status") as ExternalWorkCiTriageRecord["status"],
    checkName: readString(row, "check_name"),
    workflowName: readNullableString(row, "workflow_name"),
    jobName: readNullableString(row, "job_name"),
    conclusion: readString(row, "conclusion") as ExternalWorkCiTriageRecord["conclusion"],
    htmlUrl: readNullableString(row, "html_url"),
    firstFailingCommand: readNullableString(row, "first_failing_command"),
    reproductionCommand: readNullableString(row, "reproduction_command"),
    suspectedSourcePath: readNullableString(row, "suspected_source_path"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    failure: parseJsonObject(readString(row, "failure_json")) as unknown as ExternalWorkCiTriageRecord["failure"],
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}
