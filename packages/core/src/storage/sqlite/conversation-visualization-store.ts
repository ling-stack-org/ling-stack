import { createHash } from "node:crypto";
import { CONVERSATION_VISUALIZATION_MAX_BYTES, CONVERSATION_VISUALIZATION_MAX_HEIGHT, CONVERSATION_VISUALIZATION_MAX_PER_RUN,
  REMOTE_VISUALIZATION_CHUNK_BYTES, normalizeConversationVisualization } from "@ling-stack/contracts";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { SavedConversationVisualization, SavedConversationVisualizationChunk,
  SaveConversationVisualization, SaveConversationVisualizationResult } from "../../conversation-visualization-types.js";
import type { RunStore } from "../../run-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteRunStoreMigrationContext } from "./migrations.js";

const initialVersion = 238;
const documentLimitsVersion = 239;

export function applyConversationVisualizationMigration({ database, hasMigration, recordMigration }:
  Pick<SqliteRunStoreMigrationContext, "database" | "hasMigration" | "recordMigration">): void {
  if (hasMigration(documentLimitsVersion)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (hasMigration(documentLimitsVersion)) {
      database.exec("COMMIT");
      return;
    }
    const extendingExistingTable = hasMigration(initialVersion);
    if (extendingExistingTable) {
      database.exec("ALTER TABLE conversation_visualizations RENAME TO conversation_visualizations_pre_limits");
    } else {
      recordMigration(initialVersion, "conversation_visualizations");
    }
    createVisualizationTable(database);
    if (extendingExistingTable) database.exec(`
      INSERT INTO conversation_visualizations (
        id, run_id, thread_id, turn_id, workspace_id, message_id, title, summary, html, sha256,
        input_sha256, layout, interaction, preferred_height, created_at
      ) SELECT id, run_id, thread_id, turn_id, workspace_id, message_id, title, summary, html, sha256,
        input_sha256, layout, interaction, preferred_height, created_at FROM conversation_visualizations_pre_limits;
      DROP TABLE conversation_visualizations_pre_limits;
    `);
    database.exec("CREATE INDEX idx_conversation_visualizations_run ON conversation_visualizations(run_id)");
    recordMigration(documentLimitsVersion, "conversation_visualization_document_limits");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}

function createVisualizationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE conversation_visualizations (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES ling_threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES ling_turns(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      html BLOB NOT NULL CHECK(length(html) BETWEEN 1 AND ${CONVERSATION_VISUALIZATION_MAX_BYTES}),
      sha256 TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      layout TEXT NOT NULL CHECK(layout IN ('standard', 'wide')),
      interaction TEXT NOT NULL CHECK(interaction IN ('native', 'script')),
      preferred_height INTEGER NOT NULL CHECK(preferred_height BETWEEN 160 AND ${CONVERSATION_VISUALIZATION_MAX_HEIGHT}),
      created_at TEXT NOT NULL
    );
  `);
}

type Ports = Pick<RunStore, "isCurrentRunExecutionOwner" | "getRun" | "getLingThread" | "getLingTurnForRun" |
  "getEffectiveConversationItem" | "getTeammateDirectMessage">;

export function saveConversationVisualization(database: DatabaseSync, store: Ports,
  input: SaveConversationVisualization): SaveConversationVisualizationResult {
  const document = normalizeConversationVisualization(input.document);
  if (!document || !input.toolCallId || input.toolCallId.length > 256 || /[\p{Cc}\p{Cs}]/u.test(input.toolCallId)) {
    return { ok: false, code: "visualization_invalid" };
  }
  const artifactId = "viz_" + digest(JSON.stringify([input.runId, input.toolCallId])).slice(0, 32);
  const content = Buffer.from(document.html, "utf8");
  const sha256 = digest(content);
  const fingerprint = digest(JSON.stringify([sha256, document.title, document.summary, document.layout, document.interaction, document.preferredHeight]));
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = persist(document);
    database.exec(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }

  function persist(document: SaveConversationVisualization["document"]): SaveConversationVisualizationResult {
    if (!store.isCurrentRunExecutionOwner(input.runId, input.fence)) return { ok: false, code: "visualization_owner_changed" };
    const run = store.getRun(input.runId);
    const thread = run?.threadId && store.getLingThread(run.threadId);
    const turn = store.getLingTurnForRun(input.runId);
    if (!run || run.status !== "running" || run.workflowStepId || !thread || !turn
      || turn.threadId !== thread.id || turn.workspaceId !== thread.workspaceId || turn.status === "superseded") {
      return { ok: false, code: "visualization_owner_changed" };
    }
    const linkedMessageId: unknown = run.requestSnapshot && typeof run.requestSnapshot === "object"
      ? Reflect.get(run.requestSnapshot, "linkedMessageId") : undefined;
    const messageId = thread.kind === "conversation" ? "narration:" + run.id
      : typeof linkedMessageId === "string" ? linkedMessageId : undefined;
    if (!messageId) return { ok: false, code: "visualization_owner_changed" };
    if (thread.kind === "teammate_direct") {
      const message = store.getTeammateDirectMessage(messageId);
      if (!message || message.status !== "pending" || message.authorType !== "ai-teammate" || message.workspaceId !== thread.workspaceId
        || message.teammateId !== thread.teammateId || run.teammateId !== message.teammateId || (message.linkedRunId && message.linkedRunId !== run.id)) {
        return { ok: false, code: "visualization_owner_changed" };
      }
    } else if (thread.kind === "channel_discussion") {
      const item = store.getEffectiveConversationItem(messageId);
      if (!item || item.id !== messageId || item.kind !== "assistant_message" || item.status !== "pending"
        || item.threadId !== thread.id || item.turnId !== turn.id || item.workspaceId !== thread.workspaceId
        || item.actorId !== run.teammateId || item.channelId !== thread.channelId) {
        return { ok: false, code: "visualization_owner_changed" };
      }
    } else if (thread.kind !== "conversation") {
      return { ok: false, code: "visualization_owner_changed" };
    }
    const existing = database.prepare("SELECT run_id, message_id, input_sha256 FROM conversation_visualizations WHERE id=?").get(artifactId);
    if (existing) {
      return existing.run_id === run.id && existing.message_id === messageId && existing.input_sha256 === fingerprint
        ? { ok: true, artifactId } : { ok: false, code: "visualization_conflict" };
    }
    const count = database.prepare("SELECT count(*) AS count FROM conversation_visualizations WHERE run_id=?").get(run.id)?.count;
    if (Number(count) >= CONVERSATION_VISUALIZATION_MAX_PER_RUN) return { ok: false, code: "visualization_limit" };
    database.prepare(`INSERT INTO conversation_visualizations
      (id, run_id, thread_id, turn_id, workspace_id, message_id, title, summary, html, sha256, input_sha256, layout, interaction, preferred_height, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(artifactId, run.id, thread.id, turn.id, thread.workspaceId,
      messageId, document.title, document.summary, content, sha256, fingerprint, document.layout, document.interaction, document.preferredHeight, input.now);
    return { ok: true, artifactId };
  }
}

export function getConversationVisualization(database: DatabaseSync, id: string): SavedConversationVisualization | undefined {
  const row = database.prepare("SELECT * FROM conversation_visualizations WHERE id=?").get(id);
  if (!row || !(row.html instanceof Uint8Array) || row.html.byteLength > CONVERSATION_VISUALIZATION_MAX_BYTES) return undefined;
  if (digest(row.html) !== row.sha256) return undefined;
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(row.html); } catch { return undefined; }
  const document = normalizeConversationVisualization({ title: row.title, summary: row.summary, html,
    layout: row.layout, interaction: row.interaction, preferredHeight: row.preferred_height });
  if (!document) return undefined;
  return { ...document, ...visualizationOwnership(row), artifactId: id, sizeBytes: row.html.byteLength, sha256: String(row.sha256) };
}

export function getConversationVisualizationChunk(database: DatabaseSync, id: string, offset: number): SavedConversationVisualizationChunk | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= CONVERSATION_VISUALIZATION_MAX_BYTES) return undefined;
  const row = database.prepare(`SELECT run_id, thread_id, turn_id, workspace_id, message_id,
      title, summary, sha256, layout, interaction, preferred_height, length(html) AS size_bytes,
      substr(html, ?, ?) AS bytes
    FROM conversation_visualizations WHERE id = ? AND length(html) BETWEEN 1 AND ?`)
    .get(offset + 1, REMOTE_VISUALIZATION_CHUNK_BYTES, id, CONVERSATION_VISUALIZATION_MAX_BYTES);
  if (!row || !(row.bytes instanceof Uint8Array) || typeof row.size_bytes !== "number" || typeof row.preferred_height !== "number"
    || typeof row.title !== "string" || typeof row.summary !== "string" || typeof row.sha256 !== "string"
    || (row.layout !== "standard" && row.layout !== "wide") || (row.interaction !== "native" && row.interaction !== "script")) return undefined;
  return { ...visualizationOwnership(row), artifactId: id, sizeBytes: row.size_bytes, sha256: row.sha256,
    title: row.title, summary: row.summary, layout: row.layout, interaction: row.interaction,
    preferredHeight: row.preferred_height, bytes: row.bytes };
}

function visualizationOwnership(row: Record<string, SQLOutputValue>) {
  return {
    workspaceId: String(row.workspace_id), threadId: String(row.thread_id), turnId: String(row.turn_id),
    messageId: String(row.message_id), runId: String(row.run_id),
  };
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
