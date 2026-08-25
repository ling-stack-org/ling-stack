import type { SQLOutputValue } from "node:sqlite";
import type {
  LingApprovalCheckpoint,
  LingApprovalCheckpointStatus,
  RunnerResumeHandle,
} from "../../approval-checkpoints.js";
import { isApprovalResumeBasisV1 } from "../../approval-checkpoints.js";
import type { ApprovalPayload } from "../../approval-types.js";
import {
  omitUndefined,
  parseJsonObject,
  parseJsonStringArray,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapApprovalCheckpoint(row: Record<string, SQLOutputValue>): LingApprovalCheckpoint {
  const runnerResumeHandleJson = readNullableString(row, "runner_resume_handle_json");
  const resumeBasisJson = readNullableString(row, "resume_basis_json");
  const resumeBasis = resumeBasisJson ? parseJsonObject(resumeBasisJson) : undefined;
  return omitUndefined({
    id: readString(row, "id"),
    approvalId: readString(row, "approval_id"),
    runId: readNullableString(row, "run_id"),
    taskId: readNullableString(row, "task_id"),
    mediaJobId: readNullableString(row, "media_job_id"),
    externalWorkActionId: readNullableString(row, "external_work_action_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    channelId: readNullableString(row, "channel_id"),
    toolCallId: readNullableString(row, "tool_call_id"),
    actionType: readString(row, "action_type") as LingApprovalCheckpoint["actionType"],
    risk: readString(row, "risk") as LingApprovalCheckpoint["risk"],
    title: readString(row, "title"),
    description: readString(row, "description"),
    status: readString(row, "status") as LingApprovalCheckpointStatus,
    sideEffect: parseJsonObject(readString(row, "side_effect_json")) as ApprovalPayload,
    previewArtifactIds: parseJsonStringArray(readString(row, "preview_artifact_ids_json")),
    resultArtifactIds: parseJsonStringArray(readString(row, "result_artifact_ids_json")),
    revision: Number(row.revision ?? 0),
    resumeBasis: isApprovalResumeBasisV1(resumeBasis) ? resumeBasis : undefined,
    runnerResumeHandle: runnerResumeHandleJson
      ? (parseJsonObject(runnerResumeHandleJson) as unknown as RunnerResumeHandle)
      : undefined,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    resolvedAt: readNullableString(row, "resolved_at"),
    resumedAt: readNullableString(row, "resumed_at"),
    resumeFailureReason: readNullableString(row, "resume_failure_reason"),
  });
}
