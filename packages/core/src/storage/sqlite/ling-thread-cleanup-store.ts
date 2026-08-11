import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  createRetentionTombstoneId,
  type HardDeleteLingThreadInput,
  type HardDeleteLingThreadResult,
} from "../../workspace-types.js";
import type { LingThread } from "../../run-types.js";
import { readNumber, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteLingThreadCleanupStorePorts {
  readonly getLingThread: (threadId: string) => LingThread | undefined;
}

export class SqliteLingThreadCleanupStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteLingThreadCleanupStorePorts,
  ) {}

  hardDeleteLingThread(
    threadId: string,
    input: HardDeleteLingThreadInput,
    now: string,
  ): HardDeleteLingThreadResult | undefined {
    const thread = this.ports.getLingThread(threadId);
    if (!thread) {
      return undefined;
    }
    if (thread.kind !== "conversation") {
      throw new Error(`Only conversation threads can be permanently deleted: ${threadId}`);
    }
    if (!thread.archivedAt && thread.status !== "archived") {
      throw new Error(`Conversation thread must be archived before delete: ${threadId}`);
    }

    const attachmentRows = this.context.database
      .prepare("SELECT path FROM conversation_attachments WHERE workspace_id = ? AND thread_id = ?")
      .all(DEFAULT_WORKSPACE_ID, threadId) as Record<string, SQLOutputValue>[];
    const deletedAttachmentPaths = attachmentRows.map((row) => readString(row, "path"));
    const deletedCounts = {
      lingThreads: 1,
      lingTurns: countWhere(this.context.database, "ling_turns", "thread_id = ?", [threadId]),
      conversationAttachments: attachmentRows.length,
      threadGoals: countWhere(this.context.database, "ling_thread_goals", "thread_id = ?", [threadId]),
      proposedPlans: countWhere(this.context.database, "ling_thread_proposed_plans", "thread_id = ?", [threadId]),
      automationDefinitions: countWhere(this.context.database, "automation_definitions", "thread_id = ?", [threadId]),
      runsUnlinked: countWhere(this.context.database, "run_sessions", "thread_id = ?", [threadId]),
      childThreadsDetached: countWhere(this.context.database, "ling_threads", "parent_thread_id = ?", [threadId]),
      conversationItemsDeleted: countWhere(this.context.database, "conversation_items", "thread_id = ?", [threadId]),
    };
    const tombstone = {
      id: createRetentionTombstoneId(),
      workspaceId: thread.workspaceId,
      entityType: "conversation-thread" as const,
      entityId: threadId,
      reason: input.reason,
      deletedCounts,
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
      this.context.database.prepare("UPDATE run_sessions SET thread_id = NULL, updated_at = ? WHERE thread_id = ?").run(now, threadId);
      this.context.database.prepare("DELETE FROM ling_thread_proposed_plans WHERE workspace_id = ? AND thread_id = ?").run(DEFAULT_WORKSPACE_ID, threadId);
      this.context.database.prepare("DELETE FROM ling_thread_goals WHERE workspace_id = ? AND thread_id = ?").run(DEFAULT_WORKSPACE_ID, threadId);
      this.context.database.prepare("DELETE FROM ling_threads WHERE id = ?").run(threadId);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }

    return { tombstone, deletedAttachmentPaths };
  }
}

function countWhere(
  database: DatabaseSync,
  table: string,
  whereClause: string,
  params: readonly (string | number)[],
): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause}`).get(...params) as
    | Record<string, SQLOutputValue>
    | undefined;
  return row ? readNumber(row, "count") : 0;
}
