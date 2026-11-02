import { isAbsolute, resolve } from "node:path";
import {
  createApprovalCommandRuleId,
  createApprovalRequestId,
  isSystemReviewerApprovalDecision,
  type ApprovalCommandRule,
  type ApprovalRequest,
  type ApprovalStatus,
  type CreateApprovalRequestInput,
  type ListApprovalRequestsOptions,
  type ResolveApprovalBySystemReviewerInput,
  type ResolveApprovalBySystemReviewerResult,
  type ResolveApprovalRequestInput,
} from "../../approval-types.js";
import { approvalSideEffectFingerprintV1 } from "../../approval-checkpoints.js";
import { redactSecrets } from "../../redaction.js";
import { ApprovalDecisionUnavailableError, assertApprovalDecisionAvailable } from "../../approval-decisions.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { mapApprovalCommandRule, mapApprovalRequest } from "./approval-media-mappers.js";
import { approvalCommandRuleSelectSql, approvalRequestSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { runExecutionOwnerParameters, runExecutionOwnerSql } from "./run-execution-admission.js";
import { SqliteApprovalPostCommitStore } from "./approval-postcommit-store.js";

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

  /** Keep the approval and its checkpoint atomic; never let a read-side check authorize the insert. */
  createExecutionApprovalRequest(input: CreateApprovalRequestInput & { readonly runId: string }, sourceFence: RuntimeAttemptFenceV1, now: string): ApprovalRequest {
    if (!input.runId || !sourceFence) throw new Error("Execution approval requires a captured Run/Attempt identity.");
    this.context.database.exec("SAVEPOINT execution_approval_creation");
    try {
      const approval = this.createApprovalRequest(input, now, sourceFence);
      this.context.database.exec("RELEASE execution_approval_creation");
      return approval;
    } catch (error) {
      this.context.database.exec("ROLLBACK TO execution_approval_creation");
      this.context.database.exec("RELEASE execution_approval_creation");
      throw error;
    }
  }

  createApprovalRequest(input: CreateApprovalRequestInput, now: string, sourceFence?: RuntimeAttemptFenceV1): ApprovalRequest {
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
      availableDecisions: input.availableDecisions ?? ["approve_once", "deny"],
      proposedCommandRule: input.proposedCommandRule,
    };

    this.context.database.exec("SAVEPOINT approval_request_creation");
    try {
      const inserted = this.context.database
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
            decision_reason,
            available_decisions_json,
            proposed_command_rule_json,
            decision_kind,
            decision_rule_id
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          ${sourceFence ? `WHERE ${runExecutionOwnerSql} AND EXISTS (
            SELECT 1 FROM run_sessions WHERE id = ? AND task_id = ? AND channel_id IS ?
          )` : ""}
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
          stringifyJson(approval.availableDecisions),
          approval.proposedCommandRule ? stringifyJson(approval.proposedCommandRule) : null,
          null,
          null,
          ...(sourceFence ? [...runExecutionOwnerParameters(runId!, sourceFence, false), runId!, taskId!, approval.channelId ?? null] : []),
        );
      if (Number(inserted.changes) !== 1) {
        throw Object.assign(new Error("Execution approval source is no longer current."), { code: "stale_run_execution" });
      }

      const created = this.getApprovalRequest(approval.id);
      if (!created) {
        throw new Error(`Failed to create approval request: ${approval.id}`);
      }
      this.ports.createApprovalCheckpoint(created, now);
      this.ports.rebuildLingThreadMetadataForApproval(created, now);
      this.context.database.exec("RELEASE approval_request_creation");
      return created;
    } catch (error) {
      this.context.database.exec("ROLLBACK TO approval_request_creation");
      this.context.database.exec("RELEASE approval_request_creation");
      throw error;
    }
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
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    if (options.complete) {
      if (!options.runId && !options.mediaJobId && !options.externalWorkActionId && !options.workflowStepId) {
        throw new Error("Complete approval history requires a durable owner scope.");
      }
      return this.context.database
        .prepare(`${approvalRequestSelectSql(whereClause)} ORDER BY created_at DESC`)
        .all(...params)
        .map(mapApprovalRequest);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${approvalRequestSelectSql(whereClause)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapApprovalRequest);
  }

  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    if (input.executionCleanup) {
      throw new Error("Execution cleanup can only deny or cancel an approval.");
    }
    if (input.decisionKind === "approve_command_rule") {
      return this.approveApprovalRequestWithCommandRule(id, input, now);
    }
    return this.resolveApprovalRequest(id, "approved", input, now);
  }

  resolveApprovalBySystemReviewer(
    input: ResolveApprovalBySystemReviewerInput,
    now: string,
  ): ResolveApprovalBySystemReviewerResult {
    if (!isSystemReviewerApprovalDecision(input.decision)) {
      return { ok: false, code: "approval_invalid_decision" };
    }
    const existing = this.getApprovalRequest(input.approvalId);
    if (!existing) return { ok: false, code: "approval_not_found" };
    if (existing.status !== "pending") return { ok: false, code: "approval_not_pending" };
    if (
      existing.createdAt !== input.approvalCreatedAt
      || existing.runId !== input.runId
      || existing.toolCallId !== input.toolCallId
    ) {
      return { ok: false, code: "approval_identity_changed" };
    }
    const actualFingerprint = approvalSideEffectFingerprintV1({
      actionType: existing.actionType,
      toolCallId: existing.toolCallId,
      sideEffect: existing.payload,
    });
    if (actualFingerprint !== input.sideEffectFingerprint) {
      return { ok: false, code: "approval_effect_changed" };
    }

    this.context.database.exec("SAVEPOINT system_reviewer_approval_resolution");
    try {
      const status = input.decision === "approve" ? "approved" : "denied";
      const decisionKind = input.decision === "approve" ? "approve_once" : "deny";
      const update = this.context.database.prepare(`
        UPDATE approval_requests
        SET
          status = ?,
          resolved_at = ?,
          resolved_by = 'system-reviewer',
          decision_reason = ?,
          decision_kind = ?,
          decision_rule_id = NULL
        WHERE id = ?
          AND status = 'pending'
          AND created_at = ?
          AND run_id = ?
          AND tool_call_id = ?
          AND EXISTS (
            SELECT 1 FROM approval_policies
            WHERE workspace_id = ? AND updated_at = ?
          )
          AND (
            ${runExecutionOwnerSql}
            OR (? = 1 AND ${recoverableApprovalReviewOwnerSql})
          )
      `).run(
        status,
        now,
        input.reason,
        decisionKind,
        input.approvalId,
        input.approvalCreatedAt,
        input.runId,
        input.toolCallId,
        DEFAULT_WORKSPACE_ID,
        input.workspacePolicyUpdatedAt,
        ...runExecutionOwnerParameters(input.runId, input.sourceFence, false),
        input.sourceAuthority === "recoverable_suspension" ? 1 : 0,
        input.approvalId,
        input.runId,
        input.sourceFence.workUnitId,
        input.sourceFence.attemptId,
        input.sourceFence.runtimeInstanceId,
        input.sourceFence.fencingToken,
      );
      if (Number(update.changes) !== 1) {
        const latest = this.getApprovalRequest(input.approvalId);
        const policyUpdatedAt = this.context.database
          .prepare("SELECT updated_at FROM approval_policies WHERE workspace_id = ?")
          .get(DEFAULT_WORKSPACE_ID) as { updated_at?: unknown } | undefined;
        const code: Extract<ResolveApprovalBySystemReviewerResult, { readonly ok: false }>["code"] =
          !latest ? "approval_not_found"
            : latest.status !== "pending" ? "approval_not_pending"
              : latest.createdAt !== input.approvalCreatedAt || latest.runId !== input.runId || latest.toolCallId !== input.toolCallId
                ? "approval_identity_changed"
                : policyUpdatedAt?.updated_at !== input.workspacePolicyUpdatedAt
                  ? "approval_policy_changed"
                  : "approval_execution_stale";
        this.context.database.exec("ROLLBACK TO system_reviewer_approval_resolution");
        this.context.database.exec("RELEASE system_reviewer_approval_resolution");
        return { ok: false, code };
      }
      const resolved = this.getApprovalRequest(input.approvalId);
      if (!resolved) throw new Error(`System reviewer resolution disappeared: ${input.approvalId}`);
      this.syncResolvedApproval(resolved, now);
      this.context.database.exec("RELEASE system_reviewer_approval_resolution");
      return { ok: true, approval: resolved };
    } catch (error) {
      this.context.database.exec("ROLLBACK TO system_reviewer_approval_resolution");
      this.context.database.exec("RELEASE system_reviewer_approval_resolution");
      throw error;
    }
  }

  isRecoverableApprovalReviewOwner(approvalId: string, sourceFence: RuntimeAttemptFenceV1): boolean {
    const approval = this.getApprovalRequest(approvalId);
    if (!approval?.runId) return false;
    return Boolean(this.context.database.prepare(`SELECT 1 WHERE ${recoverableApprovalReviewOwnerSql}`).get(
      approvalId,
      approval.runId,
      sourceFence.workUnitId,
      sourceFence.attemptId,
      sourceFence.runtimeInstanceId,
      sourceFence.fencingToken,
    ));
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

  listApprovalCommandRules(options: { readonly includeRevoked?: boolean } = {}): ApprovalCommandRule[] {
    const whereClause = options.includeRevoked
      ? "WHERE workspace_id = ? AND tool_name = 'bash'"
      : "WHERE workspace_id = ? AND tool_name = 'bash' AND revoked_at IS NULL";
    return this.context.database
      .prepare(`${approvalCommandRuleSelectSql(whereClause)} ORDER BY created_at DESC`)
      .all(DEFAULT_WORKSPACE_ID)
      .map(mapApprovalCommandRule)
      .map(rule => {
        const approval = rule.sourceApprovalId ? this.getApprovalRequest(rule.sourceApprovalId) : undefined;
        return approval?.payload.type === "bash" && isAbsolute(approval.payload.cwd)
          ? { ...rule, cwd: resolve(approval.payload.cwd) } : rule;
      });
  }

  findMatchingApprovalCommandRule(toolName: "bash", argv: readonly string[], cwd?: string): ApprovalCommandRule | undefined {
    if (argv.length === 0 || cwd === undefined || !isAbsolute(cwd)) return undefined;
    return this.listApprovalCommandRules()
      .filter((rule) => rule.toolName === toolName && rule.cwd === resolve(cwd) && rule.prefix.length <= argv.length)
      .sort((left, right) => right.prefix.length - left.prefix.length)
      .find((rule) => rule.prefix.every((token, index) => token === argv[index]));
  }

  revokeApprovalCommandRule(id: string, now: string): ApprovalCommandRule | undefined {
    const result = this.context.database
      .prepare(`
        UPDATE approval_command_rules
        SET revoked_at = ?
        WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL
      `)
      .run(now, id, DEFAULT_WORKSPACE_ID);
    if (result.changes === 0) return undefined;
    const row = this.context.database.prepare(approvalCommandRuleSelectSql("WHERE id = ?")).get(id);
    return row ? mapApprovalCommandRule(row) : undefined;
  }

  private approveApprovalRequestWithCommandRule(
    id: string,
    input: ResolveApprovalRequestInput,
    now: string,
  ): ApprovalRequest | undefined {
    this.context.database.exec("SAVEPOINT approval_command_rule_resolution");
    try {
      const existing = this.getApprovalRequest(id);
      if (!existing) {
        this.context.database.exec("RELEASE approval_command_rule_resolution");
        return undefined;
      }
      if (existing.status !== "pending") {
        throw new Error(`Approval request is not pending: ${id}`);
      }
      assertApprovalDecisionAvailable(existing, "approve_command_rule");
      const proposal = existing.proposedCommandRule;
      if (
        existing.actionType !== "bash" ||
        !proposal ||
        (proposal.cwd !== undefined && (existing.payload.type !== "bash" || proposal.cwd !== resolve(existing.payload.cwd))) ||
        !existing.availableDecisions?.includes("approve_command_rule") ||
        input.proposedRuleFingerprint !== proposal.fingerprint
      ) {
        throw new Error(`Approval command rule proposal is unavailable or stale: ${id}`);
      }

      const candidateRuleId = createApprovalCommandRuleId();
      this.context.database.prepare(`
        INSERT INTO approval_command_rules (
          id,
          workspace_id,
          tool_name,
          rule_version,
          prefix_tokens_json,
          display,
          fingerprint,
          source_approval_id,
          created_by,
          created_at,
          revoked_at
        ) VALUES (?, ?, 'bash', ?, ?, ?, ?, ?, 'local-user', ?, NULL)
        ON CONFLICT(workspace_id, tool_name, fingerprint) DO UPDATE SET
          rule_version = excluded.rule_version,
          prefix_tokens_json = excluded.prefix_tokens_json,
          display = excluded.display,
          source_approval_id = excluded.source_approval_id,
          created_by = excluded.created_by,
          created_at = excluded.created_at,
          revoked_at = NULL
      `).run(
        candidateRuleId,
        DEFAULT_WORKSPACE_ID,
        proposal.version,
        stringifyJson(proposal.prefix),
        proposal.display,
        proposal.fingerprint,
        existing.id,
        now,
      );
      const ruleRow = this.context.database
        .prepare(approvalCommandRuleSelectSql("WHERE workspace_id = ? AND tool_name = 'bash' AND fingerprint = ?"))
        .get(DEFAULT_WORKSPACE_ID, proposal.fingerprint);
      if (!ruleRow) {
        throw new Error(`Approval command rule was not persisted: ${id}`);
      }
      const rule = mapApprovalCommandRule(ruleRow);
      const update = this.context.database.prepare(`
        UPDATE approval_requests
        SET
          status = 'approved',
          resolved_at = ?,
          resolved_by = ?,
          decision_reason = ?,
          decision_kind = 'approve_command_rule',
          decision_rule_id = ?
        WHERE id = ? AND status = 'pending'
          AND ${activeRunApprovalOwnerSql}
      `).run(now, input.resolvedBy ?? "local-user", input.reason ?? null, rule.id, id);
      if (update.changes !== 1) {
        throw new Error(`Approval execution no longer active: ${id}`);
      }
      const resolved = this.getApprovalRequest(id);
      if (!resolved) {
        throw new Error(`Approval request was not persisted after command rule resolution: ${id}`);
      }
      this.syncResolvedApproval(resolved, now);
      this.context.database.exec("RELEASE approval_command_rule_resolution");
      return resolved;
    } catch (error) {
      this.context.database.exec("ROLLBACK TO approval_command_rule_resolution");
      this.context.database.exec("RELEASE approval_command_rule_resolution");
      throw error;
    }
  }

  private resolveApprovalRequest(
    id: string,
    status: Extract<ApprovalStatus, "approved" | "denied" | "expired" | "cancelled">,
    input: ResolveApprovalRequestInput,
    now: string,
  ): ApprovalRequest | undefined {
    if (input.executionCleanup && status !== "denied" && status !== "cancelled") {
      throw new Error("Execution cleanup can only deny or cancel an approval.");
    }
    const existing = this.getApprovalRequest(id);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "pending") {
      throw new Error(`Approval request is not pending: ${id}`);
    }

    const decisionKind = status === "approved"
      ? (input.decisionKind ?? "approve_once")
      : status === "denied" ? "deny" : undefined;
    if (status === "approved") {
      assertApprovalDecisionAvailable(existing, decisionKind);
      if (decisionKind === "approve_permission_scope" && (!existing.expiresAt
        || !Number.isFinite(Date.parse(existing.expiresAt)) || !Number.isFinite(Date.parse(now))
        || Date.parse(existing.expiresAt) <= Date.parse(now))) throw new ApprovalDecisionUnavailableError();
    }

    this.context.database.exec("SAVEPOINT approval_request_resolution");
    try {
      const update = this.context.database
        .prepare(`
          UPDATE approval_requests
          SET
            status = ?,
            resolved_at = ?,
            resolved_by = ?,
            decision_reason = ?,
            decision_kind = ?,
            decision_rule_id = NULL
          WHERE id = ? AND status = 'pending'
            ${status === "approved" ? `AND ${activeRunApprovalOwnerSql}` : ""}
            ${input.executionCleanup ? `AND run_id = ? AND created_at = ? AND tool_call_id = ?
              AND ${runExecutionOwnerSql}` : ""}
        `)
        .run(
          status,
          now,
          status === "expired" || status === "cancelled" ? (input.resolvedBy ?? null) : (input.resolvedBy ?? "local-user"),
          input.reason ?? null,
          decisionKind ?? null,
          id,
          ...(input.executionCleanup ? [input.executionCleanup.runId, input.executionCleanup.approvalCreatedAt,
            input.executionCleanup.toolCallId,
            ...runExecutionOwnerParameters(input.executionCleanup.runId, input.executionCleanup.sourceFence, false)] : []),
        );
      if (update.changes !== 1) {
        throw new Error(`Approval execution no longer active: ${id}`);
      }

      const resolved = this.getApprovalRequest(id);
      if (resolved) this.syncResolvedApproval(resolved, now);
      this.context.database.exec("RELEASE approval_request_resolution");
      return resolved;
    } catch (error) {
      this.context.database.exec("ROLLBACK TO approval_request_resolution");
      this.context.database.exec("RELEASE approval_request_resolution");
      throw error;
    }
  }

  private syncResolvedApproval(resolved: ApprovalRequest, now: string): void {
    this.ports.syncApprovalCheckpointForApproval(resolved, now);
    this.ports.rebuildLingThreadMetadataForApproval(resolved, now);
    new SqliteApprovalPostCommitStore(this.context.database).recordDecision(resolved, now);
  }
}

/** Human approval cannot revive a terminal Run; the UPDATE itself owns this race check. */
const activeRunApprovalOwnerSql = `(run_id IS NULL OR EXISTS (
  SELECT 1 FROM run_sessions AS approval_run
  WHERE approval_run.id = approval_requests.run_id
    AND approval_run.status IN ('queued', 'running', 'waiting_for_approval')
    AND approval_run.ended_at IS NULL
))`;

const recoverableApprovalReviewOwnerSql = `EXISTS (
  SELECT 1
  FROM approval_requests AS recovery_approval
  JOIN run_sessions AS recovery_run ON recovery_run.id = recovery_approval.run_id
  JOIN work_units AS recovery_unit ON recovery_unit.id = recovery_run.work_unit_id
  JOIN work_unit_attempts AS recovery_attempt ON recovery_attempt.id = recovery_unit.active_attempt_id
  JOIN approval_checkpoints AS recovery_checkpoint ON recovery_checkpoint.approval_id = recovery_approval.id
  WHERE recovery_approval.id = ?
    AND recovery_approval.run_id = ?
    AND recovery_approval.status = 'pending'
    AND recovery_run.status = 'waiting_for_approval'
    AND recovery_run.ended_at IS NULL
    AND recovery_unit.id = ?
    AND recovery_unit.linked_run_id = recovery_run.id
    AND recovery_unit.status = 'waiting_for_approval'
    AND recovery_attempt.id = ?
    AND recovery_attempt.work_unit_id = recovery_unit.id
    AND recovery_attempt.runtime_instance_id = ?
    AND recovery_attempt.fencing_token = ?
    AND recovery_attempt.status = 'lost'
    AND recovery_attempt.ended_at IS NOT NULL
    AND recovery_attempt.error_code = 'runtime_suspend'
    AND recovery_checkpoint.status = 'pending'
)`;

function normalizeOptionalOwnerId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
