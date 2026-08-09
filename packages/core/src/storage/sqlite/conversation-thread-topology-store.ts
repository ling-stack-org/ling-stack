import type { SQLOutputValue } from "node:sqlite";
import type {
  ResolveOrCreateConversationThreadInput,
  ResolveOrCreateConversationThreadResult,
} from "../../conversation-thread-topology-types.js";
import type { CreateLingThreadInput, LingThread } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readNullableString, readString } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteConversationThreadTopologyStorePorts {
  readonly createLingThread: (input: CreateLingThreadInput, now: string) => LingThread;
  readonly getLingThread: (threadId: string) => LingThread | undefined;
}

export class SqliteConversationThreadTopologyStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteConversationThreadTopologyStorePorts,
  ) {}

  resolveOrCreate(
    input: ResolveOrCreateConversationThreadInput,
    now: string,
  ): ResolveOrCreateConversationThreadResult {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findExisting(input);
      if (existing) {
        this.assertExistingMatches(input, existing);
        this.context.database.exec("COMMIT");
        return { thread: existing, created: false };
      }

      const createInput = this.buildCreateInput(input);
      const thread = this.ports.createLingThread(createInput, now);
      this.context.database.exec("COMMIT");
      return { thread, created: true };
    } catch (error) {
      if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  private findExisting(input: ResolveOrCreateConversationThreadInput): LingThread | undefined {
    if (input.id) {
      return this.ports.getLingThread(input.id);
    }
    const row = input.surfaceKind === "channel_root"
      ? this.context.database.prepare(`
          SELECT id
          FROM ling_threads
          WHERE workspace_id = ? AND channel_id = ?
            AND surface_kind = 'channel_root' AND archived_at IS NULL
          LIMIT 1
        `).get(DEFAULT_WORKSPACE_ID, input.channelId)
      : input.surfaceKind === "topic"
        ? this.context.database.prepare(`
            SELECT id
            FROM ling_threads
            WHERE workspace_id = ? AND channel_id = ? AND anchor_item_id = ?
              AND surface_kind = 'topic' AND archived_at IS NULL
            LIMIT 1
          `).get(DEFAULT_WORKSPACE_ID, input.channelId, input.anchorItemId)
        : undefined;
    if (!row) return undefined;
    return this.ports.getLingThread(readString(row as Record<string, SQLOutputValue>, "id"));
  }

  private buildCreateInput(input: ResolveOrCreateConversationThreadInput): CreateLingThreadInput {
    switch (input.surfaceKind) {
      case "channel_root":
        this.assertChannelExists(input.channelId);
        return {
          ...(input.id ? { id: input.id } : {}),
          kind: "channel_discussion",
          channelId: input.channelId,
          title: input.title,
          objective: input.objective,
          surfaceKind: "channel_root",
          relationKind: "root",
        };
      case "topic": {
        const anchor = this.readRequiredAnchor(input.channelId, input.anchorItemId);
        if (!readNullableString(anchor, "turn_id")) {
          throw new Error(`Conversation topic anchor has no owning turn: ${input.anchorItemId}`);
        }
        return {
          ...(input.id ? { id: input.id } : {}),
          kind: "channel_discussion",
          channelId: input.channelId,
          title: input.title,
          objective: input.objective,
          parentThreadId: readString(anchor, "thread_id"),
          parentTurnId: readString(anchor, "turn_id"),
          anchorItemId: input.anchorItemId,
          surfaceKind: "topic",
          relationKind: "topic",
        };
      }
      case "branch":
        this.assertParentLineage(input.channelId, input.parentThreadId, input.parentTurnId);
        return {
          ...(input.id ? { id: input.id } : {}),
          kind: "channel_discussion",
          channelId: input.channelId,
          title: input.title,
          objective: input.objective,
          parentThreadId: input.parentThreadId,
          parentTurnId: input.parentTurnId,
          surfaceKind: "branch",
          relationKind: "branch",
        };
    }
  }

  private assertExistingMatches(input: ResolveOrCreateConversationThreadInput, thread: LingThread): void {
    if (thread.channelId !== input.channelId || thread.surfaceKind !== input.surfaceKind) {
      throw new Error(`Conversation thread id belongs to another topology: ${thread.id}`);
    }
    switch (input.surfaceKind) {
      case "channel_root":
        if (thread.relationKind !== "root" || thread.parentThreadId || thread.parentTurnId) {
          throw new Error(`Conversation root thread has invalid lineage: ${thread.id}`);
        }
        return;
      case "topic":
        if (thread.relationKind !== "topic" || thread.anchorItemId !== input.anchorItemId) {
          throw new Error(`Conversation topic thread has invalid anchor: ${thread.id}`);
        }
        return;
      case "branch":
        if (
          thread.relationKind !== "branch"
          || thread.parentThreadId !== input.parentThreadId
          || thread.parentTurnId !== input.parentTurnId
        ) {
          throw new Error(`Conversation branch thread has invalid lineage: ${thread.id}`);
        }
    }
  }

  private assertChannelExists(channelId: string): void {
    const row = this.context.database.prepare(`
      SELECT 1 FROM channels WHERE workspace_id = ? AND id = ?
    `).get(DEFAULT_WORKSPACE_ID, channelId);
    if (!row) throw new Error(`Channel not found: ${channelId}`);
  }

  private readRequiredAnchor(channelId: string, itemId: string): Record<string, SQLOutputValue> {
    const row = this.context.database.prepare(`
      SELECT channel_id, thread_id, turn_id, status
      FROM conversation_items
      WHERE workspace_id = ? AND id = ?
    `).get(DEFAULT_WORKSPACE_ID, itemId) as Record<string, SQLOutputValue> | undefined;
    if (!row || readNullableString(row, "channel_id") !== channelId) {
      throw new Error(`Conversation topic anchor does not belong to channel: ${itemId}`);
    }
    if (readString(row, "status") !== "committed") {
      throw new Error(`Conversation topic anchor is not committed: ${itemId}`);
    }
    this.assertParentThread(channelId, readString(row, "thread_id"));
    return row;
  }

  private assertParentLineage(channelId: string, parentThreadId: string, parentTurnId: string): void {
    this.assertParentThread(channelId, parentThreadId);
    const row = this.context.database.prepare(`
      SELECT thread_id
      FROM ling_turns
      WHERE workspace_id = ? AND id = ?
    `).get(DEFAULT_WORKSPACE_ID, parentTurnId) as Record<string, SQLOutputValue> | undefined;
    if (!row || readString(row, "thread_id") !== parentThreadId) {
      throw new Error(`Conversation branch parent turn does not belong to parent thread: ${parentTurnId}`);
    }
  }

  private assertParentThread(channelId: string, threadId: string): void {
    const thread = this.ports.getLingThread(threadId);
    if (!thread || thread.channelId !== channelId) {
      throw new Error(`Conversation parent thread does not belong to channel: ${threadId}`);
    }
    if (thread.status === "archived" || thread.archivedAt) {
      throw new Error(`Conversation parent thread is archived: ${threadId}`);
    }
  }
}
