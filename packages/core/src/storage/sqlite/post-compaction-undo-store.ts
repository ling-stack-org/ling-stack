import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  postCompactionUndoStates,
  type CreatePostCompactionUndoRecordInput,
  type ListPostCompactionUndoRecordsOptions,
  type PostCompactionUndoRecord,
  type UpdatePostCompactionUndoRecordInput,
} from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  parseJson,
  readNumber,
  readString,
  stringifyJson,
} from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class SqlitePostCompactionUndoStore {
  constructor(private readonly context: SqliteStoreContext) {}

  create(input: CreatePostCompactionUndoRecordInput): PostCompactionUndoRecord {
    validateCreateInput(input);
    const workspaceId = normalizeRequired(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "post-compaction undo workspace id");
    const targetRunIds = uniqueRequiredStrings(input.targetRunIds, "post-compaction undo run ids");
    const affectedPaths = uniqueRequiredStrings(input.affectedPaths, "post-compaction undo paths");
    const existing = this.getByIdempotency(workspaceId, input.idempotencyKey);
    if (existing) {
      if (existing.threadId !== input.threadId || existing.targetTurnId !== input.targetTurnId || existing.action !== input.action) {
        throw new Error(`Post-compaction undo idempotency key is bound to another target: ${input.idempotencyKey}`);
      }
      return existing;
    }
    const record: PostCompactionUndoRecord = {
      id: input.id ?? `post_compaction_undo_${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      workspaceId,
      threadId: input.threadId,
      targetTurnId: input.targetTurnId,
      targetRunIds,
      ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
      expectedWorkspaceFingerprint: input.expectedWorkspaceFingerprint,
      action: input.action,
      state: input.state ?? "validating",
      affectedPaths,
      lastEventSeq: input.lastEventSeq ?? 0,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt ?? input.createdAt,
    };
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      assertReferences(this.context, record);
      this.context.database.prepare(`
        INSERT INTO post_compaction_undo_records (
          id, idempotency_key, workspace_id, thread_id, target_turn_id,
          target_run_ids_json, checkpoint_id, expected_workspace_fingerprint,
          action, state, affected_paths_json, last_event_seq, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.idempotencyKey,
        record.workspaceId,
        record.threadId,
        record.targetTurnId,
        stringifyJson(record.targetRunIds),
        record.checkpointId ?? null,
        record.expectedWorkspaceFingerprint,
        record.action,
        record.state,
        stringifyJson(record.affectedPaths),
        record.lastEventSeq,
        record.createdAt,
        record.updatedAt,
      );
      this.context.database.exec("COMMIT");
      return record;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      const replay = this.getByIdempotency(workspaceId, input.idempotencyKey);
      if (replay) return replay;
      throw error;
    }
  }

  get(id: string): PostCompactionUndoRecord | undefined {
    const row = this.context.database.prepare(`${selectSql} WHERE id = ?`).get(id);
    return row ? mapRecord(row as Record<string, SQLOutputValue>) : undefined;
  }

  getByIdempotency(workspaceId: string, idempotencyKey: string): PostCompactionUndoRecord | undefined {
    const row = this.context.database.prepare(`${selectSql} WHERE workspace_id = ? AND idempotency_key = ?`).get(workspaceId, idempotencyKey);
    return row ? mapRecord(row as Record<string, SQLOutputValue>) : undefined;
  }

  list(options: ListPostCompactionUndoRecordsOptions = {}): PostCompactionUndoRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ["workspace_id", options.workspaceId],
      ["thread_id", options.threadId],
      ["target_turn_id", options.targetTurnId],
      ["idempotency_key", options.idempotencyKey],
    ] as const) {
      if (value) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    params.push(Math.min(Math.max(options.limit ?? 100, 1), 1_000));
    return this.context.database.prepare(`
      ${selectSql}
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params).map((row) => mapRecord(row as Record<string, SQLOutputValue>));
  }

  update(input: UpdatePostCompactionUndoRecordInput): PostCompactionUndoRecord | undefined {
    validateUpdateInput(input);
    const result = this.context.database.prepare(`
      UPDATE post_compaction_undo_records
      SET state = ?, last_event_seq = ?, updated_at = ?
      WHERE id = ? AND state = ?
    `).run(input.state, input.lastEventSeq, input.updatedAt, input.id, input.expectedState);
    if (Number(result.changes) !== 1) return undefined;
    return this.get(input.id);
  }
}

const selectSql = `
  SELECT id, idempotency_key, workspace_id, thread_id, target_turn_id,
    target_run_ids_json, checkpoint_id, expected_workspace_fingerprint,
    action, state, affected_paths_json, last_event_seq, created_at, updated_at
  FROM post_compaction_undo_records
`;

function mapRecord(row: Record<string, SQLOutputValue>): PostCompactionUndoRecord {
  const targetRunIds = parseStringArray(readString(row, "target_run_ids_json"), "target_run_ids_json");
  const affectedPaths = parseStringArray(readString(row, "affected_paths_json"), "affected_paths_json");
  const checkpointId = row.checkpoint_id;
  return {
    id: readString(row, "id"),
    idempotencyKey: readString(row, "idempotency_key"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    targetTurnId: readString(row, "target_turn_id"),
    targetRunIds,
    ...(typeof checkpointId === "string" && checkpointId ? { checkpointId } : {}),
    expectedWorkspaceFingerprint: readString(row, "expected_workspace_fingerprint"),
    action: readString(row, "action") as PostCompactionUndoRecord["action"],
    state: readString(row, "state") as PostCompactionUndoRecord["state"],
    affectedPaths,
    lastEventSeq: readNumber(row, "last_event_seq"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function assertReferences(context: SqliteStoreContext, record: PostCompactionUndoRecord): void {
  const turn = context.database.prepare("SELECT workspace_id, thread_id FROM ling_turns WHERE id = ?").get(record.targetTurnId) as Record<string, SQLOutputValue> | undefined;
  if (!turn || readString(turn, "thread_id") !== record.threadId) throw new Error(`Post-compaction undo target Turn does not belong to thread: ${record.targetTurnId}`);
  if (readString(turn, "workspace_id") !== record.workspaceId) throw new Error(`Post-compaction undo target Turn does not belong to workspace: ${record.targetTurnId}`);
  const linkedRuns = context.database.prepare(`
    SELECT COUNT(*) AS count
    FROM ling_turn_runs
    WHERE turn_id = ? AND run_id IN (${record.targetRunIds.map(() => "?").join(",")})
  `).get(record.targetTurnId, ...record.targetRunIds) as Record<string, SQLOutputValue>;
  if (readNumber(linkedRuns, "count") !== record.targetRunIds.length) throw new Error("Post-compaction undo target Runs are not all linked to the target Turn.");
  if (record.checkpointId) {
    const checkpoint = context.database.prepare("SELECT workspace_id, thread_id, source_turn_id, covered_turn_ids_json FROM compaction_checkpoints WHERE id = ?").get(record.checkpointId) as Record<string, SQLOutputValue> | undefined;
    const coversTargetTurn = checkpoint
      ? readString(checkpoint, "source_turn_id") === record.targetTurnId
        || parseStringArray(readString(checkpoint, "covered_turn_ids_json"), "covered_turn_ids_json").includes(record.targetTurnId)
      : false;
    if (!checkpoint || readString(checkpoint, "workspace_id") !== record.workspaceId || readString(checkpoint, "thread_id") !== record.threadId || !coversTargetTurn) {
      throw new Error(`Post-compaction undo checkpoint does not match target Turn: ${record.checkpointId}`);
    }
  }
}

function validateCreateInput(input: CreatePostCompactionUndoRecordInput): void {
  normalizeRequired(input.idempotencyKey, "post-compaction undo idempotency key");
  normalizeRequired(input.threadId, "post-compaction undo thread id");
  normalizeRequired(input.targetTurnId, "post-compaction undo target Turn id");
  normalizeRequired(input.expectedWorkspaceFingerprint, "post-compaction undo workspace fingerprint");
  if (input.action !== "undo" && input.action !== "reapply") throw new Error(`Invalid post-compaction undo action: ${input.action}`);
  if (input.state && !postCompactionUndoStates.includes(input.state)) throw new Error(`Invalid post-compaction undo state: ${input.state}`);
  uniqueRequiredStrings(input.targetRunIds, "post-compaction undo run ids");
  uniqueRequiredStrings(input.affectedPaths, "post-compaction undo paths");
  if (input.lastEventSeq !== undefined && (!Number.isSafeInteger(input.lastEventSeq) || input.lastEventSeq < 0)) throw new RangeError("Invalid post-compaction undo event sequence.");
  assertTimestamp(input.createdAt);
  if (input.updatedAt) assertTimestamp(input.updatedAt);
}

function validateUpdateInput(input: UpdatePostCompactionUndoRecordInput): void {
  normalizeRequired(input.id, "post-compaction undo record id");
  if (!postCompactionUndoStates.includes(input.expectedState) || !postCompactionUndoStates.includes(input.state)) throw new Error("Invalid post-compaction undo state transition.");
  if (!allowedPostCompactionUndoTransitions[input.expectedState].includes(input.state)) {
    throw new Error(`Illegal post-compaction undo transition: ${input.expectedState} -> ${input.state}`);
  }
  if (!Number.isSafeInteger(input.lastEventSeq) || input.lastEventSeq < 0) throw new RangeError("Invalid post-compaction undo event sequence.");
  assertTimestamp(input.updatedAt);
}

const allowedPostCompactionUndoTransitions: Readonly<Record<PostCompactionUndoRecord["state"], readonly PostCompactionUndoRecord["state"][]>> = {
  available: ["validating", "conflict", "provenance_missing", "snapshot_unverified", "expired", "failed"],
  validating: ["validating", "applied", "undone", "conflict", "provenance_missing", "snapshot_unverified", "expired", "failed"],
  applied: [],
  undone: [],
  conflict: [],
  provenance_missing: [],
  snapshot_unverified: [],
  expired: [],
  failed: [],
};

function parseStringArray(value: string, key: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new Error(`Invalid string list in ${key}`);
  return parsed;
}

function uniqueRequiredStrings(values: readonly string[], label: string): string[] {
  if (values.length === 0) throw new Error(`${label} must not be empty.`);
  const result = [...new Set(values.map((value) => normalizeRequired(value, label)))];
  if (result.length !== values.length) throw new Error(`${label} must not contain duplicates.`);
  return result;
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function assertTimestamp(value: string): void {
  if (!canonicalTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`Timestamp must be canonical UTC: ${value}`);
}
