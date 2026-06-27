import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  createConversationAttachmentId,
  type AssignConversationAttachmentInput,
  type ChannelAttachmentKind,
  type ConversationAttachment,
  type CreateConversationAttachmentInput,
  type ListConversationAttachmentsOptions,
} from "../../workspace-types.js";
import { omitUndefined, readNullableString, readNumber, readString } from "./helpers.js";
import { conversationAttachmentSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteConversationAssetStorePorts {
  readonly hasLingThread: (id: string) => boolean;
  readonly hasLingTurn: (id: string) => boolean;
}

export class SqliteConversationAssetStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteConversationAssetStorePorts,
  ) {}

  createConversationAttachment(input: CreateConversationAttachmentInput): ConversationAttachment {
    if (input.threadId && !this.ports.hasLingThread(input.threadId)) {
      throw new Error(`Conversation thread not found: ${input.threadId}`);
    }
    if (input.turnId && !this.ports.hasLingTurn(input.turnId)) {
      throw new Error(`Conversation turn not found: ${input.turnId}`);
    }
    const attachment: ConversationAttachment = {
      id: createConversationAttachmentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      threadId: input.threadId,
      turnId: input.turnId,
      kind: input.kind,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      path: input.path,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.context.database
      .prepare(`
        INSERT INTO conversation_attachments (
          id,
          workspace_id,
          thread_id,
          turn_id,
          kind,
          file_name,
          content_type,
          size_bytes,
          path,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attachment.id,
        attachment.workspaceId,
        attachment.threadId ?? null,
        attachment.turnId ?? null,
        attachment.kind,
        attachment.fileName,
        attachment.contentType,
        attachment.sizeBytes,
        attachment.path,
        attachment.createdAt,
      );

    const created = this.getConversationAttachment(attachment.id);
    if (!created) {
      throw new Error(`Failed to create conversation attachment: ${attachment.id}`);
    }
    return created;
  }

  getConversationAttachment(id: string): ConversationAttachment | undefined {
    const row = this.context.database.prepare(conversationAttachmentSelectSql("WHERE id = ?")).get(id);
    return row ? mapConversationAttachment(row as Record<string, SQLOutputValue>) : undefined;
  }

  listConversationAttachments(options: ListConversationAttachmentsOptions): ConversationAttachment[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.turnId) {
      clauses.push("turn_id = ?");
      params.push(options.turnId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${conversationAttachmentSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapConversationAttachment(row as Record<string, SQLOutputValue>));
  }

  assignConversationAttachment(input: AssignConversationAttachmentInput): ConversationAttachment | undefined {
    if (!this.ports.hasLingThread(input.threadId)) {
      throw new Error(`Conversation thread not found: ${input.threadId}`);
    }
    if (!this.ports.hasLingTurn(input.turnId)) {
      throw new Error(`Conversation turn not found: ${input.turnId}`);
    }
    const existing = this.getConversationAttachment(input.attachmentId);
    if (!existing) {
      return undefined;
    }
    if (existing.threadId && existing.threadId !== input.threadId) {
      throw new Error(`Conversation attachment belongs to a different thread: ${input.attachmentId}`);
    }
    if (existing.turnId && existing.turnId !== input.turnId) {
      throw new Error(`Conversation attachment was already used by another turn: ${input.attachmentId}`);
    }
    this.context.database
      .prepare("UPDATE conversation_attachments SET thread_id = ?, turn_id = ? WHERE id = ?")
      .run(input.threadId, input.turnId, input.attachmentId);
    return this.getConversationAttachment(input.attachmentId);
  }

  deleteConversationAttachment(id: string): boolean {
    const result = this.context.database.prepare("DELETE FROM conversation_attachments WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }
}

function mapConversationAttachment(row: Record<string, SQLOutputValue>): ConversationAttachment {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readNullableString(row, "thread_id"),
    turnId: readNullableString(row, "turn_id"),
    kind: readString(row, "kind") as ChannelAttachmentKind,
    fileName: readString(row, "file_name"),
    contentType: readString(row, "content_type"),
    sizeBytes: readNumber(row, "size_bytes"),
    path: readString(row, "path"),
    createdAt: readString(row, "created_at"),
  });
}
