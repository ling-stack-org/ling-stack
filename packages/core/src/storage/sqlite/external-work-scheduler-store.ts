import type { SQLOutputValue } from "node:sqlite";
import {
  type ExternalWorkSchedulerState,
  type ListExternalWorkSchedulerStatesOptions,
  type UpdateExternalWorkSchedulerStateInput,
  type UpsertExternalWorkSchedulerStateInput,
} from "../../external-work-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import { mapExternalWorkSchedulerState } from "./external-work-mappers.js";
import { externalWorkSchedulerStateSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteExternalWorkSchedulerStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly hasExternalWorkRecord: (id: string) => boolean;
}

export class SqliteExternalWorkSchedulerStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteExternalWorkSchedulerStorePorts,
  ) {}

  upsertExternalWorkSchedulerState(input: UpsertExternalWorkSchedulerStateInput, now: string): ExternalWorkSchedulerState {
    this.ports.assertChannelExists(input.channelId);
    if (!this.ports.hasExternalWorkRecord(input.externalWorkId)) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    this.context.database
      .prepare(`
        INSERT INTO external_work_scheduler_state (
          external_work_id,
          workspace_id,
          channel_id,
          subject_key,
          source_key,
          workflow_id,
          workflow_step_id,
          scheduler_status,
          attempt_count,
          last_attempt_at,
          next_attempt_at,
          max_retry_backoff_ms,
          last_error_code,
          last_error_message,
          workspace_path,
          workspace_mode,
          hook_artifact_ids_json,
          last_reconciled_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_work_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          subject_key = excluded.subject_key,
          source_key = excluded.source_key,
          workflow_id = excluded.workflow_id,
          workflow_step_id = excluded.workflow_step_id,
          scheduler_status = excluded.scheduler_status,
          attempt_count = excluded.attempt_count,
          last_attempt_at = excluded.last_attempt_at,
          next_attempt_at = excluded.next_attempt_at,
          max_retry_backoff_ms = excluded.max_retry_backoff_ms,
          last_error_code = excluded.last_error_code,
          last_error_message = excluded.last_error_message,
          workspace_path = excluded.workspace_path,
          workspace_mode = excluded.workspace_mode,
          hook_artifact_ids_json = excluded.hook_artifact_ids_json,
          last_reconciled_at = excluded.last_reconciled_at,
          updated_at = excluded.updated_at
      `)
      .run(
        input.externalWorkId,
        DEFAULT_WORKSPACE_ID,
        input.channelId,
        input.subjectKey,
        input.sourceKey,
        input.workflowId,
        input.workflowStepId,
        input.schedulerStatus,
        input.attemptCount ?? 0,
        input.lastAttemptAt ?? null,
        input.nextAttemptAt ?? null,
        input.maxRetryBackoffMs,
        input.lastErrorCode ?? null,
        input.lastErrorMessage ?? null,
        input.workspacePath ?? null,
        input.workspaceMode ?? null,
        stringifyJson(input.hookArtifactIds ?? []),
        input.lastReconciledAt ?? null,
        now,
        now,
      );
    const created = this.getExternalWorkSchedulerState(input.externalWorkId);
    if (!created) {
      throw new Error(`Failed to upsert external work scheduler state: ${input.externalWorkId}`);
    }
    return created;
  }

  getExternalWorkSchedulerState(externalWorkId: string): ExternalWorkSchedulerState | undefined {
    const row = this.context.database.prepare(externalWorkSchedulerStateSelectSql("WHERE external_work_id = ?")).get(externalWorkId);
    return row ? mapExternalWorkSchedulerState(row as Record<string, SQLOutputValue>) : undefined;
  }

  findActiveExternalWorkSchedulerState(sourceKey: string, subjectKey: string): ExternalWorkSchedulerState | undefined {
    const row = this.context.database
      .prepare(`
        ${externalWorkSchedulerStateSelectSql(
          "WHERE workspace_id = ? AND source_key = ? AND subject_key = ? AND scheduler_status IN ('discovered', 'claimed', 'workspace_preparing', 'ready', 'retry_wait')",
        )}
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(DEFAULT_WORKSPACE_ID, sourceKey, subjectKey);
    return row ? mapExternalWorkSchedulerState(row as Record<string, SQLOutputValue>) : undefined;
  }

  listExternalWorkSchedulerStates(options: ListExternalWorkSchedulerStatesOptions = {}): ExternalWorkSchedulerState[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.schedulerStatus) {
      clauses.push("scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    if (options.sourceKey) {
      clauses.push("source_key = ?");
      params.push(options.sourceKey);
    }
    if (options.subjectKey) {
      clauses.push("subject_key = ?");
      params.push(options.subjectKey);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${externalWorkSchedulerStateSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, external_work_id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapExternalWorkSchedulerState(row as Record<string, SQLOutputValue>));
  }

  updateExternalWorkSchedulerState(
    externalWorkId: string,
    input: UpdateExternalWorkSchedulerStateInput,
    now: string,
  ): ExternalWorkSchedulerState | undefined {
    const existing = this.getExternalWorkSchedulerState(externalWorkId);
    if (!existing) {
      return undefined;
    }
    const next = {
      schedulerStatus: input.schedulerStatus ?? existing.schedulerStatus,
      attemptCount: input.attemptCount ?? existing.attemptCount,
      lastAttemptAt: nullableUpdate(input.lastAttemptAt, existing.lastAttemptAt),
      nextAttemptAt: nullableUpdate(input.nextAttemptAt, existing.nextAttemptAt),
      maxRetryBackoffMs: input.maxRetryBackoffMs ?? existing.maxRetryBackoffMs,
      lastErrorCode: nullableUpdate(input.lastErrorCode, existing.lastErrorCode),
      lastErrorMessage: nullableUpdate(input.lastErrorMessage, existing.lastErrorMessage),
      workspacePath: nullableUpdate(input.workspacePath, existing.workspacePath),
      workspaceMode: nullableUpdate(input.workspaceMode, existing.workspaceMode),
      hookArtifactIds: input.hookArtifactIds ?? existing.hookArtifactIds,
      lastReconciledAt: nullableUpdate(input.lastReconciledAt, existing.lastReconciledAt),
    };
    this.context.database
      .prepare(`
        UPDATE external_work_scheduler_state
        SET
          scheduler_status = ?,
          attempt_count = ?,
          last_attempt_at = ?,
          next_attempt_at = ?,
          max_retry_backoff_ms = ?,
          last_error_code = ?,
          last_error_message = ?,
          workspace_path = ?,
          workspace_mode = ?,
          hook_artifact_ids_json = ?,
          last_reconciled_at = ?,
          updated_at = ?
        WHERE external_work_id = ?
      `)
      .run(
        next.schedulerStatus,
        next.attemptCount,
        next.lastAttemptAt ?? null,
        next.nextAttemptAt ?? null,
        next.maxRetryBackoffMs,
        next.lastErrorCode ?? null,
        next.lastErrorMessage ?? null,
        next.workspacePath ?? null,
        next.workspaceMode ?? null,
        stringifyJson(next.hookArtifactIds),
        next.lastReconciledAt ?? null,
        now,
        externalWorkId,
      );
    return this.getExternalWorkSchedulerState(externalWorkId);
  }
}
