import type { SQLOutputValue } from "node:sqlite";
import {
  createLingThreadId,
  type CreateLingThreadInput,
  type LingThread,
  type LingThreadKind,
  type ListLingThreadsOptions,
  type UpdateLingThreadInput,
} from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { nullableUpdate } from "./helpers.js";
import { mapLingThread } from "./run-mappers.js";
import { lingThreadSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteLingThreadStorePorts {
  readonly rebuildLingThreadMetadata: (threadId: string, now: string) => void;
}

export class SqliteLingThreadStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteLingThreadStorePorts,
  ) {}

  createLingThread(input: CreateLingThreadInput, now: string): LingThread {
    const id = input.id ?? createLingThreadId();
    this.context.database
      .prepare(`
        INSERT INTO ling_threads (
          id,
          workspace_id,
          kind,
          channel_id,
          task_id,
          teammate_id,
          workflow_id,
          workflow_step_id,
          external_work_id,
          title,
          objective,
          status,
          active_run_id,
          last_run_id,
          parent_thread_id,
          parent_turn_id,
          forked_from_run_id,
          metadata_json,
          created_at,
          updated_at,
          pinned_at,
          archived_at,
          archived_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        DEFAULT_WORKSPACE_ID,
        input.kind,
        input.channelId ?? null,
        input.taskId ?? null,
        input.teammateId ?? null,
        input.workflowId ?? null,
        input.workflowStepId ?? null,
        input.externalWorkId ?? null,
        input.title,
        input.objective,
        input.status ?? "open",
        input.activeRunId ?? null,
        input.lastRunId ?? null,
        input.parentThreadId ?? null,
        input.parentTurnId ?? null,
        input.forkedFromRunId ?? null,
        null,
        now,
        now,
        input.pinnedAt ?? null,
        input.archivedAt ?? null,
        input.archivedReason ?? null,
      );
    this.ports.rebuildLingThreadMetadata(id, now);
    const thread = this.getLingThread(id);
    if (!thread) {
      throw new Error(`Failed to create Ling thread: ${id}`);
    }
    return thread;
  }

  getLingThread(threadId: string): LingThread | undefined {
    const row = this.context.database.prepare(lingThreadSelectSql("WHERE id = ?")).get(threadId);
    return row ? mapLingThread(row as Record<string, SQLOutputValue>) : undefined;
  }

  findLingThreadByOwner(input: {
    readonly kind: LingThreadKind;
    readonly taskId?: string;
    readonly workflowStepId?: string;
    readonly externalWorkId?: string;
    readonly teammateId?: string;
    readonly channelId?: string;
  }): LingThread | undefined {
    const clauses = ["workspace_id = ?", "kind = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID, input.kind];
    appendNullableOwnerClause(clauses, params, "task_id", input.taskId);
    appendNullableOwnerClause(clauses, params, "workflow_step_id", input.workflowStepId);
    appendNullableOwnerClause(clauses, params, "external_work_id", input.externalWorkId);
    appendNullableOwnerClause(clauses, params, "teammate_id", input.teammateId);
    appendNullableOwnerClause(clauses, params, "channel_id", input.channelId);
    const row = this.context.database.prepare(`${lingThreadSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC LIMIT 1`).get(...params);
    return row ? mapLingThread(row as Record<string, SQLOutputValue>) : undefined;
  }

  listLingThreads(options: ListLingThreadsOptions = {}): LingThread[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.taskId) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.workflowStepId) {
      clauses.push("workflow_step_id = ?");
      params.push(options.workflowStepId);
    }
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const archivedFilter = options.archived ?? (options.includeArchived || options.status ? "include" : "exclude");
    if (archivedFilter === "exclude") {
      clauses.push("(archived_at IS NULL AND status != 'archived')");
    } else if (archivedFilter === "only") {
      clauses.push("(archived_at IS NOT NULL OR status = 'archived')");
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${lingThreadSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY pinned_at IS NULL ASC, pinned_at DESC, updated_at DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapLingThread(row as Record<string, SQLOutputValue>));
  }

  updateLingThread(threadId: string, input: UpdateLingThreadInput, now: string): LingThread | undefined {
    const existing = this.getLingThread(threadId);
    if (!existing) {
      return undefined;
    }
    const next: LingThread = {
      ...existing,
      title: input.title ?? existing.title,
      objective: input.objective ?? existing.objective,
      status: input.status ?? existing.status,
      activeRunId: nullableUpdate(input.activeRunId, existing.activeRunId),
      lastRunId: nullableUpdate(input.lastRunId, existing.lastRunId),
      pinnedAt: nullableUpdate(input.pinnedAt, existing.pinnedAt),
      archivedAt: nullableUpdate(input.archivedAt, existing.archivedAt),
      archivedReason: nullableUpdate(input.archivedReason, existing.archivedReason),
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        UPDATE ling_threads
        SET title = ?,
            objective = ?,
            status = ?,
            active_run_id = ?,
            last_run_id = ?,
            updated_at = ?,
            pinned_at = ?,
            archived_at = ?,
            archived_reason = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.objective,
        next.status,
        next.activeRunId ?? null,
        next.lastRunId ?? null,
        next.updatedAt,
        next.pinnedAt ?? null,
        next.archivedAt ?? null,
        next.archivedReason ?? null,
        threadId,
      );
    this.ports.rebuildLingThreadMetadata(threadId, now);
    return this.getLingThread(threadId);
  }
}

function appendNullableOwnerClause(clauses: string[], params: string[], column: string, value: string | undefined): void {
  if (value === undefined) {
    clauses.push(`${column} IS NULL`);
    return;
  }
  clauses.push(`${column} = ?`);
  params.push(value);
}
