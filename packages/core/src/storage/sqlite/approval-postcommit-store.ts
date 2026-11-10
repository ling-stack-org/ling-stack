import type { DatabaseSync } from "node:sqlite";
import type { ApprovalRequest } from "../../approval-types.js";
import type {
  ApprovalPostCommitEffect,
  ApprovalPostCommitEffectKind,
  ApprovalPostCommitEffectStatus,
  ApprovalPostCommitOwnerKind,
} from "../../approval-postcommit-types.js";

const effectOrder = "CASE effect_kind WHEN 'decision_event' THEN 0 WHEN 'owner' THEN 1 ELSE 2 END";

function ownerForApproval(approval: ApprovalRequest): { kind: ApprovalPostCommitOwnerKind; id: string } | undefined {
  // A Run approval may also carry its workflow step for lineage. The Run is
  // still the only execution owner; the workflow step is not a second effect.
  if (approval.runId && approval.workflowStepId && !approval.mediaJobId && !approval.externalWorkActionId) {
    return { kind: "run", id: approval.runId };
  }
  const owners: { kind: ApprovalPostCommitOwnerKind; id: string }[] = [];
  if (approval.runId) owners.push({ kind: "run", id: approval.runId });
  if (approval.workflowStepId) owners.push({ kind: "workflow_step", id: approval.workflowStepId });
  if (approval.mediaJobId) owners.push({ kind: "media_job", id: approval.mediaJobId });
  if (approval.externalWorkActionId) owners.push({ kind: "external_work_action", id: approval.externalWorkActionId });
  if (owners.length > 1) throw new Error(`Approval has multiple effect owners: ${approval.id}`);
  return owners[0];
}

function decisionEventOwnerForApproval(
  database: DatabaseSync,
  approval: ApprovalRequest,
): { kind: "run"; id: string } | undefined {
  if (approval.runId) {
    return database.prepare(`
      SELECT id
      FROM run_sessions
      WHERE id = ? AND task_id = ? AND channel_id IS ?
    `).get(approval.runId, approval.taskId ?? null, approval.channelId ?? null)
      ? { kind: "run", id: approval.runId }
      : undefined;
  }

  const payload = approval.payload;
  if (payload.type !== "workflow_step" || payload.gateStage !== "post"
    || !approval.workflowStepId || !approval.channelId || !payload.runId) {
    return undefined;
  }
  const lineage = database.prepare(`
    SELECT run.id
    FROM channel_workflow_steps AS step
    JOIN channel_workflows AS workflow
      ON workflow.id = step.workflow_id AND workflow.channel_id = step.channel_id
    JOIN run_sessions AS run
      ON run.id = step.run_id
      AND run.workflow_step_id = step.id
      AND run.channel_id = step.channel_id
    WHERE step.id = ?
      AND step.channel_id = ?
      AND step.workflow_id = ?
      AND step.run_id = ?
  `).get(approval.workflowStepId, approval.channelId, payload.workflowId, payload.runId) as { id?: unknown } | undefined;
  return lineage?.id === payload.runId ? { kind: "run", id: payload.runId } : undefined;
}

function mapEffect(row: Record<string, unknown>): ApprovalPostCommitEffect {
  return {
    approvalId: String(row.approval_id),
    effectKind: row.effect_kind as ApprovalPostCommitEffectKind,
    ...(row.owner_kind ? { ownerKind: row.owner_kind as ApprovalPostCommitOwnerKind } : {}),
    ...(row.owner_id ? { ownerId: String(row.owner_id) } : {}),
    status: row.status as ApprovalPostCommitEffectStatus,
    revision: Number(row.revision),
    ...(row.claim_token ? { claimToken: String(row.claim_token) } : {}),
    ...(row.claim_expires_at ? { claimExpiresAt: String(row.claim_expires_at) } : {}),
    attempts: Number(row.attempts),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteApprovalPostCommitStore {
  constructor(private readonly database: DatabaseSync) {}

  /** Must be called from inside the approval decision's SQLite savepoint. */
  recordDecision(approval: ApprovalRequest, now: string): void {
    const owner = ownerForApproval(approval);
    const decisionEventOwner = decisionEventOwnerForApproval(this.database, approval);
    const insert = this.database.prepare(`
      INSERT INTO approval_postcommit_effects
        (approval_id, effect_kind, owner_kind, owner_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `);
    if (decisionEventOwner) {
      insert.run(approval.id, "decision_event", decisionEventOwner.kind, decisionEventOwner.id, now, now);
    }
    if (owner) insert.run(approval.id, "owner", owner.kind, owner.id, now, now);
    insert.run(approval.id, "control_plane_event", null, null, now, now);
  }

  list(options: {
    readonly approvalId?: string;
    readonly status?: ApprovalPostCommitEffectStatus;
    readonly after?: { readonly createdAt: string; readonly approvalId: string; readonly effectKind: ApprovalPostCommitEffectKind };
    readonly limit?: number;
  } = {}): ApprovalPostCommitEffect[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.approvalId) { clauses.push("approval_id = ?"); params.push(options.approvalId); }
    if (options.status) { clauses.push("status = ?"); params.push(options.status); }
    if (options.after) {
      clauses.push(`(created_at > ? OR (created_at = ? AND approval_id > ?) OR (created_at = ? AND approval_id = ? AND ${effectOrder} > CASE ? WHEN 'decision_event' THEN 0 WHEN 'owner' THEN 1 ELSE 2 END))`);
      params.push(options.after.createdAt, options.after.createdAt, options.after.approvalId,
        options.after.createdAt, options.after.approvalId, options.after.effectKind);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.prepare(`SELECT * FROM approval_postcommit_effects ${where}
      ORDER BY created_at, approval_id, ${effectOrder} LIMIT ?`)
      .all(...params, Math.min(Math.max(options.limit ?? 100, 1), 500))
      .map(mapEffect);
  }

  claim(approvalId: string, effectKind: ApprovalPostCommitEffectKind, input: {
    readonly token: string;
    readonly claimExpiresAt: string;
  }, now: string): ApprovalPostCommitEffect | undefined {
    if (!input.token || input.claimExpiresAt <= now) throw new Error("Invalid approval effect claim");
    const result = this.database.prepare(`UPDATE approval_postcommit_effects SET
      status = 'claimed', claim_token = ?, claim_expires_at = ?, attempts = attempts + 1,
      revision = revision + 1, updated_at = ?
      WHERE approval_id = ? AND effect_kind = ? AND status = 'pending'`)
      .run(input.token, input.claimExpiresAt, now, approvalId, effectKind);
    if (result.changes !== 1) return undefined;
    return this.get(approvalId, effectKind);
  }

  settle(approvalId: string, effectKind: ApprovalPostCommitEffectKind, input: {
    readonly token: string;
    readonly status: Extract<ApprovalPostCommitEffectStatus, "completed" | "pending" | "blocked" | "effect_unknown">;
    readonly errorCode?: string;
  }, now: string): ApprovalPostCommitEffect | undefined {
    if (!input.token || (input.errorCode && !/^[a-z0-9_.-]{1,100}$/.test(input.errorCode))) {
      throw new Error("Invalid approval effect settlement");
    }
    const result = this.database.prepare(`UPDATE approval_postcommit_effects SET
      status = ?, claim_token = NULL, claim_expires_at = NULL, last_error_code = ?,
      revision = revision + 1, updated_at = ?
      WHERE approval_id = ? AND effect_kind = ? AND status = 'claimed' AND claim_token = ?`)
      .run(input.status, input.errorCode ?? null, now, approvalId, effectKind, input.token);
    if (result.changes !== 1) return undefined;
    return this.get(approvalId, effectKind);
  }

  /** A stale owner claim may be retried only after the caller verifies owner evidence. */
  recoverExpiredClaim(approvalId: string, effectKind: ApprovalPostCommitEffectKind, input: {
    readonly expectedRevision: number;
    readonly status: "pending" | "completed" | "blocked" | "effect_unknown";
    readonly errorCode: string;
  }, now: string): ApprovalPostCommitEffect | undefined {
    if (!/^[a-z0-9_.-]{1,100}$/.test(input.errorCode)
      || (effectKind === "owner" && input.status === "pending"
        && this.get(approvalId, effectKind)?.ownerKind === "media_job")) {
      throw new Error("Unsafe approval effect recovery");
    }
    const result = this.database.prepare(`UPDATE approval_postcommit_effects SET
      status = ?, claim_token = NULL, claim_expires_at = NULL,
      last_error_code = ?, revision = revision + 1, updated_at = ?
      WHERE approval_id = ? AND effect_kind = ? AND status = 'claimed'
        AND revision = ? AND claim_expires_at < ?`)
      .run(input.status, input.errorCode, now, approvalId, effectKind, input.expectedRevision, now);
    if (result.changes !== 1) return undefined;
    return this.get(approvalId, effectKind);
  }

  /** A placeholder handle cannot prove that external submission did not happen. */
  quarantineMediaSubmission(approvalId: string, mediaJobId: string, now: string): ApprovalPostCommitEffect | undefined {
    const update = this.database.prepare(`UPDATE approval_postcommit_effects SET
      status = 'effect_unknown', claim_token = NULL, claim_expires_at = NULL,
      last_error_code = 'media_submission_handle_unavailable',
      revision = revision + 1, updated_at = ?
      WHERE approval_id = ? AND effect_kind = 'owner' AND owner_kind = 'media_job'
        AND owner_id = ? AND status IN ('pending', 'claimed', 'completed')`)
      .run(now, approvalId, mediaJobId);
    return update.changes === 1 ? this.get(approvalId, "owner") : undefined;
  }

  get(approvalId: string, effectKind: ApprovalPostCommitEffectKind): ApprovalPostCommitEffect | undefined {
    const row = this.database.prepare(`SELECT * FROM approval_postcommit_effects WHERE approval_id = ? AND effect_kind = ?`)
      .get(approvalId, effectKind);
    return row ? mapEffect(row) : undefined;
  }
}
