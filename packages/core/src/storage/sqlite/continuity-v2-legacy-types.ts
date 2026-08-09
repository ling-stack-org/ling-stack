import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { readString } from "./helpers.js";

export const CONTINUITY_V2_IMPORT_POLICY_VERSION = "continuity-v2-import-v1";

export interface ContinuityV2LegacyImportReport {
  readonly legacyMessageCount: number;
  readonly importedItemCount: number;
  readonly importedTurnCount: number;
  readonly rootThreadCount: number;
  readonly topicThreadCount: number;
  readonly branchThreadCount: number;
  readonly segmentCount: number;
  readonly assignmentCount: number;
  readonly summaryCount: number;
  readonly invalidatedSummaryCount: number;
}

export interface LegacyContinuityMessage {
  readonly rowid: number;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly legacyThreadId?: string;
  readonly kind: string;
  readonly authorType: string;
  readonly authorId?: string;
  readonly body: string;
  readonly mentionsJson: string;
  readonly attachmentIdsJson: string;
  readonly linkPreviewIdsJson: string;
  readonly fileRefsJson: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly status: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContinuityV2ThreadTopology {
  readonly rootByChannel: ReadonlyMap<string, string>;
  readonly threadChannelById: ReadonlyMap<string, string | undefined>;
  readonly targetThreadByMessageId: ReadonlyMap<string, string>;
  readonly topicThreadByAnchorItemId: ReadonlyMap<string, string>;
  readonly branchThreadIds: ReadonlySet<string>;
}

export function continuityV2ImportId(prefix: string, source: string): string {
  return `${prefix}_${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}

export function requiredContinuityMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Continuity v2 migration is missing ${label}: ${String(key)}`);
  return value;
}

export function legacyContinuityTitle(body: string, fallback: string): string {
  const compact = body.replace(/\s+/gu, " ").trim();
  return compact ? compact.slice(0, 160) : fallback;
}

export function insertContinuitySyntheticTurn(
  database: DatabaseSync,
  threadId: string,
  channelId: string | undefined,
  sourceKey: string,
  timestamp: string,
): string {
  const thread = database.prepare("SELECT workspace_id FROM ling_threads WHERE id = ?").get(threadId) as
    | Record<string, SQLOutputValue>
    | undefined;
  if (!thread) throw new Error(`Continuity v2 migration cannot create a synthetic turn for missing thread: ${threadId}`);
  const turnId = continuityV2ImportId("turn_import", `${threadId}:${sourceKey}`);
  const sourceItemColumn = lingTurnSourceItemColumn(database);
  database.prepare(`
    INSERT OR IGNORE INTO ling_turns (
      id, workspace_id, thread_id, kind, status, title, user_instruction, channel_id,
      task_id, teammate_id, workflow_step_id, external_work_id, automation_id,
      ${sourceItemColumn}, source_turn_id, intervention_id, active_run_id, last_run_id,
      created_by_actor, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 'initial_request', 'succeeded', 'Imported conversation boundary',
      'Imported Continuity v2 conversation boundary.', ?, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, 'system', ?, ?, ?)
  `).run(turnId, readString(thread, "workspace_id"), threadId, channelId ?? null, timestamp, timestamp, timestamp);
  return turnId;
}

export function lingTurnSourceItemColumn(database: DatabaseSync): "source_item_id" | "source_message_id" {
  return database.prepare("PRAGMA table_info(ling_turns)").all().some((row) => {
    return typeof row === "object" && row !== null && "name" in row && row.name === "source_item_id";
  }) ? "source_item_id" : "source_message_id";
}

export function isContinuityJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
