import {
  createApprovalRequestId,
  type ApprovalRequest,
  type ApprovalStatus,
  type CreateApprovalRequestInput,
  type ListApprovalRequestsOptions,
  type ResolveApprovalRequestInput,
} from "../../approval-types.js";
import { redactSecrets } from "../../redaction.js";
import { stringifyJson } from "./helpers.js";
import { mapApprovalRequest } from "./approval-media-mappers.js";
import { approvalRequestSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteApprovalRequestStorePorts {
  readonly hasRun: (id: string) => boolean;
  readonly hasMediaJob: (id: string) => boolean;
  readonly hasExternalWorkAction: (id: string) => boolean;
  readonly hasWorkflowStep: (id: string) => boolean;
  readonly createApprovalCheckpoint: (approval: ApprovalRequest, now: string) => void;
  readonly syncApprovalCheckpointForApproval: (approval: ApprovalRequest, now: string) => void;
  readonly rebuildLingThreadMetadataForApproval: (approval: ApprovalRequest | undefined, now: string) => void;
  readonly assertWorkspaceSnapshotFence?: (cwd: string) => void;
}

export class SqliteApprovalRequestStore {
  private readonly context: SqliteStoreContext;
  private readonly ports: SqliteApprovalRequestStorePorts;

  constructor(context: SqliteStoreContext, ports: SqliteApprovalRequestStorePorts) {
    this.context = context;
    this.ports = ports;
  }

  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest {
    const runId = normalizeOptionalOwnerId(input.runId);
    const taskId = normalizeOptionalOwnerId(input.taskId);
    const mediaJobId = normalizeOptionalOwnerId(input.mediaJobId);
    const externalWorkActionId = normalizeOptionalOwnerId(input.externalWorkActionId);
    const workflowStepId = normalizeOptionalOwnerId(input.workflowStepId);
    const hasRunOwner = Boolean(runId && taskId);
    const hasMediaOwner = Boolean(mediaJobId);
    const hasExternalWorkActionOwner = Boolean(externalWorkActionId);
    const hasWorkflowStepOwner = Boolean(workflowStepId);
    if (Boolean(runId) !== Boolean(taskId)) {
      throw new Error("Run approval requests require both runId and taskId.");
    }
    if ([hasRunOwner, hasMediaOwner, hasExternalWorkActionOwner, hasWorkflowStepOwner].filter(Boolean).length !== 1) {
      throw new Error("Approval requests require exactly one owner: runId/taskId, mediaJobId, externalWorkActionId, or workflowStepId.");
    }
    if (runId && !this.ports.hasRun(runId)) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (runId) {
      const run = this.context.database.prepare("SELECT cwd FROM run_sessions WHERE id = ?").get(runId) as { cwd?: unknown } | undefined;
      if (typeof run?.cwd === "string") this.ports.assertWorkspaceSnapshotFence?.(run.cwd);
    }
    if (mediaJobId && !this.ports.hasMediaJob(mediaJobId)) {
      throw new Error(`Media job not found: ${mediaJobId}`);
    }
    if (externalWorkActionId && !this.ports.hasExternalWorkAction(externalWorkActionId)) {
      throw new Error(`External work action not found: ${externalWorkActionId}`);
    }
    if (workflowStepId && !this.ports.hasWorkflowStep(workflowStepId)) {
      throw new Error(`Workflow step not found: ${workflowStepId}`);
    }

    const approval: ApprovalRequest = {
      id: createApprovalRequestId(),
      runId,
      taskId,
      mediaJobId,
      externalWorkActionId,
      workflowStepId,
      channelId: input.channelId,
      toolCallId: input.toolCallId,
      actionType: input.actionType,
      risk: input.risk,
      title: String(redactSecrets(input.title, input.extraSecrets ?? [])),
      description: String(redactSecrets(input.description, input.extraSecrets ?? [])),
      payload: redactSecrets(input.payload, input.extraSecrets ?? []) as ApprovalRequest["payload"],
      status: "pending",
      createdAt: now,
      expiresAt: input.expiresAt,
    };

    this.context.database
      .prepare(`
        INSERT INTO approval_requests (
          id,
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
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.runId ?? null,
        approval.taskId ?? null,
        approval.mediaJobId ?? null,
        approval.externalWorkActionId ?? null,
        approval.workflowStepId ?? null,
        approval.channelId ?? null,
        approval.toolCallId ?? null,
        approval.actionType,
        approval.risk,
        approval.title,
        approval.description,
        stringifyJson(approval.payload),
        approval.status,
        approval.createdAt,
        approval.expiresAt ?? null,
        null,
        null,
        null,
      );

    const created = this.getApprovalRequest(approval.id);
    if (!created) {
      throw new Error(`Failed to create approval request: ${approval.id}`);
    }
    this.ports.createApprovalCheckpoint(created, now);
    this.ports.rebuildLingThreadMetadataForApproval(created, now);
    return created;
  }

  getApprovalRequest(id: string): ApprovalRequest | undefined {
    const row = this.context.database.prepare(approvalRequestSelectSql("WHERE id = ?")).get(id);
    return row ? mapApprovalRequest(row) : undefined;
  }

  listApprovalRequests(options: ListApprovalRequestsOptions = {}): ApprovalRequest[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
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
      .prepare(`${approvalRequestSelectSql(whereClause)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapApprovalRequest);
  }

  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "approved", input, now);
  }

  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "denied", input, now);
  }

  expireApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "expired", input, now);
  }

  cancelApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "cancelled", input, now);
  }

  private resolveApprovalRequest(
    id: string,
    status: Extract<ApprovalStatus, "approved" | "denied" | "expired" | "cancelled">,
    input: ResolveApprovalRequestInput,
    now: string,
  ): ApprovalRequest | undefined {
    const existing = this.getApprovalRequest(id);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "pending") {
      throw new Error(`Approval request is not pending: ${id}`);
    }

    this.context.database
      .prepare(`
        UPDATE approval_requests
        SET
          status = ?,
          resolved_at = ?,
          resolved_by = ?,
          decision_reason = ?
        WHERE id = ?
      `)
      .run(
        status,
        now,
        status === "expired" ? (input.resolvedBy ?? null) : (input.resolvedBy ?? "local-user"),
        input.reason ?? null,
        id,
      );

    const resolved = this.getApprovalRequest(id);
    if (resolved) {
      this.ports.syncApprovalCheckpointForApproval(resolved, now);
    }
    this.ports.rebuildLingThreadMetadataForApproval(resolved, now);
    return resolved;
  }
}

function normalizeOptionalOwnerId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
