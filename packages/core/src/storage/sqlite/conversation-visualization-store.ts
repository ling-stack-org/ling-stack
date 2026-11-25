import { createHash } from "node:crypto";
import { CONVERSATION_VISUALIZATION_MAX_BYTES, CONVERSATION_VISUALIZATION_MAX_PER_RUN, normalizeConversationVisualization } from "@ling-stack/contracts";
import type { DatabaseSync } from "node:sqlite";
import type { SavedConversationVisualization, SaveConversationVisualization, SaveConversationVisualizationResult } from "../../conversation-visualization-types.js";
import type { RunStore } from "../../run-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

const version = 238;

export function migrateConversationVisualizations(database: DatabaseSync, hasMigration: (version: number) => boolean,
  recordMigration: (version: number, name: string) => void): void {
  if (hasMigration(version)) return;
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
      preferred_height INTEGER NOT NULL CHECK(preferred_height BETWEEN 160 AND 480),
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_conversation_visualizations_run ON conversation_visualizations(run_id);
  `);
  recordMigration(version, "conversation_visualizations");
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
  return { ...document, artifactId: id, sizeBytes: row.html.byteLength, sha256: String(row.sha256),
    workspaceId: String(row.workspace_id), threadId: String(row.thread_id), turnId: String(row.turn_id),
    messageId: String(row.message_id), runId: String(row.run_id) };
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
