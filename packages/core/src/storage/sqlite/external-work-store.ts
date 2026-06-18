import type { SQLOutputValue } from "node:sqlite";
import {
  type ExternalWorkItem,
  type ExternalWorkRecord,
  type ExternalWorkRouteRequest,
  type ListExternalWorkRecordsOptions,
} from "../../external-work-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { mapExternalWorkRecord } from "./external-work-mappers.js";
import { externalWorkSelectColumnsFromAlias, externalWorkSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteExternalWorkStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
}

export class SqliteExternalWorkStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteExternalWorkStorePorts,
  ) {}

  createExternalWorkRecord(record: ExternalWorkRecord): ExternalWorkRecord {
    this.context.database
      .prepare(`
        INSERT INTO external_work_items (
          id,
          workspace_id,
          channel_id,
          source_kind,
          work_item_kind,
          external_id,
          identifier,
          idempotency_key,
          workflow_id,
          workflow_step_id,
          artifact_ids_json,
          item_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.workspaceId,
        record.channelId,
        record.sourceKind,
        record.workItemKind,
        record.externalId,
        record.identifier,
        record.idempotencyKey,
        record.workflowId,
        record.workflowStepId,
        stringifyJson(record.artifactIds),
        stringifyJson(record.item),
        record.createdAt,
        record.updatedAt,
      );

    const created = this.getExternalWorkRecord(record.id);
    if (!created) {
      throw new Error(`Failed to create external work item: ${record.id}`);
    }
    return created;
  }

  getExternalWorkRecord(id: string): ExternalWorkRecord | undefined {
    const row = this.context.database.prepare(externalWorkSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkRecord(row as Record<string, SQLOutputValue>) : undefined;
  }

  listExternalWorkRecords(options: ListExternalWorkRecordsOptions = {}): ExternalWorkRecord[] {
    const clauses = ["w.workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("w.channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceKind) {
      clauses.push("w.source_kind = ?");
      params.push(options.sourceKind);
    }
    if (options.workItemKind) {
      clauses.push("w.work_item_kind = ?");
      params.push(options.workItemKind);
    }
    if (options.schedulerStatus) {
      clauses.push("s.scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`
        SELECT
          ${externalWorkSelectColumnsFromAlias("w")}
        FROM external_work_items w
        LEFT JOIN external_work_scheduler_state s ON s.external_work_id = w.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY w.updated_at DESC, w.id DESC
        LIMIT ?
      `)
      .all(...params)
      .map((row) => mapExternalWorkRecord(row as Record<string, SQLOutputValue>));
  }

  countExternalWorkRecords(options: Omit<ListExternalWorkRecordsOptions, "limit"> = {}): number {
    const clauses = ["w.workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("w.channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceKind) {
      clauses.push("w.source_kind = ?");
      params.push(options.sourceKind);
    }
    if (options.workItemKind) {
      clauses.push("w.work_item_kind = ?");
      params.push(options.workItemKind);
    }
    if (options.schedulerStatus) {
      clauses.push("s.scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    const row = this.context.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM external_work_items w
        LEFT JOIN external_work_scheduler_state s ON s.external_work_id = w.id
        WHERE ${clauses.join(" AND ")}
      `)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getExternalWorkRecordByIdempotency(sourceKind: ExternalWorkRecord["sourceKind"], idempotencyKey: string): ExternalWorkRecord | undefined {
    const row = this.context.database
      .prepare(externalWorkSelectSql("WHERE workspace_id = ? AND source_kind = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, idempotencyKey);
    return row ? mapExternalWorkRecord(row as Record<string, SQLOutputValue>) : undefined;
  }

  updateExternalWorkArtifacts(id: string, artifactIds: readonly string[], now: string): ExternalWorkRecord | undefined {
    const existing = this.getExternalWorkRecord(id);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare("UPDATE external_work_items SET artifact_ids_json = ?, updated_at = ? WHERE id = ?")
      .run(stringifyJson([...artifactIds]), now, id);
    return this.getExternalWorkRecord(id);
  }

  routeExternalWorkRecord(id: string, input: ExternalWorkRouteRequest, now: string): ExternalWorkRecord | undefined {
    const existing = this.getExternalWorkRecord(id);
    if (!existing) {
      return undefined;
    }
    this.ports.assertChannelExists(input.channelId);
    const nextItem: ExternalWorkItem = input.priority === undefined
      ? existing.item
      : { ...existing.item, priority: input.priority };
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database
        .prepare(`
          UPDATE external_work_items
          SET channel_id = ?, item_json = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(input.channelId, stringifyJson(nextItem), now, id);
      this.context.database
        .prepare("UPDATE external_work_scheduler_state SET channel_id = ?, updated_at = ? WHERE external_work_id = ?")
        .run(input.channelId, now, id);
      this.context.database
        .prepare("UPDATE external_work_actions SET channel_id = ?, updated_at = ? WHERE external_work_id = ?")
        .run(input.channelId, now, id);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    return this.getExternalWorkRecord(id);
  }
}
