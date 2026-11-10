import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { isConversationContextProjectionMetadata } from "@ling-stack/contracts";
import type { AppendTeammateDirectInput, AppendTeammateDirectInputResult, TeammateDirectInputSnapshot } from "../../teammate-direct-input-types.js";
import { redactSecrets } from "../../redaction.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteConversationTurnIngestStore } from "./conversation-turn-ingest-store.js";

const USE = "teammate_direct_execution_input";
const VERSION = "teammate-direct-input-v1";
type Row = Record<string, SQLOutputValue>;

/** Atomically freezes the private input actually prepared for a Run; no normal-scope bypass. */
export class SqliteTeammateDirectInputStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ingest: SqliteConversationTurnIngestStore) {}

  append(input: AppendTeammateDirectInput, now: string): AppendTeammateDirectInputResult {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const accepted = this.ingest.appendUserTurnWithinTransaction(input, now);
      this.assertSource(accepted.item.id, input.teammateId, input.threadId, accepted.turnId, accepted.item.sequence);
      let snapshot: TeammateDirectInputSnapshot;
      if (accepted.idempotentReplay) {
        const previous = readSqliteWithinTransaction(database, () => this.get(accepted.item.id, input.teammateId));
        if (!previous) throw new Error("Private input snapshot is missing; cannot recapture historical input");
        snapshot = previous;
      } else {
        snapshot = readSqliteWithinTransaction(database, () => {
          const executionInput: unknown = JSON.parse(JSON.stringify(input.executionInput));
          assertExecutionInput(executionInput);
          const body = JSON.parse(JSON.stringify({
            id: snapshotId(accepted.item.id), schemaVersion: 1, use: USE,
            workspaceId: accepted.item.workspaceId, threadId: input.threadId,
            turnId: accepted.turnId, sourceItemId: accepted.item.id, teammateId: input.teammateId,
            projection: {
              threadId: input.threadId, turnId: accepted.turnId, segmentId: accepted.contextSegmentId,
              projectionVersion: VERSION, throughItemSequence: accepted.item.sequence, summaryIds: [],
              sourceRefs: [{ type: "thread", id: input.threadId }, { type: "turn", id: accepted.turnId },
                { type: "conversation_item", id: accepted.item.id }],
              policyVersion: VERSION,
              sourceStateFingerprint: sourceFingerprint(accepted.item.id, accepted.item.sequence,
                accepted.contextSegmentId, executionInput),
              visibilityFingerprint: visibilityFingerprint(accepted.item.workspaceId, input.threadId, input.teammateId),
            },
            payload: executionInput, createdAt: now,
          })) as Record<string, unknown>;
          const value = { ...body, fingerprint: fingerprint(body) };
          assertSnapshot(value);
          return freeze(value);
        });
        const p = snapshot.projection;
        database.prepare(`INSERT INTO conversation_context_snapshots (
          id, workspace_id, thread_id, segment_id, projection_version, through_item_sequence,
          summary_ids_json, source_refs_json, policy_version, created_at,
          snapshot_use, payload_version, source_item_id, payload_json, payload_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          snapshot.id, snapshot.workspaceId, snapshot.threadId, p.segmentId, p.projectionVersion, p.throughItemSequence,
          JSON.stringify(p.summaryIds), JSON.stringify(p.sourceRefs), p.policyVersion, snapshot.createdAt,
          USE, 1, snapshot.sourceItemId, JSON.stringify(snapshot), snapshot.fingerprint,
        );
      }
      database.exec("COMMIT");
      return { ...accepted, inputSnapshot: snapshot };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Read and validate durable private evidence; never reconstruct a missing record. */
  get(sourceItemId: string, teammateId: string): TeammateDirectInputSnapshot | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const row = this.context.database.prepare(`SELECT * FROM conversation_context_snapshots
        WHERE id=? AND snapshot_use=? AND source_item_id=?`).get(snapshotId(sourceItemId), USE, sourceItemId) as Row | undefined;
      if (!row) return undefined;
      const value: unknown = JSON.parse(String(row.payload_json));
      assertSnapshot(value);
      const p = value.projection;
      if (value.sourceItemId !== sourceItemId || value.teammateId !== teammateId || row.workspace_id !== value.workspaceId ||
        row.thread_id !== value.threadId || row.segment_id !== p.segmentId || row.projection_version !== p.projectionVersion ||
        row.through_item_sequence !== p.throughItemSequence || row.policy_version !== p.policyVersion ||
        row.created_at !== value.createdAt || row.payload_fingerprint !== value.fingerprint || row.payload_version !== 1 ||
        row.summary_ids_json !== JSON.stringify(p.summaryIds) || row.source_refs_json !== JSON.stringify(p.sourceRefs)) {
        throw new Error("Private input snapshot row or owner mismatch");
      }
      this.assertSource(sourceItemId, teammateId, value.threadId, value.turnId, p.throughItemSequence);
      return freeze(value);
    });
  }

  private assertSource(itemId: string, teammateId: string, threadId: string, turnId: string, sequence: number): void {
    const source = this.context.database.prepare(`SELECT i.workspace_id, i.thread_id, i.turn_id, i.kind,
      i.actor_type, i.channel_id, i.status, i.sequence, i.visibility, i.visibility_owner_id,
      t.kind AS thread_kind, t.teammate_id, t.workspace_id AS thread_workspace_id, t.channel_id AS thread_channel_id,
      u.source_item_id, u.thread_id AS turn_thread_id, u.workspace_id AS turn_workspace_id,
      u.channel_id AS turn_channel_id, u.teammate_id AS turn_teammate_id, u.created_by_actor
      FROM conversation_items i JOIN ling_threads t ON t.id=i.thread_id JOIN ling_turns u ON u.id=i.turn_id
      WHERE i.id=?`).get(itemId) as Row | undefined;
    if (!source || !teammateId || source.workspace_id !== DEFAULT_WORKSPACE_ID || source.thread_id !== threadId ||
      source.turn_id !== turnId || source.kind !== "user_message" || source.status !== "committed" ||
      !((source.actor_type === "local_user" && source.created_by_actor === "local-user") ||
        (source.actor_type === "system" && source.created_by_actor === "system")) ||
      source.channel_id !== null || source.visibility !== "agent_private" || source.visibility_owner_id !== teammateId ||
      source.thread_kind !== "teammate_direct" || source.teammate_id !== teammateId || source.thread_channel_id !== null ||
      source.thread_workspace_id !== DEFAULT_WORKSPACE_ID || source.turn_thread_id !== threadId ||
      source.turn_workspace_id !== DEFAULT_WORKSPACE_ID || source.turn_channel_id !== null ||
      source.turn_teammate_id !== teammateId || source.source_item_id !== itemId || source.sequence !== sequence) {
      throw new Error("Private input snapshot source scope mismatch");
    }
  }
}

function assertSnapshot(value: unknown): asserts value is TeammateDirectInputSnapshot {
  if (!record(value) || Object.keys(value).sort().join(",") !==
    ["id", "schemaVersion", "use", "workspaceId", "threadId", "turnId", "sourceItemId", "teammateId", "projection", "payload", "createdAt", "fingerprint"].sort().join(",") ||
    value.schemaVersion !== 1 || value.use !== USE || value.workspaceId !== DEFAULT_WORKSPACE_ID ||
    typeof value.sourceItemId !== "string" || value.id !== snapshotId(value.sourceItemId) || typeof value.teammateId !== "string" ||
    typeof value.threadId !== "string" || typeof value.turnId !== "string" || typeof value.createdAt !== "string" ||
    !isConversationContextProjectionMetadata(value.projection) || value.projection.threadId !== value.threadId ||
    value.projection.turnId !== value.turnId || value.projection.projectionVersion !== VERSION || value.projection.policyVersion !== VERSION ||
    !record(value.payload) || Object.keys(value.payload).sort().join(",") !== "prompt,systemPrompt" ||
    typeof value.payload.prompt !== "string" || typeof value.payload.systemPrompt !== "string") {
    throw new Error("Invalid private input snapshot envelope");
  }
  const { fingerprint: stored, ...body } = value;
  const p = value.projection;
  if (p.sourceStateFingerprint !== sourceFingerprint(value.sourceItemId, p.throughItemSequence, p.segmentId,
    { prompt: value.payload.prompt, systemPrompt: value.payload.systemPrompt }) ||
    p.visibilityFingerprint !== visibilityFingerprint(value.workspaceId, value.threadId, value.teammateId) ||
    JSON.stringify(p.sourceRefs) !== JSON.stringify([{ type: "thread", id: value.threadId },
      { type: "turn", id: value.turnId }, { type: "conversation_item", id: value.sourceItemId }]) || p.summaryIds.length !== 0 ||
    stored !== fingerprint(body) || JSON.stringify(redactSecrets(value)) !== JSON.stringify(value)) {
    throw new Error("Private input snapshot fingerprint or redaction mismatch");
  }
}
function snapshotId(sourceItemId: string): string { return `teammate_direct_input:${sourceItemId}`; }
function assertExecutionInput(value: unknown): asserts value is TeammateDirectInputSnapshot["payload"] {
  if (!record(value) || Object.keys(value).sort().join(",") !== "prompt,systemPrompt" ||
    typeof value.prompt !== "string" || typeof value.systemPrompt !== "string") {
    throw new Error("Invalid private execution input payload");
  }
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sourceFingerprint(sourceItemId: string, sequence: number, segmentId: string, input: TeammateDirectInputSnapshot["payload"]): string {
  return fingerprint({ sourceItemId, sequence, segmentId, prompt: input.prompt, systemPrompt: input.systemPrompt });
}
function visibilityFingerprint(workspaceId: string, threadId: string, teammateId: string): string {
  return fingerprint({ workspaceId, threadId, visibility: "agent_private", visibilityOwnerId: teammateId });
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
