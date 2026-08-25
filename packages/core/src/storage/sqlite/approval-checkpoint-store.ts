import {
  createApprovalCheckpointId,
  isApprovalResumeBasisV1,
  type CreateApprovalCheckpointInput,
  type LingApprovalCheckpoint,
  type ListApprovalCheckpointsOptions,
  type UpdateApprovalCheckpointStatusInput,
} from "../../approval-checkpoints.js";
import type { ApprovalRequest } from "../../approval-types.js";
import { stringifyJson } from "./helpers.js";
import { mapApprovalCheckpoint } from "./approval-checkpoint-mappers.js";
import { approvalCheckpointSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteApprovalCheckpointStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  createApprovalCheckpoint(input: CreateApprovalCheckpointInput, now: string): LingApprovalCheckpoint {
    const existing = this.getApprovalCheckpointForApproval(input.approval.id);
    if (existing) {
      return existing;
    }

    const checkpoint: LingApprovalCheckpoint = {
      id: createApprovalCheckpointId(),
      approvalId: input.approval.id,
      runId: input.approval.runId,
      taskId: input.approval.taskId,
      mediaJobId: input.approval.mediaJobId,
      externalWorkActionId: input.approval.externalWorkActionId,
      workflowStepId: input.approval.workflowStepId,
      channelId: input.approval.channelId,
      toolCallId: input.approval.toolCallId,
      actionType: input.approval.actionType,
      risk: input.approval.risk,
      title: input.approval.title,
      description: input.approval.description,
      status: input.status ?? input.approval.status,
      sideEffect: input.approval.payload,
      previewArtifactIds: input.previewArtifactIds ?? [],
      resultArtifactIds: input.resultArtifactIds ?? [],
      revision: 0,
      resumeBasis: input.resumeBasis,
      runnerResumeHandle: input.runnerResumeHandle,
      createdAt: input.approval.createdAt,
      updatedAt: now,
      resolvedAt: input.approval.resolvedAt,
    };

    this.context.database
      .prepare(`
        INSERT INTO approval_checkpoints (
          id,
          approval_id,
          run_id,
          task_id,
          media_job_id,
          external_work_action_id,
          workflow_step_id,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          status,
          side_effect_json,
          preview_artifact_ids_json,
          result_artifact_ids_json,
          revision,
          resume_basis_json,
          runner_resume_handle_json,
          created_at,
          updated_at,
          resolved_at,
          resumed_at,
          resume_failure_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        checkpoint.id,
        checkpoint.approvalId,
        checkpoint.runId ?? null,
        checkpoint.taskId ?? null,
        checkpoint.mediaJobId ?? null,
        checkpoint.externalWorkActionId ?? null,
        checkpoint.workflowStepId ?? null,
        checkpoint.channelId ?? null,
        checkpoint.toolCallId ?? null,
        checkpoint.actionType,
        checkpoint.risk,
        checkpoint.title,
        checkpoint.description,
        checkpoint.status,
        stringifyJson(checkpoint.sideEffect),
        stringifyJson(checkpoint.previewArtifactIds),
        stringifyJson(checkpoint.resultArtifactIds),
        checkpoint.revision,
        checkpoint.resumeBasis ? stringifyJson(checkpoint.resumeBasis) : null,
        checkpoint.runnerResumeHandle ? stringifyJson(checkpoint.runnerResumeHandle) : null,
        checkpoint.createdAt,
        checkpoint.updatedAt,
        checkpoint.resolvedAt ?? null,
        null,
        null,
      );

    const created = this.getApprovalCheckpoint(checkpoint.id);
    if (!created) {
      throw new Error(`Failed to create approval checkpoint: ${checkpoint.id}`);
    }
    return created;
  }

  getApprovalCheckpoint(id: string): LingApprovalCheckpoint | undefined {
    const row = this.context.database.prepare(approvalCheckpointSelectSql("WHERE id = ?")).get(id);
    return row ? mapApprovalCheckpoint(row) : undefined;
  }

  getApprovalCheckpointForApproval(approvalId: string): LingApprovalCheckpoint | undefined {
    const row = this.context.database.prepare(approvalCheckpointSelectSql("WHERE approval_id = ?")).get(approvalId);
    return row ? mapApprovalCheckpoint(row) : undefined;
  }

  listApprovalCheckpoints(options: ListApprovalCheckpointsOptions = {}): LingApprovalCheckpoint[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.approvalId) {
      clauses.push("approval_id = ?");
      params.push(options.approvalId);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.mediaJobId) {
      clauses.push("media_job_id = ?");
      params.push(options.mediaJobId);
    }
    if (options.externalWorkActionId) {
      clauses.push("external_work_action_id = ?");
      params.push(options.externalWorkActionId);
    }
    if (options.workflowStepId) {
      clauses.push("workflow_step_id = ?");
      params.push(options.workflowStepId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${approvalCheckpointSelectSql(whereClause)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapApprovalCheckpoint);
  }

  updateApprovalCheckpointStatus(id: string, input: UpdateApprovalCheckpointStatusInput, now: string): LingApprovalCheckpoint | undefined {
    const existing = this.getApprovalCheckpoint(id);
    if (!existing) {
      return undefined;
    }
    if (input.expectedStatus !== undefined && existing.status !== input.expectedStatus) return undefined;
    if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) return undefined;
    if (input.resumeBasis && !isApprovalResumeBasisV1(input.resumeBasis)) {
      throw new Error(`Approval resume basis is invalid: ${id}`);
    }
    if (existing.resumeBasis && input.resumeBasis && existing.resumeBasis.fingerprint !== input.resumeBasis.fingerprint) {
      throw new Error(`Approval resume basis is immutable: ${id}`);
    }
    const resumeBasis = input.resumeBasis ?? existing.resumeBasis;

    this.context.database
      .prepare(`
        UPDATE approval_checkpoints
        SET
          status = ?,
          preview_artifact_ids_json = ?,
          result_artifact_ids_json = ?,
          revision = revision + 1,
          resume_basis_json = ?,
          runner_resume_handle_json = ?,
          updated_at = ?,
          resolved_at = ?,
          resumed_at = ?,
          resume_failure_reason = ?
        WHERE id = ? AND status = ? AND revision = ?
      `)
      .run(
        input.status,
        stringifyJson(input.previewArtifactIds ?? existing.previewArtifactIds),
        stringifyJson(input.resultArtifactIds ?? existing.resultArtifactIds),
        resumeBasis ? stringifyJson(resumeBasis) : null,
        input.runnerResumeHandle === undefined
          ? (existing.runnerResumeHandle ? stringifyJson(existing.runnerResumeHandle) : null)
          : (input.runnerResumeHandle ? stringifyJson(input.runnerResumeHandle) : null),
        now,
        input.resolvedAt ?? existing.resolvedAt ?? null,
        input.resumedAt ?? existing.resumedAt ?? null,
        input.resumeFailureReason === undefined
          ? (existing.resumeFailureReason ?? null)
          : (input.resumeFailureReason ?? null),
        id,
        existing.status,
        existing.revision,
      );
    const updated = this.getApprovalCheckpoint(id);
    return updated?.revision === existing.revision + 1 ? updated : undefined;
  }

  syncApprovalCheckpointForApproval(approval: ApprovalRequest, now: string): LingApprovalCheckpoint {
    const checkpoint = this.getApprovalCheckpointForApproval(approval.id) ??
      this.createApprovalCheckpoint({ approval }, now);
    return this.updateApprovalCheckpointStatus(
      checkpoint.id,
      {
        status: approval.status,
        resolvedAt: approval.resolvedAt,
      },
      now,
    ) ?? checkpoint;
  }
}
