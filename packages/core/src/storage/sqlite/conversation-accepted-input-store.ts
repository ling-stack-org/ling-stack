import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { isConversationContextProjectionMetadata } from "@ling-stack/contracts";
import type { AppendConversationAcceptedInput, AppendConversationAcceptedInputResult, CaptureConversationAcceptedInput,
  ConversationAcceptedInputSnapshot } from "../../conversation-accepted-input-types.js";
import type { AppendConversationUserTurnResult } from "../../conversation-turn-ingest-types.js";
import { redactSecrets } from "../../redaction.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteConversationTurnIngestStore } from "./conversation-turn-ingest-store.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import { conversationPreparedInputUses } from "../../conversation-prepared-input-types.js";

const USE = "normal_conversation_accepted_input";
type Row = Record<string, SQLOutputValue>;

/** Owns the single synchronous input-acceptance transaction; payload hydration stays in daemon. */
export class SqliteConversationAcceptedInputStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ingest: SqliteConversationTurnIngestStore) {}

  append(input: AppendConversationAcceptedInput, capture: CaptureConversationAcceptedInput, now: string): AppendConversationAcceptedInputResult {
    if (Object.prototype.toString.call(capture) === "[object AsyncFunction]") throw new TypeError("Accepted snapshot callback must be synchronous");
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.ingest.appendUserTurnWithinTransaction(input, now);
      this.assertSource(result.item.id, input.threadId, result.turnId);
      this.bindAttachments(input, result);
      let snapshot: ConversationAcceptedInputSnapshot;
      if (result.idempotentReplay) {
        const stored = this.get(result.item.id);
        if (!stored) throw new Error("Accepted input snapshot is missing; cannot recapture accepted history");
        snapshot = stored;
      } else {
        // Serialization and redaction checks stay guarded too (toJSON/getters must not write).
        snapshot = readSqliteWithinTransaction(database, () => {
          const captured = capture(result);
          if (captured && typeof Reflect.get(captured, "then") === "function") throw new TypeError("Accepted snapshot callback must be synchronous");
          const body = JSON.parse(JSON.stringify({ id: snapshotId(result.item.id), schemaVersion: 1, use: USE,
            workspaceId: DEFAULT_WORKSPACE_ID, threadId: input.threadId, turnId: result.turnId, sourceItemId: result.item.id,
            projection: captured.projection, payload: captured.payload, createdAt: now })) as Record<string, unknown>;
          const value = { ...body, fingerprint: hash(body) };
          assertSnapshot(value);
          if (value.projection.segmentId !== result.contextSegmentId || value.projection.throughItemSequence !== result.item.sequence) {
            throw new Error("Accepted input snapshot projection boundary mismatch");
          }
          this.assertSource(value.sourceItemId, value.threadId, value.turnId);
          return freeze(value);
        });
        const p = snapshot.projection;
        database.prepare(`INSERT INTO conversation_context_snapshots (
          id, workspace_id, thread_id, segment_id, projection_version, through_item_sequence,
          summary_ids_json, source_refs_json, policy_version, created_at,
          snapshot_use, payload_version, source_item_id, payload_json, payload_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          snapshot.id, snapshot.workspaceId, snapshot.threadId, p.segmentId, p.projectionVersion, p.throughItemSequence,
          JSON.stringify(p.summaryIds), JSON.stringify(p.sourceRefs), p.policyVersion, now,
          USE, 1, snapshot.sourceItemId, JSON.stringify(snapshot), snapshot.fingerprint);
      }
      database.exec("COMMIT");
      return { ...result, acceptedSnapshot: snapshot };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Missing is distinguishable for strictly bounded legacy-Run recovery; malformed rows never are. */
  get(sourceItemId: string): ConversationAcceptedInputSnapshot | undefined {
    const rows = this.context.database.prepare(`SELECT * FROM conversation_context_snapshots
      WHERE id = ? OR (source_item_id = ? AND snapshot_use NOT IN (?, ?))`)
      .all(snapshotId(sourceItemId), sourceItemId, conversationPreparedInputUses.request, conversationPreparedInputUses.execution) as Row[];
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) throw new Error("Accepted input snapshot has ambiguous ownership");
    try {
      const row = rows[0]!;
      if (row.snapshot_use !== USE || row.payload_version !== 1 || typeof row.payload_json !== "string") throw new Error("use/version");
      const value: unknown = JSON.parse(row.payload_json);
      assertSnapshot(value);
      const p = value.projection;
      if (value.sourceItemId !== sourceItemId || row.id !== value.id || row.workspace_id !== value.workspaceId ||
        row.thread_id !== value.threadId || row.segment_id !== p.segmentId || row.projection_version !== p.projectionVersion ||
        row.through_item_sequence !== p.throughItemSequence || row.summary_ids_json !== JSON.stringify(p.summaryIds) ||
        row.source_refs_json !== JSON.stringify(p.sourceRefs) || row.policy_version !== p.policyVersion ||
        row.created_at !== value.createdAt || row.source_item_id !== value.sourceItemId || row.payload_fingerprint !== value.fingerprint) {
        throw new Error("row/envelope mismatch");
      }
      this.assertSource(sourceItemId, value.threadId, value.turnId, p.throughItemSequence);
      const segment = this.context.database.prepare("SELECT thread_id, workspace_id FROM context_segments WHERE id=?").get(p.segmentId);
      if (segment?.thread_id !== value.threadId || segment.workspace_id !== value.workspaceId) throw new Error("segment scope");
      return freeze(value);
    } catch (error) {
      throw new Error("Accepted input snapshot is invalid", { cause: error });
    }
  }

  private assertSource(itemId: string, threadId: string, turnId: string, sequence?: number): void {
    const source = this.context.database.prepare(`SELECT i.workspace_id, i.thread_id, i.turn_id, i.kind,
      i.actor_type, i.channel_id, i.status, i.sequence, i.visibility, i.visibility_owner_id, t.kind AS thread_kind, t.teammate_id,
      t.workspace_id AS thread_workspace_id, t.channel_id AS thread_channel_id,
      u.source_item_id, u.thread_id AS turn_thread_id, u.workspace_id AS turn_workspace_id,
      u.channel_id AS turn_channel_id, u.teammate_id AS turn_teammate_id, u.created_by_actor
      FROM conversation_items i JOIN ling_threads t ON t.id=i.thread_id JOIN ling_turns u ON u.id=i.turn_id
      WHERE i.id=?`).get(itemId) as Row | undefined;
    if (!source || source.workspace_id !== DEFAULT_WORKSPACE_ID || source.thread_id !== threadId || source.turn_id !== turnId ||
      source.kind !== "user_message" || !((source.actor_type === "local_user" && source.created_by_actor === "local-user") ||
        (source.actor_type === "system" && source.created_by_actor === "system")) || source.channel_id !== null ||
      source.visibility !== "thread_participants" || source.visibility_owner_id !== null ||
      source.status !== "committed" || source.thread_kind !== "conversation" || source.turn_thread_id !== threadId ||
      source.thread_workspace_id !== DEFAULT_WORKSPACE_ID || source.turn_workspace_id !== DEFAULT_WORKSPACE_ID ||
      source.thread_channel_id !== null || source.turn_channel_id !== null ||
      (source.turn_teammate_id !== null && source.turn_teammate_id !== "ling_agent") ||
      source.source_item_id !== itemId || (source.teammate_id !== null && source.teammate_id !== "ling_agent") ||
      (sequence !== undefined && source.sequence !== sequence)) throw new Error("Accepted input snapshot source scope mismatch");
  }

  private bindAttachments(input: AppendConversationAcceptedInput, result: AppendConversationUserTurnResult): void {
    const { database } = this.context;
    for (const id of new Set(input.payload.attachmentIds)) {
      const row = database.prepare("SELECT workspace_id, thread_id, turn_id FROM conversation_attachments WHERE id=?").get(id);
      if (!row || row.workspace_id !== DEFAULT_WORKSPACE_ID || (row.thread_id !== null && row.thread_id !== input.threadId)) {
        throw new Error(`Conversation attachment not found or thread mismatch: ${id}`);
      }
      if (row.turn_id !== null && row.turn_id !== result.turnId) {
        const source = input.replacementSourceTurnId && input.replacementSourceTurnId === input.sourceTurnId
          ? database.prepare(`SELECT i.payload_json FROM ling_turns t JOIN conversation_items i ON i.id=t.source_item_id
            WHERE t.id=? AND t.thread_id=? AND i.turn_id=t.id AND i.kind='user_message'`).get(input.replacementSourceTurnId, input.threadId) : undefined;
        const payload: unknown = source && typeof source.payload_json === "string" ? JSON.parse(source.payload_json) : undefined;
        if (row.turn_id !== input.replacementSourceTurnId || !record(payload) || !Array.isArray(payload.attachmentIds) || !payload.attachmentIds.includes(id)) {
          throw new Error(`Conversation attachment was already used: ${id}`);
        }
        continue; // Editing references the old attachment, never reassigns its historical owner.
      }
      const update = database.prepare(`UPDATE conversation_attachments SET thread_id=?, turn_id=?
        WHERE id=? AND workspace_id=? AND (thread_id IS NULL OR thread_id=?) AND (turn_id IS NULL OR turn_id=?)`)
        .run(input.threadId, result.turnId, id, DEFAULT_WORKSPACE_ID, input.threadId, result.turnId);
      if (Number(update.changes) !== 1) throw new Error(`Conversation attachment ownership conflict: ${id}`);
    }
  }
}

function assertSnapshot(value: unknown): asserts value is ConversationAcceptedInputSnapshot {
  if (!record(value) || Object.keys(value).sort().join(",") !==
    ["id", "schemaVersion", "use", "workspaceId", "threadId", "turnId", "sourceItemId", "projection", "payload", "createdAt", "fingerprint"].sort().join(",") ||
    value.schemaVersion !== 1 || value.use !== USE || value.workspaceId !== DEFAULT_WORKSPACE_ID ||
    typeof value.sourceItemId !== "string" || value.id !== snapshotId(value.sourceItemId) ||
    typeof value.threadId !== "string" || typeof value.turnId !== "string" || typeof value.createdAt !== "string" ||
    !isConversationContextProjectionMetadata(value.projection) || value.projection.threadId !== value.threadId ||
    value.projection.turnId !== value.turnId || value.payload === undefined) throw new Error("Invalid accepted input snapshot envelope");
  const { fingerprint, ...body } = value;
  if (fingerprint !== hash(body) || JSON.stringify(redactSecrets(value)) !== JSON.stringify(value)) {
    throw new Error("Accepted input snapshot fingerprint or redaction mismatch");
  }
}
function snapshotId(sourceItemId: string): string { return `accepted_input:${sourceItemId}`; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
