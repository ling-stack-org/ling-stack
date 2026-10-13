import type { SQLOutputValue } from "node:sqlite";
import {
  createExternalWorkActionId,
  type CommitExternalWorkActionTransitionInput,
  type CreateExternalWorkActionInput,
  type ExternalWorkAction,
  type ExternalWorkRecord,
  type ListExternalWorkActionsOptions,
  type UpdateExternalWorkActionInput,
} from "../../external-work-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { omitUndefined, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import type { ApprovalRequest } from "../../approval-types.js";
import { mapExternalWorkAction } from "./external-work-mappers.js";
import { externalWorkActionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteExternalWorkActionStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly getExternalWorkRecord: (id: string) => ExternalWorkRecord | undefined;
  readonly denyPendingApproval: (id: string, reason: string, now: string) => ApprovalRequest | undefined;
}

export class SqliteExternalWorkActionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteExternalWorkActionStorePorts,
  ) {}

  createExternalWorkAction(input: CreateExternalWorkActionInput, now: string): ExternalWorkAction {
    this.ports.assertChannelExists(input.channelId);
    const externalWork = this.ports.getExternalWorkRecord(input.externalWorkId);
    if (!externalWork) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    if (externalWork.channelId !== input.channelId) {
      throw new Error(`External work item does not belong to channel: ${input.channelId}`);
    }
    const existing = this.getExternalWorkActionByIdempotency(input.sourceKind, input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const action: ExternalWorkAction = omitUndefined({
      id: createExternalWorkActionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      externalWorkId: input.externalWorkId,
      sourceKind: input.sourceKind,
      actionKind: input.actionKind,
      status: input.status,
      approvalId: input.approvalId,
      idempotencyKey: input.idempotencyKey,
      target: input.target,
      payload: input.payload,
      approvalRequirement: input.approvalRequirement,
      artifactIds: [...(input.artifactIds ?? [])],
      executionAttemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    this.context.database
      .prepare(`
        INSERT INTO external_work_actions (
          id,
          workspace_id,
          channel_id,
          external_work_id,
          source_kind,
          action_kind,
          status,
          approval_id,
          idempotency_key,
          target_json,
          payload_json,
          approval_requirement,
          artifact_ids_json,
          execution_attempt_count,
          last_attempt_at,
          next_attempt_at,
          last_error_code,
          last_error_message,
          created_at,
          updated_at,
          executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        action.id,
        action.workspaceId,
        action.channelId,
        action.externalWorkId,
        action.sourceKind,
        action.actionKind,
        action.status,
        action.approvalId ?? null,
        action.idempotencyKey,
        stringifyJson(action.target),
        stringifyJson(action.payload),
        action.approvalRequirement,
        stringifyJson(action.artifactIds),
        action.executionAttemptCount,
        null,
        null,
        null,
        null,
        action.createdAt,
        action.updatedAt,
        null,
      );

    const created = this.getExternalWorkAction(action.id);
    if (!created) {
      throw new Error(`Failed to create external work action: ${action.id}`);
    }
    return created;
  }

  getExternalWorkAction(id: string): ExternalWorkAction | undefined {
    const row = this.context.database.prepare(externalWorkActionSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkAction(row as Record<string, SQLOutputValue>) : undefined;
  }

  getExternalWorkActionByIdempotency(sourceKind: ExternalWorkAction["sourceKind"], idempotencyKey: string): ExternalWorkAction | undefined {
    const row = this.context.database
      .prepare(externalWorkActionSelectSql("WHERE workspace_id = ? AND source_kind = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, idempotencyKey);
    return row ? mapExternalWorkAction(row as Record<string, SQLOutputValue>) : undefined;
  }

  listExternalWorkActions(options: ListExternalWorkActionsOptions = {}): ExternalWorkAction[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.actionKind) {
      clauses.push("action_kind = ?");
      params.push(options.actionKind);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${externalWorkActionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapExternalWorkAction(row as Record<string, SQLOutputValue>));
  }

  countExternalWorkActions(options: Omit<ListExternalWorkActionsOptions, "limit"> = {}): number {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.actionKind) {
      clauses.push("action_kind = ?");
      params.push(options.actionKind);
    }
    const row = this.context.database
      .prepare(`SELECT COUNT(*) AS count FROM external_work_actions WHERE ${clauses.join(" AND ")}`)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  updateExternalWorkAction(id: string, input: UpdateExternalWorkActionInput, now: string): ExternalWorkAction | undefined {
    const existing = this.getExternalWorkAction(id);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare(`
        UPDATE external_work_actions
        SET
          status = ?,
          approval_id = ?,
          artifact_ids_json = ?,
          execution_attempt_count = ?,
          last_attempt_at = ?,
          next_attempt_at = ?,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?,
          executed_at = ?
        WHERE id = ?
      `)
      .run(
        input.status ?? existing.status,
        input.approvalId === undefined ? existing.approvalId ?? null : input.approvalId,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        input.executionAttemptCount ?? existing.executionAttemptCount,
        input.lastAttemptAt === undefined ? existing.lastAttemptAt ?? null : input.lastAttemptAt,
        input.nextAttemptAt === undefined ? existing.nextAttemptAt ?? null : input.nextAttemptAt,
        input.lastErrorCode === undefined ? existing.lastErrorCode ?? null : input.lastErrorCode,
        input.lastErrorMessage === undefined ? existing.lastErrorMessage ?? null : input.lastErrorMessage,
        now,
        input.executedAt === undefined ? existing.executedAt ?? null : input.executedAt,
        id,
      );
    return this.getExternalWorkAction(id);
  }

  /** HTTP awaits stay outside this transaction; the guard, evidence and state commit are indivisible. */
  commitExternalWorkActionTransition(
    input: CommitExternalWorkActionTransitionInput,
    now: string,
    createEvidence?: (action: ExternalWorkAction) => readonly string[],
  ): ExternalWorkAction | undefined {
    const database = this.context.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const clauses = ["id = ?", "status = ?", "execution_attempt_count = ?", "approval_id IS ?"];
      const params: (string | number | null)[] = [input.actionId, input.expectedStatus, input.expectedExecutionAttemptCount, input.expectedApprovalId];
      if (input.approvalStatus !== undefined) {
        clauses.push(`EXISTS (SELECT 1 FROM approval_requests AS approval
          WHERE approval.id = external_work_actions.approval_id
            AND approval.external_work_action_id = external_work_actions.id
            AND approval.channel_id IS external_work_actions.channel_id
            AND approval.status = ?)`);
        params.push(input.approvalStatus);
      }
      if (input.subjectLease) {
        clauses.push(`EXISTS (SELECT 1 FROM resource_leases AS lease
          WHERE lease.id = ? AND lease.owner_type = 'system' AND lease.owner_id = ?
            AND lease.resource_type = 'external_subject' AND lease.resource_key = ?
            AND lease.workspace_id = external_work_actions.workspace_id
            AND lease.status = 'active' AND lease.attempt_id IS NULL
            AND lease.acquired_at <= ? AND lease.expires_at > ?)`);
        params.push(input.subjectLease.id, input.subjectLease.ownerId, input.subjectLease.resourceKey, now, now);
      }
      const row = database.prepare(externalWorkActionSelectSql(`WHERE ${clauses.join(" AND ")}`)).get(...params);
      if (!row) {
        database.exec("COMMIT");
        return undefined;
      }
      const action = mapExternalWorkAction(row as Record<string, SQLOutputValue>);
      if (input.cancelPendingApproval && action.approvalId) {
        const approval = database.prepare("SELECT external_work_action_id, channel_id, status FROM approval_requests WHERE id = ?").get(action.approvalId);
        if (!approval || approval.external_work_action_id !== action.id || approval.channel_id !== action.channelId) {
          throw new Error(`Approval request does not belong to external work action: ${action.id}`);
        }
        if (approval.status === "pending") {
          const denied = this.ports.denyPendingApproval(action.approvalId, input.cancelPendingApproval.reason, now);
          if (denied?.status !== "denied") throw new Error(`Failed to deny cancelled action approval: ${action.approvalId}`);
        }
      }
      const evidenceIds = createEvidence?.(action) ?? [];
      const updated = this.updateExternalWorkAction(action.id, {
        ...input.update,
        artifactIds: [...(input.update.artifactIds ?? action.artifactIds), ...evidenceIds],
      }, now);
      if (!updated) throw new Error(`Failed to commit external work action transition: ${action.id}`);
      database.exec("COMMIT");
      return updated;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }
}
