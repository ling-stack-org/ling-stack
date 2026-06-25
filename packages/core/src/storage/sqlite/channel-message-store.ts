import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelMessageId,
  type ChannelMessage,
  type ChannelMessageListPage,
  type CreateChannelMessageInput,
  type ListChannelMessagesOptions,
} from "../../workspace-types.js";
import { readNullableString, readNumber, readString, stringifyJson } from "./helpers.js";
import { mapChannelMessage } from "./channel-message-mappers.js";
import { normalizeChannelMessageFileRefs } from "./channel-message-parsers.js";
import { channelMessageSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelMessageStorePorts {
  readonly hasChannel: (id: string) => boolean;
}

export class SqliteChannelMessageStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelMessageStorePorts,
  ) {}

  createChannelMessage(input: CreateChannelMessageInput, now: string): ChannelMessage {
    if (!this.ports.hasChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const message: ChannelMessage = {
      id: createChannelMessageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      threadId: input.threadId,
      kind: input.kind ?? "message",
      intent: input.intent ?? "discuss",
      authorType: input.authorType,
      authorId: input.authorId,
      body: input.body,
      mentions: input.mentions ?? [],
      attachmentIds: input.attachmentIds ?? [],
      linkPreviewIds: input.linkPreviewIds ?? [],
      fileRefs: normalizeChannelMessageFileRefs(input.fileRefs),
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      status: input.status ?? "ready",
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_messages (
          id,
          workspace_id,
          channel_id,
          thread_id,
          kind,
          intent,
          author_type,
          author_id,
          body,
          mentions_json,
          attachment_ids_json,
          link_preview_ids_json,
          file_refs_json,
          linked_task_id,
          linked_run_id,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.workspaceId,
        message.channelId,
        message.threadId ?? null,
        message.kind,
        message.intent,
        message.authorType,
        message.authorId ?? null,
        message.body,
        stringifyJson(message.mentions),
        stringifyJson(message.attachmentIds),
        stringifyJson(message.linkPreviewIds),
        stringifyJson(message.fileRefs),
        message.linkedTaskId ?? null,
        message.linkedRunId ?? null,
        message.status,
        message.errorMessage ?? null,
        message.createdAt,
        message.updatedAt,
      );

    const created = this.getChannelMessage(message.id);
    if (!created) {
      throw new Error(`Failed to create channel message: ${message.id}`);
    }
    return created;
  }

  updateChannelMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: ChannelMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): ChannelMessage | undefined {
    const existing = this.getChannelMessage(id);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare(`
        UPDATE channel_messages
        SET
          body = ?,
          status = ?,
          error_message = ?,
          linked_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.body ?? existing.body,
        input.status ?? existing.status,
        input.errorMessage === undefined ? existing.errorMessage ?? null : input.errorMessage,
        input.linkedRunId === undefined ? existing.linkedRunId ?? null : input.linkedRunId,
        now,
        id,
      );
    return this.getChannelMessage(id);
  }

  getChannelMessage(id: string): ChannelMessage | undefined {
    const row = this.context.database.prepare(channelMessageSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelMessage(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelMessages(options: ListChannelMessagesOptions): ChannelMessage[] {
    return this.listChannelMessagesPage(options).messages.slice();
  }

  listChannelMessagesPage(options: ListChannelMessagesOptions): ChannelMessageListPage {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    const excludedThreadIds = [...new Set(options.excludeThreadIds ?? [])].filter((threadId) => threadId.trim().length > 0);
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    } else if (excludedThreadIds.length > 0) {
      clauses.push(`(thread_id IS NULL OR thread_id NOT IN (${excludedThreadIds.map(() => "?").join(", ")}))`);
      params.push(...excludedThreadIds);
    }
    if (options.beforeMessageId) {
      const cursor = this.context.database
        .prepare("SELECT channel_id, thread_id, created_at, rowid FROM channel_messages WHERE workspace_id = ? AND id = ?")
        .get(DEFAULT_WORKSPACE_ID, options.beforeMessageId);
      if (!cursor || readString(cursor as Record<string, SQLOutputValue>, "channel_id") !== options.channelId) {
        throw new Error(`Invalid channel message cursor: ${options.beforeMessageId}`);
      }
      const cursorRow = cursor as Record<string, SQLOutputValue>;
      const cursorThreadId = readNullableString(cursorRow, "thread_id");
      if (options.threadId !== undefined && options.threadId !== cursorThreadId) {
        throw new Error(`Invalid channel message cursor: ${options.beforeMessageId}`);
      }
      if (options.threadId === undefined && cursorThreadId && excludedThreadIds.includes(cursorThreadId)) {
        throw new Error(`Invalid channel message cursor: ${options.beforeMessageId}`);
      }
      clauses.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
      const cursorCreatedAt = readString(cursorRow, "created_at");
      params.push(cursorCreatedAt, cursorCreatedAt, readNumber(cursorRow, "rowid"));
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit + 1);
    const rows = this.context.database
      .prepare(`${channelMessageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelMessage(row as Record<string, SQLOutputValue>));
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse();
    return {
      messages,
      hasMore,
      nextBeforeMessageId: hasMore && messages.length > 0 ? messages[0].id : undefined,
    };
  }
}
