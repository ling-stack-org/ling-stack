import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  createRetentionTombstoneId,
  isLingAgentTeammateId,
  type AiTeammate,
  type HardDeleteAiTeammateInput,
  type HardDeleteAiTeammateResult,
} from "../../workspace-types.js";
import { parseJsonStringArray, readNullableString, readNumber, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteTeammateCleanupStorePorts {
  readonly getAiTeammate: (id: string) => AiTeammate | undefined;
}

export class SqliteTeammateCleanupStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteTeammateCleanupStorePorts,
  ) {}

  hardDeleteAiTeammate(id: string, input: HardDeleteAiTeammateInput, now: string): HardDeleteAiTeammateResult | undefined {
    if (isLingAgentTeammateId(id)) {
      throw new Error("Ling Agent cannot be deleted.");
    }
    const teammate = this.ports.getAiTeammate(id);
    if (!teammate) {
      return undefined;
    }
    const privateAttachmentRows = this.context.database
      .prepare("SELECT path FROM teammate_private_attachments WHERE workspace_id = ? AND teammate_id = ?")
      .all(DEFAULT_WORKSPACE_ID, id) as Record<string, SQLOutputValue>[];
    const deletedAttachmentPaths = privateAttachmentRows.map((row) => readString(row, "path"));
    const memoryRows = this.context.database
      .prepare("SELECT id FROM memory_objects WHERE workspace_id = ? AND scope_type = 'teammate' AND owner_id = ?")
      .all(DEFAULT_WORKSPACE_ID, id) as Record<string, SQLOutputValue>[];
    const memoryIds = memoryRows.map((row) => readString(row, "id"));
    const usedMemoryRows = this.context.database
      .prepare("SELECT id, memory_ids_json, teammate_id FROM memory_used_events WHERE workspace_id = ?")
      .all(DEFAULT_WORKSPACE_ID) as Record<string, SQLOutputValue>[];
    const usedMemoryEventIds = usedMemoryRows
      .filter((row) => {
        if (readNullableString(row, "teammate_id") === id) {
          return true;
        }
        const eventMemoryIds = parseJsonStringArray(readString(row, "memory_ids_json"));
        return memoryIds.some((memoryId) => eventMemoryIds.includes(memoryId));
      })
      .map((row) => readString(row, "id"));
    const directThreadCount = countWhere(this.context.database, "teammate_direct_threads", "teammate_id = ?", [id]);
    const directMessageCount = countWhere(this.context.database, "teammate_direct_messages", "teammate_id = ?", [id]);
    const privateAttachmentCount = countWhere(this.context.database, "teammate_private_attachments", "teammate_id = ?", [id]);
    const channelMembershipCount = countWhere(this.context.database, "teammate_channel_memberships", "teammate_id = ?", [id]);
    const skillBindingCount = countWhere(this.context.database, "teammate_skill_bindings", "teammate_id = ?", [id]);
    const memoryScopeCount = countWhere(this.context.database, "teammate_memory_scopes", "teammate_id = ?", [id]);
    const mcpBindingCount = countWhere(this.context.database, "teammate_mcp_bindings", "teammate_id = ?", [id]);
    const channelDefaultCount = countWhere(this.context.database, "channels", "default_teammate_id = ?", [id]);
    const taskAssigneeCount = countWhere(this.context.database, "tasks", "assignee_teammate_id = ?", [id]);
    const runSessionCount = countWhere(this.context.database, "run_sessions", "teammate_id = ?", [id]);
    const tombstone = {
      id: createRetentionTombstoneId(),
      workspaceId: teammate.workspaceId,
      entityType: "ai-teammate" as const,
      entityId: id,
      reason: input.reason,
      deletedCounts: {
        aiTeammates: 1,
        directThreads: directThreadCount,
        directMessages: directMessageCount,
        privateAttachments: privateAttachmentCount,
        memoryObjects: memoryIds.length,
        usedMemoryEvents: usedMemoryEventIds.length,
        channelMemberships: channelMembershipCount,
        skillBindings: skillBindingCount,
        memoryScopes: memoryScopeCount,
        mcpBindings: mcpBindingCount,
        channelDefaultsCleared: channelDefaultCount,
        taskAssigneesCleared: taskAssigneeCount,
        runTeammateRefsCleared: runSessionCount,
      },
      createdAt: now,
    };

    this.context.database.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.context.database
        .prepare(`
          INSERT INTO retention_tombstones (
            id,
            workspace_id,
            entity_type,
            entity_id,
            reason,
            deleted_counts_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          tombstone.id,
          tombstone.workspaceId,
          tombstone.entityType,
          tombstone.entityId,
          tombstone.reason ?? null,
          stringifyJson(tombstone.deletedCounts),
          tombstone.createdAt,
        );
      for (const eventId of usedMemoryEventIds) {
        this.context.database.prepare("DELETE FROM memory_used_events WHERE id = ?").run(eventId);
      }
      this.context.database.prepare("DELETE FROM memory_objects WHERE workspace_id = ? AND scope_type = 'teammate' AND owner_id = ?").run(DEFAULT_WORKSPACE_ID, id);
      this.context.database.prepare("DELETE FROM teammate_private_attachments WHERE teammate_id = ?").run(id);
      this.context.database.prepare("DELETE FROM teammate_direct_messages WHERE teammate_id = ?").run(id);
      this.context.database.prepare("DELETE FROM teammate_direct_threads WHERE teammate_id = ?").run(id);
      this.context.database.prepare("DELETE FROM teammate_channel_memberships WHERE teammate_id = ?").run(id);
      this.context.database.prepare("DELETE FROM teammate_skill_bindings WHERE teammate_id = ?").run(id);
      this.context.database.prepare("DELETE FROM teammate_memory_scopes WHERE teammate_id = ?").run(id);
      this.context.database.prepare("DELETE FROM teammate_mcp_bindings WHERE teammate_id = ?").run(id);
      this.context.database.prepare("UPDATE channels SET default_teammate_id = NULL, updated_at = ? WHERE default_teammate_id = ?").run(now, id);
      this.context.database.prepare("UPDATE tasks SET assignee_teammate_id = NULL, updated_at = ? WHERE assignee_teammate_id = ?").run(now, id);
      this.context.database.prepare("UPDATE run_sessions SET teammate_id = NULL, updated_at = ? WHERE teammate_id = ?").run(now, id);
      this.context.database.prepare("DELETE FROM ai_teammates WHERE id = ?").run(id);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    return { tombstone, deletedAttachmentPaths };
  }
}

function countWhere(database: DatabaseSync, table: string, whereClause: string, params: readonly (string | number)[]): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause}`).get(...params) as Record<string, SQLOutputValue> | undefined;
  return row ? readNumber(row, "count") : 0;
}
