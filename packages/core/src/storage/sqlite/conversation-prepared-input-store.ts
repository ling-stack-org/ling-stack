import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { isConversationContextProjectionMetadata } from "@ling-stack/contracts";
import { conversationPreparedInputUses, type ConversationPreparedInputSnapshot, type ConversationPreparedInputStage,
  type SaveConversationPreparedInput, type SaveConversationPreparedInputResult } from "../../conversation-prepared-input-types.js";
import { redactSecrets } from "../../redaction.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteConversationAcceptedInputStore } from "./conversation-accepted-input-store.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";

type Row = Record<string, SQLOutputValue>;

/** Synchronous first-writer-wins records on the existing context snapshot table. */
export class SqliteConversationPreparedInputStore {
  constructor(private readonly context: SqliteStoreContext, private readonly accepted: SqliteConversationAcceptedInputStore) {}

  save(input: SaveConversationPreparedInput, now: string): SaveConversationPreparedInputResult {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const prepared = readSqliteWithinTransaction(database, () => {
        assertStage(input.stage);
        const accepted = this.accepted.get(input.sourceItemId);
        if (!accepted) throw new Error("Prepared input source has no accepted snapshot");
        const parent = input.stage === "request" ? accepted : this.getWithinTransaction(input.sourceItemId, "request");
        if (!parent || input.parentSnapshotId !== parent.id || input.parentFingerprint !== parent.fingerprint) {
          throw new Error("Prepared input parent mismatch");
        }
        const existing = this.getWithinTransaction(input.sourceItemId, input.stage);
        if (existing) return { snapshot: existing, idempotentReplay: true };
        // Serialize under query_only too: a getter/toJSON must not mutate acceptance.
        const body = JSON.parse(JSON.stringify({
          id: snapshotId(input.sourceItemId, input.stage), schemaVersion: 1, stage: input.stage,
          use: conversationPreparedInputUses[input.stage], workspaceId: accepted.workspaceId,
          threadId: accepted.threadId, turnId: accepted.turnId, sourceItemId: accepted.sourceItemId,
          acceptedSnapshotId: accepted.id, acceptedFingerprint: accepted.fingerprint,
          parentSnapshotId: parent.id, parentFingerprint: parent.fingerprint,
          projection: accepted.projection, payload: input.payload, createdAt: now,
        })) as Record<string, unknown>;
        const snapshot = { ...body, fingerprint: hash(body) };
        assertSnapshot(snapshot);
        return { snapshot: freeze(snapshot), idempotentReplay: false };
      });
      if (!prepared.idempotentReplay) {
        const s = prepared.snapshot;
        const p = s.projection;
        database.prepare(`INSERT INTO conversation_context_snapshots (
          id, workspace_id, thread_id, segment_id, projection_version, through_item_sequence,
          summary_ids_json, source_refs_json, policy_version, created_at,
          snapshot_use, payload_version, source_item_id, payload_json, payload_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          s.id, s.workspaceId, s.threadId, p.segmentId, p.projectionVersion, p.throughItemSequence,
          JSON.stringify(p.summaryIds), JSON.stringify(p.sourceRefs), p.policyVersion, s.createdAt,
          s.use, 1, s.sourceItemId, JSON.stringify(s), s.fingerprint);
      }
      database.exec("COMMIT");
      return prepared;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  get(sourceItemId: string, stage: ConversationPreparedInputStage): ConversationPreparedInputSnapshot | undefined {
    assertStage(stage);
    return readSqliteSnapshot(this.context.database, () => this.getWithinTransaction(sourceItemId, stage));
  }

  private getWithinTransaction(sourceItemId: string, stage: ConversationPreparedInputStage): ConversationPreparedInputSnapshot | undefined {
    // Always inspect the expected primary id, even if its use/source was corrupted.
    const rows = this.context.database.prepare(`SELECT * FROM conversation_context_snapshots
      WHERE id=? OR (source_item_id=? AND snapshot_use=?)`)
      .all(snapshotId(sourceItemId, stage), sourceItemId, conversationPreparedInputUses[stage]) as Row[];
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) throw new Error("Prepared input snapshot has ambiguous ownership");
    try {
      const row = rows[0]!;
      if (row.snapshot_use !== conversationPreparedInputUses[stage] || row.payload_version !== 1 || typeof row.payload_json !== "string") {
        throw new Error("use/version");
      }
      const value: unknown = JSON.parse(row.payload_json);
      assertSnapshot(value);
      const p = value.projection;
      if (value.stage !== stage || value.sourceItemId !== sourceItemId || row.id !== value.id ||
        row.workspace_id !== value.workspaceId || row.thread_id !== value.threadId || row.segment_id !== p.segmentId ||
        row.projection_version !== p.projectionVersion || row.through_item_sequence !== p.throughItemSequence ||
        row.summary_ids_json !== JSON.stringify(p.summaryIds) || row.source_refs_json !== JSON.stringify(p.sourceRefs) ||
        row.policy_version !== p.policyVersion || row.created_at !== value.createdAt ||
        row.source_item_id !== sourceItemId || row.payload_fingerprint !== value.fingerprint) {
        throw new Error("row/envelope mismatch");
      }
      const accepted = this.accepted.get(sourceItemId);
      if (!accepted || value.acceptedSnapshotId !== accepted.id || value.acceptedFingerprint !== accepted.fingerprint ||
        value.threadId !== accepted.threadId || value.turnId !== accepted.turnId ||
        JSON.stringify(p) !== JSON.stringify(accepted.projection)) throw new Error("accepted lineage mismatch");
      const parent = stage === "request" ? accepted : this.getWithinTransaction(sourceItemId, "request");
      if (!parent || value.parentSnapshotId !== parent.id || value.parentFingerprint !== parent.fingerprint) {
        throw new Error("parent lineage mismatch");
      }
      return freeze(value);
    } catch (error) {
      throw new Error("Prepared input snapshot is invalid", { cause: error });
    }
  }
}

function assertStage(value: unknown): asserts value is ConversationPreparedInputStage {
  if (value !== "request" && value !== "execution") throw new TypeError("Invalid prepared input stage");
}
function assertSnapshot(value: unknown): asserts value is ConversationPreparedInputSnapshot {
  if (!record(value)) throw new Error("Invalid prepared input snapshot");
  assertStage(value.stage);
  const keys = ["id", "schemaVersion", "stage", "use", "workspaceId", "threadId", "turnId", "sourceItemId",
    "acceptedSnapshotId", "acceptedFingerprint", "parentSnapshotId", "parentFingerprint", "projection", "payload", "createdAt", "fingerprint"];
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    value.schemaVersion !== 1 || value.use !== conversationPreparedInputUses[value.stage] ||
    value.workspaceId !== DEFAULT_WORKSPACE_ID || typeof value.sourceItemId !== "string" ||
    value.id !== snapshotId(value.sourceItemId, value.stage) ||
    !["threadId", "turnId", "acceptedSnapshotId", "acceptedFingerprint", "parentSnapshotId", "parentFingerprint", "createdAt"]
      .every((key) => typeof value[key] === "string" && value[key].length > 0) ||
    !isConversationContextProjectionMetadata(value.projection) || value.projection.threadId !== value.threadId ||
    value.projection.turnId !== value.turnId || value.payload === undefined) throw new Error("Invalid prepared input snapshot envelope");
  const { fingerprint, ...body } = value;
  if (fingerprint !== hash(body) || JSON.stringify(redactSecrets(value)) !== JSON.stringify(value)) {
    throw new Error("Prepared input snapshot fingerprint or redaction mismatch");
  }
}
function snapshotId(sourceItemId: string, stage: ConversationPreparedInputStage): string {
  return `prepared_input:${stage}:${sourceItemId}`;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
