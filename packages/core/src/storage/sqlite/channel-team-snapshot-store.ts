import type { SQLOutputValue } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  channelTeamSnapshotCreatedByValues,
  createChannelTeamEvaluationRunId,
  createChannelTeamSnapshotId,
  type ChannelTeamEvaluationRun,
  type ChannelTeamSnapshot,
  type CreateChannelTeamEvaluationRunInput,
  type CreateChannelTeamSnapshotInput,
  type ListChannelTeamEvaluationRunsOptions,
  type ListChannelTeamSnapshotsOptions,
} from "../../channel-team-types.js";
import { stringifyJson } from "./helpers.js";
import {
  mapChannelTeamEvaluationRun,
  mapChannelTeamSnapshot,
} from "./channel-team-snapshot-mappers.js";
import {
  channelTeamEvaluationSelectSql,
  channelTeamSnapshotSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelTeamSnapshotStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
}

export class SqliteChannelTeamSnapshotStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelTeamSnapshotStorePorts,
  ) {}

  createChannelTeamSnapshot(input: CreateChannelTeamSnapshotInput, now: string): ChannelTeamSnapshot {
    this.ports.assertChannelExists(input.channelId);
    validateNonEmptyString(input.reason, "channel team snapshot reason");
    const snapshot: ChannelTeamSnapshot = {
      id: input.id ?? createChannelTeamSnapshotId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      reason: input.reason,
      createdBy: input.createdBy ?? "system",
      state: input.state,
      createdAt: now,
    };
    if (!channelTeamSnapshotCreatedByValues.includes(snapshot.createdBy)) {
      throw new Error("channel team snapshot creator is not supported");
    }
    this.context.database
      .prepare(`
        INSERT INTO channel_team_snapshots (
          id,
          workspace_id,
          channel_id,
          reason,
          created_by,
          state_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshot.id,
        snapshot.workspaceId,
        snapshot.channelId,
        snapshot.reason,
        snapshot.createdBy,
        stringifyJson(snapshot.state),
        snapshot.createdAt,
      );
    const created = this.getChannelTeamSnapshot(snapshot.id);
    if (!created) {
      throw new Error(`Failed to create channel team snapshot: ${snapshot.id}`);
    }
    return created;
  }

  getChannelTeamSnapshot(id: string): ChannelTeamSnapshot | undefined {
    const row = this.context.database.prepare(channelTeamSnapshotSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelTeamSnapshot(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelTeamSnapshots(options: ListChannelTeamSnapshotsOptions): ChannelTeamSnapshot[] {
    const limit = clampLimit(options.limit);
    return this.context.database
      .prepare(`${channelTeamSnapshotSelectSql("WHERE workspace_id = ? AND channel_id = ?")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.channelId, limit)
      .map((row) => mapChannelTeamSnapshot(row as Record<string, SQLOutputValue>));
  }

  createChannelTeamEvaluationRun(input: CreateChannelTeamEvaluationRunInput, now: string): ChannelTeamEvaluationRun {
    this.ports.assertChannelExists(input.channelId);
    if (input.cases.length === 0) {
      throw new Error("channel team evaluation requires at least one case");
    }
    const run: ChannelTeamEvaluationRun = {
      id: input.id ?? createChannelTeamEvaluationRunId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      snapshotId: input.snapshotId,
      cases: input.cases,
      results: input.results,
      summary: input.summary,
      createdAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO channel_team_evaluations (
          id,
          workspace_id,
          channel_id,
          snapshot_id,
          cases_json,
          results_json,
          summary_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.workspaceId,
        run.channelId,
        run.snapshotId ?? null,
        stringifyJson(run.cases),
        stringifyJson(run.results),
        stringifyJson(run.summary),
        run.createdAt,
      );
    const created = this.getChannelTeamEvaluationRun(run.id);
    if (!created) {
      throw new Error(`Failed to create channel team evaluation: ${run.id}`);
    }
    return created;
  }

  getChannelTeamEvaluationRun(id: string): ChannelTeamEvaluationRun | undefined {
    const row = this.context.database.prepare(channelTeamEvaluationSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelTeamEvaluationRun(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelTeamEvaluationRuns(options: ListChannelTeamEvaluationRunsOptions): ChannelTeamEvaluationRun[] {
    const limit = clampLimit(options.limit);
    return this.context.database
      .prepare(`${channelTeamEvaluationSelectSql("WHERE workspace_id = ? AND channel_id = ?")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.channelId, limit)
      .map((row) => mapChannelTeamEvaluationRun(row as Record<string, SQLOutputValue>));
  }
}

function validateNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 20, 1), 100);
}
