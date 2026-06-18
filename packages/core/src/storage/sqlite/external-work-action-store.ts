import type { SQLOutputValue } from "node:sqlite";
import {
  createExternalWorkActionId,
  type CreateExternalWorkActionInput,
  type ExternalWorkAction,
  type ExternalWorkRecord,
  type ListExternalWorkActionsOptions,
  type UpdateExternalWorkActionInput,
} from "../../external-work-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { omitUndefined, stringifyJson } from "./helpers.js";
import { mapExternalWorkAction } from "./external-work-mappers.js";
import { externalWorkActionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteExternalWorkActionStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly getExternalWorkRecord: (id: string) => ExternalWorkRecord | undefined;
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
}
