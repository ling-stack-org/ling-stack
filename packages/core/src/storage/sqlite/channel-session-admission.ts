import { channelSessionThreadLineageSql, channelSessionTopicLineageValidSql } from "./channel-session-lineage.js";
import type { DatabaseSync } from "node:sqlite";
import { ChannelSessionError } from "../../channel-session-types.js";

/** Invoked inside the same writer transaction as accepting input or creating execution. */
export function assertChannelSessionThreadWritable(database: DatabaseSync, threadId: string): void {
  const thread = database.prepare(`SELECT t.status, t.archived_at, c.status AS channel_status FROM ling_threads t
    LEFT JOIN channels c ON c.id = t.channel_id AND c.workspace_id = t.workspace_id WHERE t.id = ?`).get(threadId);
  if (thread?.channel_status === "archived") throw new ChannelSessionError("channel_archived", "Archived channels are read-only.");
  if (thread?.status === "archived" || thread?.archived_at) {
    throw new ChannelSessionError("session_archived", `Ling thread is archived: ${threadId}`);
  }
  const hasProjection = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_session_diagnostics'").get());
  // Pre-cutover migration fixtures do not have the diagnostics table yet.
  if (hasProjection) {
    const sources = database.prepare(`${channelSessionThreadLineageSql("?")}
      SELECT source.status, source.archived_at, source.surface_kind,
        ${channelSessionTopicLineageValidSql("source.id")} AS valid_lineage,
        EXISTS (SELECT 1 FROM channel_session_diagnostics d JOIN channel_branches b ON b.id = d.branch_id
          WHERE b.root_thread_id = source.id AND b.deleted_at IS NULL) AS requires_repair
      FROM session_lineage lineage JOIN ling_threads source ON source.id = lineage.id`).all(threadId);
    for (const source of sources) {
      if (source.surface_kind === "topic" && !source.valid_lineage) {
        throw new ChannelSessionError("invalid_session_mapping", "Topic conversation lineage is invalid.");
      }
      if (source.status === "archived" || source.archived_at) {
        throw new ChannelSessionError("session_archived", "The owning conversation is archived.");
      }
      if (source.requires_repair) throw new ChannelSessionError("session_requires_repair", "Repair the conversation directory before accepting new work.");
    }
  }
}
