import {
  type AppendControlPlaneEventInput,
  type ControlPlaneEvent,
  type ControlPlaneReplayState,
  type ControlPlaneReplayWindowResult,
  type ListControlPlaneEventsOptions,
  type ReadControlPlaneReplayWindowInput,
} from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";
import { readNumber, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { mapControlPlaneEvent } from "./control-plane-mappers.js";
import { controlPlaneEventSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteControlPlaneStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  appendControlPlaneEvent(input: AppendControlPlaneEventInput, now: string): ControlPlaneEvent {
    return this.appendControlPlaneEventWithTransactionOwnership(input, now, true);
  }

  /**
   * Appends as part of a caller-owned SQLite transaction.
   *
   * Node 22 can report `DatabaseSync.isTransaction === false` after `BEGIN IMMEDIATE`.
   * Atomic composition therefore passes ownership explicitly instead of probing runtime
   * state and accidentally issuing a nested `BEGIN`.
   */
  appendControlPlaneEventWithinTransaction(
    input: AppendControlPlaneEventInput,
    now: string,
  ): ControlPlaneEvent {
    return this.appendControlPlaneEventWithTransactionOwnership(input, now, false);
  }

  private appendControlPlaneEventWithTransactionOwnership(
    input: AppendControlPlaneEventInput,
    now: string,
    ownsTransaction: boolean,
  ): ControlPlaneEvent {
    if (ownsTransaction) this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const redactedData = redactSecrets(input.data ?? {}) as Record<string, unknown>;
      const inserted = this.context.database
        .prepare(`
          INSERT INTO control_plane_events (
            workspace_id,
            cwd,
            ts,
            domain,
            entity_type,
            entity_id,
            action,
            data_json,
            idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL
          DO NOTHING
        `)
        .run(
          input.workspaceId,
          input.cwd,
          now,
          input.domain,
          input.entityType,
          input.entityId,
          input.action,
          stringifyJson(redactedData),
          input.idempotencyKey ?? null,
        );
      if (Number(inserted.changes) === 0 && input.idempotencyKey) {
        const existing = this.getControlPlaneEventByIdempotency(input.workspaceId, input.idempotencyKey);
        if (!existing) {
          throw new Error(`Control-plane event idempotency insert lost: ${input.idempotencyKey}`);
        }
        assertSameControlPlaneEvent(existing, input);
        if (ownsTransaction) this.context.database.exec("COMMIT;");
        return existing;
      }
      const seq = readNumber(this.context.database.prepare("SELECT last_insert_rowid() AS seq").get(), "seq");
      const event = this.getControlPlaneEvent(seq);
      if (!event) {
        throw new Error(`Failed to append control-plane event: ${seq}`);
      }
      this.context.database.prepare(`
        INSERT INTO control_plane_replay_state (workspace_id, replay_floor_seq, latest_seq, updated_at)
        VALUES (?, 0, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          latest_seq = MAX(control_plane_replay_state.latest_seq, excluded.latest_seq),
          updated_at = excluded.updated_at
      `).run(input.workspaceId, event.seq, now);
      if (ownsTransaction) this.context.database.exec("COMMIT;");
      return event;
    } catch (error) {
      if (ownsTransaction) rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  getControlPlaneEventByIdempotency(workspaceId: string, idempotencyKey: string): ControlPlaneEvent | undefined {
    const row = this.context.database
      .prepare(controlPlaneEventSelectSql("WHERE workspace_id = ? AND idempotency_key = ?"))
      .get(workspaceId, idempotencyKey);
    return row ? mapControlPlaneEvent(row) : undefined;
  }

  listControlPlaneEvents(options: ListControlPlaneEventsOptions): ControlPlaneEvent[] {
    const clauses = ["workspace_id = ?", "seq > ?"];
    const params: (string | number)[] = [options.workspaceId, Math.max(options.afterSeq ?? 0, 0)];
    if (options.domains && options.domains.length > 0) {
      clauses.push(`domain IN (${options.domains.map(() => "?").join(", ")})`);
      params.push(...options.domains);
    }
    if (options.entityType) {
      clauses.push("entity_type = ?");
      params.push(options.entityType);
    }
    if (options.entityId) {
      clauses.push("entity_id = ?");
      params.push(options.entityId);
    }
    if (options.action) {
      clauses.push("action = ?");
      params.push(options.action);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    params.push(limit);
    return this.context.database
      .prepare(`${controlPlaneEventSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY seq ASC LIMIT ?`)
      .all(...params)
      .map(mapControlPlaneEvent);
  }

  getLatestControlPlaneEventSeq(workspaceId: string): number {
    return this.getControlPlaneReplayState(workspaceId).latestSeq;
  }

  getControlPlaneReplayState(workspaceId: string): ControlPlaneReplayState {
    const row = this.context.database.prepare(`
      SELECT workspace_id, replay_floor_seq, latest_seq, updated_at
      FROM control_plane_replay_state WHERE workspace_id = ?
    `).get(workspaceId) as Record<string, import("node:sqlite").SQLOutputValue> | undefined;
    if (row) {
      return {
        workspaceId: String(row.workspace_id),
        replayFloorSeq: Number(row.replay_floor_seq),
        latestSeq: Number(row.latest_seq),
        updatedAt: String(row.updated_at),
      };
    }
    return { workspaceId, replayFloorSeq: 0, latestSeq: 0, updatedAt: "1970-01-01T00:00:00.000Z" };
  }

  readControlPlaneReplayWindow(input: ReadControlPlaneReplayWindowInput): ControlPlaneReplayWindowResult {
    const state = this.getControlPlaneReplayState(input.workspaceId);
    const requestedAfterSeq = Math.max(input.afterSeq, 0);
    const base = {
      requestedAfterSeq,
      replayFloorSeq: state.replayFloorSeq,
      upperBoundSeq: state.latestSeq,
      nextAfterSeq: state.latestSeq,
    };
    if (requestedAfterSeq > state.latestSeq) {
      return { window: { disposition: "snapshot_required", ...base, reason: "cursor_unavailable" }, events: [] };
    }
    if (requestedAfterSeq < state.replayFloorSeq) {
      return { window: { disposition: "snapshot_required", ...base, reason: "retention_gap" }, events: [] };
    }
    const clauses = ["workspace_id = ?", "seq > ?", "seq <= ?"];
    const params: (string | number)[] = [input.workspaceId, requestedAfterSeq, state.latestSeq];
    addReplayFilters(clauses, params, input);
    const limit = Math.min(Math.max(input.limit, 1), 1000);
    const rows = this.context.database
      .prepare(`${controlPlaneEventSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY seq ASC LIMIT ?`)
      .all(...params, limit + 1)
      .map(mapControlPlaneEvent);
    if (rows.length > limit) {
      return { window: { disposition: "snapshot_required", ...base, reason: "window_exceeded" }, events: [] };
    }
    return { window: { disposition: "complete", ...base }, events: rows };
  }

  private getControlPlaneEvent(seq: number): ControlPlaneEvent | undefined {
    const row = this.context.database.prepare(controlPlaneEventSelectSql("WHERE seq = ?")).get(seq);
    return row ? mapControlPlaneEvent(row) : undefined;
  }
}

function addReplayFilters(
  clauses: string[],
  params: (string | number)[],
  input: ReadControlPlaneReplayWindowInput,
): void {
  if (input.domains && input.domains.length > 0) {
    clauses.push(`domain IN (${input.domains.map(() => "?").join(", ")})`);
    params.push(...input.domains);
  }
  if (input.entityType) {
    clauses.push("entity_type = ?");
    params.push(input.entityType);
  }
  if (input.entityId) {
    clauses.push("entity_id = ?");
    params.push(input.entityId);
  }
  if (input.action) {
    clauses.push("action = ?");
    params.push(input.action);
  }
}

function assertSameControlPlaneEvent(existing: ControlPlaneEvent, input: AppendControlPlaneEventInput): void {
  const data = redactSecrets(input.data ?? {}) as Record<string, unknown>;
  if (existing.cwd !== input.cwd
    || existing.domain !== input.domain
    || existing.entityType !== input.entityType
    || existing.entityId !== input.entityId
    || existing.action !== input.action
    || JSON.stringify(existing.data) !== JSON.stringify(data)) {
    throw new Error(`Control-plane event idempotency conflict: ${input.idempotencyKey}`);
  }
}
