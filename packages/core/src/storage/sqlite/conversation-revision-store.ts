import type { SQLOutputValue } from "node:sqlite";
import {
  ConversationMessageRevisionConflictError,
  createConversationMessageRevisionId,
  createConversationTurnSupersessionId,
  type CommitConversationMessageEditInput,
  type CommitConversationMessageEditResult,
  type ConversationMessageRevision,
  type ConversationMessageRevisionContent,
  type ConversationReplacementStatus,
  type ConversationTurnSupersession,
  type ListConversationMessageRevisionsOptions,
  type ListConversationTurnSupersessionsOptions,
} from "../../conversation-revision-types.js";
import { DEFAULT_WORKSPACE_ID, type ChannelMention, type ChannelMessageFileRef } from "../../workspace-types.js";
import {
  parseJson,
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
  stringifyJson,
} from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteConversationRevisionStore {
  constructor(private readonly context: SqliteStoreContext) {}

  commitConversationMessageEdit(input: CommitConversationMessageEditInput, now: string): CommitConversationMessageEditResult {
    const replay = this.findSupersessionByIdempotency(input.idempotencyKey);
    if (replay) {
      const revision = this.getRevision(replay.replacementRevisionId);
      if (!revision) {
        throw new Error(`Replacement revision not found for supersession: ${replay.id}`);
      }
      return { revision, supersession: replay, idempotentReplay: true };
    }

    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const concurrentReplay = this.findSupersessionByIdempotency(input.idempotencyKey);
      if (concurrentReplay) {
        const revision = this.getRevision(concurrentReplay.replacementRevisionId);
        if (!revision) {
          throw new Error(`Replacement revision not found for supersession: ${concurrentReplay.id}`);
        }
        this.context.database.exec("COMMIT");
        return { revision, supersession: concurrentReplay, idempotentReplay: true };
      }
      const latest = this.listConversationMessageRevisions({ surface: input.surface, messageId: input.messageId }).at(-1);
      const actualRevision = latest?.revision ?? 1;
      if (actualRevision !== input.expectedRevision) {
        throw new ConversationMessageRevisionConflictError(input.expectedRevision, actualRevision);
      }
      const original = latest ?? this.insertRevision({
        input,
        content: input.current,
        revision: 1,
        createdAt: now,
      });
      const replacement = this.insertRevision({
        input,
        content: input.replacement,
        revision: original.revision + 1,
        supersedesRevisionId: original.id,
        createdAt: now,
      });
      this.updateNativeMessage(input, now);
      if (input.supersededTurnId) {
        this.context.database.prepare(`
          UPDATE ling_turns
          SET status = 'superseded', active_run_id = NULL, updated_at = ?, completed_at = COALESCE(completed_at, ?)
          WHERE id = ?
        `).run(now, now, input.supersededTurnId);
      }
      const supersession = this.insertSupersession(input, replacement.id, now);
      this.context.database.exec("COMMIT");
      return { revision: replacement, supersession, idempotentReplay: false };
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  listConversationMessageRevisions(options: ListConversationMessageRevisionsOptions): ConversationMessageRevision[] {
    return this.context.database.prepare(`
      SELECT * FROM conversation_message_revisions
      WHERE workspace_id = ? AND surface_kind = ? AND message_id = ?
      ORDER BY revision ASC
    `).all(DEFAULT_WORKSPACE_ID, options.surface, options.messageId)
      .map((row) => mapRevision(row as Record<string, SQLOutputValue>));
  }

  getConversationTurnSupersession(id: string): ConversationTurnSupersession | undefined {
    const row = this.context.database.prepare(`
      SELECT * FROM conversation_turn_supersessions WHERE workspace_id = ? AND id = ?
    `).get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapSupersession(row as Record<string, SQLOutputValue>) : undefined;
  }

  getConversationTurnSupersessionByIdempotency(idempotencyKey: string): ConversationTurnSupersession | undefined {
    return this.findSupersessionByIdempotency(idempotencyKey);
  }

  listConversationTurnSupersessions(options: ListConversationTurnSupersessionsOptions = {}): ConversationTurnSupersession[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.surface) {
      clauses.push("surface_kind = ?");
      params.push(options.surface);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.laneId) {
      clauses.push("lane_id = ?");
      params.push(options.laneId);
    }
    if (options.messageId) {
      clauses.push("message_id = ?");
      params.push(options.messageId);
    }
    if (options.replacementStatus) {
      clauses.push("replacement_status = ?");
      params.push(options.replacementStatus);
    }
    params.push(Math.min(Math.max(options.limit ?? 200, 1), 500));
    return this.context.database.prepare(`
      SELECT * FROM conversation_turn_supersessions
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params).map((row) => mapSupersession(row as Record<string, SQLOutputValue>));
  }

  updateConversationTurnSupersession(
    id: string,
    input: {
      readonly replacementTurnId?: string | null;
      readonly replacementStatus?: ConversationReplacementStatus;
      readonly failureReason?: string | null;
    },
    now: string,
  ): ConversationTurnSupersession | undefined {
    const current = this.getConversationTurnSupersession(id);
    if (!current) {
      return undefined;
    }
    this.context.database.prepare(`
      UPDATE conversation_turn_supersessions
      SET replacement_turn_id = ?, replacement_status = ?, failure_reason = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?
    `).run(
      input.replacementTurnId === undefined ? current.replacementTurnId ?? null : input.replacementTurnId,
      input.replacementStatus ?? current.replacementStatus,
      input.failureReason === undefined ? current.failureReason ?? null : input.failureReason,
      now,
      DEFAULT_WORKSPACE_ID,
      id,
    );
    return this.getConversationTurnSupersession(id);
  }

  private insertRevision(input: {
    readonly input: CommitConversationMessageEditInput;
    readonly content: ConversationMessageRevisionContent;
    readonly revision: number;
    readonly supersedesRevisionId?: string;
    readonly createdAt: string;
  }): ConversationMessageRevision {
    const id = createConversationMessageRevisionId();
    this.context.database.prepare(`
      INSERT INTO conversation_message_revisions (
        id, workspace_id, surface_kind, owner_id, lane_id, message_id, revision, body,
        mentions_json, attachment_ids_json, link_preview_ids_json, file_refs_json,
        supersedes_revision_id, source_turn_id, source_run_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local-user', ?)
    `).run(
      id,
      DEFAULT_WORKSPACE_ID,
      input.input.surface,
      input.input.ownerId,
      input.input.laneId,
      input.input.messageId,
      input.revision,
      input.content.body,
      stringifyJson(input.content.mentions),
      stringifyJson(input.content.attachmentIds),
      stringifyJson(input.content.linkPreviewIds),
      stringifyJson(input.content.fileRefs),
      input.supersedesRevisionId ?? null,
      input.input.sourceTurnId ?? null,
      input.input.sourceRunId ?? null,
      input.createdAt,
    );
    return this.getRevision(id)!;
  }

  private insertSupersession(
    input: CommitConversationMessageEditInput,
    replacementRevisionId: string,
    now: string,
  ): ConversationTurnSupersession {
    const id = createConversationTurnSupersessionId();
    this.context.database.prepare(`
      INSERT INTO conversation_turn_supersessions (
        id, workspace_id, surface_kind, owner_id, lane_id, message_id, superseded_turn_id,
        superseded_run_ids_json, superseded_response_message_ids_json, replacement_revision_id,
        replacement_turn_id, reason, replacement_status, failure_reason, idempotency_key,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'latest_user_message_edited', 'pending', NULL, ?, ?, ?)
    `).run(
      id,
      DEFAULT_WORKSPACE_ID,
      input.surface,
      input.ownerId,
      input.laneId,
      input.messageId,
      input.supersededTurnId ?? null,
      stringifyJson(input.supersededRunIds ?? []),
      stringifyJson(input.supersededResponseMessageIds ?? []),
      replacementRevisionId,
      input.idempotencyKey,
      now,
      now,
    );
    return this.getConversationTurnSupersession(id)!;
  }

  private updateNativeMessage(input: CommitConversationMessageEditInput, now: string): void {
    if (input.surface === "normal_conversation") {
      return;
    }
    if (input.surface === "teammate_direct") {
      const result = this.context.database.prepare(`
        UPDATE teammate_direct_messages
        SET body = ?, attachment_ids_json = ?, link_preview_ids_json = ?, file_refs_json = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND teammate_id = ? AND thread_id = ? AND author_type = 'local-user'
      `).run(
        input.replacement.body,
        stringifyJson(input.replacement.attachmentIds),
        stringifyJson(input.replacement.linkPreviewIds),
        stringifyJson(input.replacement.fileRefs),
        now,
        DEFAULT_WORKSPACE_ID,
        input.messageId,
        input.ownerId,
        input.laneId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`Editable teammate direct message not found: ${input.messageId}`);
      }
      return;
    }
    const result = this.context.database.prepare(`
      UPDATE channel_messages
      SET body = ?, mentions_json = ?, attachment_ids_json = ?, link_preview_ids_json = ?, file_refs_json = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND channel_id = ? AND author_type = 'local-user'
    `).run(
      input.replacement.body,
      stringifyJson(input.replacement.mentions),
      stringifyJson(input.replacement.attachmentIds),
      stringifyJson(input.replacement.linkPreviewIds),
      stringifyJson(input.replacement.fileRefs),
      now,
      DEFAULT_WORKSPACE_ID,
      input.messageId,
      input.ownerId,
    );
    if (Number(result.changes) !== 1) {
      throw new Error(`Editable channel message not found: ${input.messageId}`);
    }
  }

  private getRevision(id: string): ConversationMessageRevision | undefined {
    const row = this.context.database.prepare(`
      SELECT * FROM conversation_message_revisions WHERE workspace_id = ? AND id = ?
    `).get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapRevision(row as Record<string, SQLOutputValue>) : undefined;
  }

  private findSupersessionByIdempotency(idempotencyKey: string): ConversationTurnSupersession | undefined {
    const row = this.context.database.prepare(`
      SELECT * FROM conversation_turn_supersessions WHERE workspace_id = ? AND idempotency_key = ?
    `).get(DEFAULT_WORKSPACE_ID, idempotencyKey);
    return row ? mapSupersession(row as Record<string, SQLOutputValue>) : undefined;
  }
}

function mapRevision(row: Record<string, SQLOutputValue>): ConversationMessageRevision {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    surface: readString(row, "surface_kind") as ConversationMessageRevision["surface"],
    ownerId: readString(row, "owner_id"),
    laneId: readString(row, "lane_id"),
    messageId: readString(row, "message_id"),
    revision: readNumber(row, "revision"),
    body: readString(row, "body"),
    mentions: parseArray<ChannelMention>(readString(row, "mentions_json")),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    linkPreviewIds: parseJsonStringArray(readString(row, "link_preview_ids_json")),
    fileRefs: parseArray<ChannelMessageFileRef>(readString(row, "file_refs_json")),
    supersedesRevisionId: readNullableString(row, "supersedes_revision_id"),
    sourceTurnId: readNullableString(row, "source_turn_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    createdBy: "local-user",
    createdAt: readString(row, "created_at"),
  };
}

function mapSupersession(row: Record<string, SQLOutputValue>): ConversationTurnSupersession {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    surface: readString(row, "surface_kind") as ConversationTurnSupersession["surface"],
    ownerId: readString(row, "owner_id"),
    laneId: readString(row, "lane_id"),
    messageId: readString(row, "message_id"),
    supersededTurnId: readNullableString(row, "superseded_turn_id"),
    supersededRunIds: parseJsonStringArray(readString(row, "superseded_run_ids_json")),
    supersededResponseMessageIds: parseJsonStringArray(readString(row, "superseded_response_message_ids_json")),
    replacementRevisionId: readString(row, "replacement_revision_id"),
    replacementTurnId: readNullableString(row, "replacement_turn_id"),
    reason: "latest_user_message_edited",
    replacementStatus: readString(row, "replacement_status") as ConversationReplacementStatus,
    failureReason: readNullableString(row, "failure_reason"),
    idempotencyKey: readString(row, "idempotency_key"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function parseArray<T>(value: string): T[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array from SQLite");
  }
  return parsed as T[];
}
