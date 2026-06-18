import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  createTeammateDirectLinkPreviewId,
  createTeammateDirectMessageId,
  createTeammateDirectReplyInterventionId,
  createTeammateDirectThreadId,
  createTeammatePrivateAttachmentId,
  type AiTeammate,
  type CreateTeammateDirectLinkPreviewInput,
  type CreateTeammateDirectMessageInput,
  type CreateTeammateDirectReplyInterventionInput,
  type CreateTeammatePrivateAttachmentInput,
  type DirectWorkspaceBinding,
  type ListTeammateDirectLinkPreviewsOptions,
  type ListTeammateDirectMessagesOptions,
  type ListTeammateDirectReplyInterventionsOptions,
  type ListTeammatePrivateAttachmentsOptions,
  type TeammateDirectLinkPreview,
  type TeammateDirectMessage,
  type TeammateDirectMessageListPage,
  type TeammateDirectReplyIntervention,
  type TeammateDirectThread,
  type TeammatePrivateAttachment,
  type UpdateTeammateDirectLinkPreviewInput,
  type UpdateTeammateDirectReplyInterventionStatusInput,
} from "../../workspace-types.js";
import { nullableUpdate, readNumber, readString, stringifyJson } from "./helpers.js";
import { normalizeChannelMessageFileRefs } from "./channel-message-parsers.js";
import {
  mapTeammateDirectLinkPreview,
  mapTeammateDirectMessage,
  mapTeammateDirectThread,
  mapTeammatePrivateAttachment,
} from "./teammate-direct-mappers.js";
import {
  mapTeammateDirectReplyIntervention,
  normalizeTeammateDirectReplyInterventionMessagePayload,
} from "./intervention-mappers.js";
import {
  teammateDirectLinkPreviewSelectSql,
  teammateDirectMessageSelectSql,
  teammateDirectReplyInterventionSelectSql,
  teammateDirectThreadSelectSql,
  teammatePrivateAttachmentSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteTeammateDirectStorePorts {
  readonly getAiTeammate: (id: string) => AiTeammate | undefined;
}

export class SqliteTeammateDirectStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteTeammateDirectStorePorts,
  ) {}

  getOrCreateTeammateDirectThread(teammateId: string, now: string): TeammateDirectThread {
    const teammate = this.ports.getAiTeammate(teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    const existing = this.context.database
      .prepare(teammateDirectThreadSelectSql("WHERE workspace_id = ? AND teammate_id = ?"))
      .get(DEFAULT_WORKSPACE_ID, teammateId);
    if (existing) {
      return mapTeammateDirectThread(existing as Record<string, SQLOutputValue>);
    }

    const thread: TeammateDirectThread = {
      id: createTeammateDirectThreadId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId,
      title: teammate.displayName,
      createdAt: now,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO teammate_direct_threads (
          id,
          workspace_id,
          teammate_id,
          title,
          workspace_binding_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(thread.id, thread.workspaceId, thread.teammateId, thread.title, null, thread.createdAt, thread.updatedAt);

    return thread;
  }

  updateTeammateDirectThreadWorkspace(threadId: string, workspaceBinding: DirectWorkspaceBinding | null, now: string): TeammateDirectThread | undefined {
    const existing = this.context.database.prepare(teammateDirectThreadSelectSql("WHERE id = ?")).get(threadId);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare(`
        UPDATE teammate_direct_threads
        SET workspace_binding_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(workspaceBinding ? stringifyJson(workspaceBinding) : null, now, threadId);
    const updated = this.context.database.prepare(teammateDirectThreadSelectSql("WHERE id = ?")).get(threadId);
    return updated ? mapTeammateDirectThread(updated as Record<string, SQLOutputValue>) : undefined;
  }

  listTeammateDirectMessages(options: ListTeammateDirectMessagesOptions): TeammateDirectMessage[] {
    return this.listTeammateDirectMessagesPage(options).messages.slice();
  }

  listTeammateDirectMessagesPage(options: ListTeammateDirectMessagesOptions): TeammateDirectMessageListPage {
    const clauses = ["workspace_id = ?", "teammate_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.teammateId];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.beforeMessageId) {
      const cursor = this.context.database
        .prepare("SELECT teammate_id, thread_id, created_at, rowid FROM teammate_direct_messages WHERE workspace_id = ? AND id = ?")
        .get(DEFAULT_WORKSPACE_ID, options.beforeMessageId);
      if (!cursor || readString(cursor as Record<string, SQLOutputValue>, "teammate_id") !== options.teammateId) {
        throw new Error(`Invalid teammate direct message cursor: ${options.beforeMessageId}`);
      }
      const cursorThreadId = readString(cursor as Record<string, SQLOutputValue>, "thread_id");
      if (options.threadId && options.threadId !== cursorThreadId) {
        throw new Error(`Invalid teammate direct message cursor: ${options.beforeMessageId}`);
      }
      clauses.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
      const cursorCreatedAt = readString(cursor as Record<string, SQLOutputValue>, "created_at");
      params.push(cursorCreatedAt, cursorCreatedAt, readNumber(cursor as Record<string, SQLOutputValue>, "rowid"));
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit + 1);
    const rows = this.context.database
      .prepare(`${teammateDirectMessageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapTeammateDirectMessage(row as Record<string, SQLOutputValue>));
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse();
    return {
      messages,
      hasMore,
      nextBeforeMessageId: hasMore && messages.length > 0 ? messages[0].id : undefined,
    };
  }

  getTeammateDirectMessage(id: string): TeammateDirectMessage | undefined {
    const row = this.context.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    return row ? mapTeammateDirectMessage(row as Record<string, SQLOutputValue>) : undefined;
  }

  createTeammateDirectMessage(input: CreateTeammateDirectMessageInput, now: string): TeammateDirectMessage {
    this.assertTeammateExists(input.teammateId);
    const thread = this.getOrCreateTeammateDirectThread(input.teammateId, now);
    if (thread.id !== input.threadId) {
      throw new Error(`Direct thread does not belong to teammate: ${input.threadId}`);
    }
    const attachmentIds = normalizeStringList(input.attachmentIds ?? []);
    const linkPreviewIds = normalizeStringList(input.linkPreviewIds ?? []);
    const fileRefs = normalizeChannelMessageFileRefs(input.fileRefs);
    if (attachmentIds.length > 10) {
      throw new Error("A teammate direct message can reference at most 10 attachments");
    }
    for (const attachmentId of attachmentIds) {
      this.assertThreadAttachment(input.teammateId, input.threadId, attachmentId);
    }
    for (const linkPreviewId of linkPreviewIds) {
      this.assertThreadLinkPreview(input.teammateId, input.threadId, linkPreviewId);
    }

    const message: TeammateDirectMessage = {
      id: createTeammateDirectMessageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      threadId: input.threadId,
      teammateId: input.teammateId,
      authorType: input.authorType,
      authorId: input.authorId,
      body: input.body,
      attachmentIds,
      linkPreviewIds,
      fileRefs,
      status: input.status ?? "ready",
      errorMessage: input.errorMessage,
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO teammate_direct_messages (
          id,
          workspace_id,
          thread_id,
          teammate_id,
          author_type,
          author_id,
          body,
          attachment_ids_json,
          link_preview_ids_json,
          file_refs_json,
          status,
          error_message,
          linked_task_id,
          linked_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.workspaceId,
        message.threadId,
        message.teammateId,
        message.authorType,
        message.authorId ?? null,
        message.body,
        stringifyJson(message.attachmentIds),
        stringifyJson(message.linkPreviewIds),
        stringifyJson(message.fileRefs),
        message.status,
        message.errorMessage ?? null,
        message.linkedTaskId ?? null,
        message.linkedRunId ?? null,
        message.createdAt,
        message.updatedAt,
      );

    const created = this.context.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(message.id);
    if (!created) {
      throw new Error(`Failed to create teammate direct message: ${message.id}`);
    }
    return mapTeammateDirectMessage(created as Record<string, SQLOutputValue>);
  }

  updateTeammateDirectMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: TeammateDirectMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): TeammateDirectMessage | undefined {
    const existing = this.context.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    if (!existing) {
      return undefined;
    }
    const current = mapTeammateDirectMessage(existing as Record<string, SQLOutputValue>);
    this.context.database
      .prepare(`
        UPDATE teammate_direct_messages
        SET
          body = ?,
          status = ?,
          error_message = ?,
          linked_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.body ?? current.body,
        input.status ?? current.status,
        input.errorMessage === undefined ? current.errorMessage ?? null : input.errorMessage,
        input.linkedRunId === undefined ? current.linkedRunId ?? null : input.linkedRunId,
        now,
        id,
      );
    const updated = this.context.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    return updated ? mapTeammateDirectMessage(updated as Record<string, SQLOutputValue>) : undefined;
  }

  createTeammateDirectLinkPreview(input: CreateTeammateDirectLinkPreviewInput, now: string): TeammateDirectLinkPreview {
    this.assertTeammateExists(input.teammateId);
    const thread = this.getOrCreateTeammateDirectThread(input.teammateId, now);
    if (thread.id !== input.threadId) {
      throw new Error(`Direct thread does not belong to teammate: ${input.threadId}`);
    }
    if (input.messageId) {
      this.assertThreadMessage(input.teammateId, input.threadId, input.messageId);
    }
    const preview: TeammateDirectLinkPreview = {
      id: createTeammateDirectLinkPreviewId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId: input.teammateId,
      threadId: input.threadId,
      messageId: input.messageId,
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      title: input.title,
      description: input.description,
      imageUrl: input.imageUrl,
      siteName: input.siteName,
      status: input.status,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO teammate_direct_link_previews (
          id,
          workspace_id,
          teammate_id,
          thread_id,
          message_id,
          url,
          normalized_url,
          title,
          description,
          image_url,
          site_name,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        preview.id,
        preview.workspaceId,
        preview.teammateId,
        preview.threadId,
        preview.messageId ?? null,
        preview.url,
        preview.normalizedUrl,
        preview.title ?? null,
        preview.description ?? null,
        preview.imageUrl ?? null,
        preview.siteName ?? null,
        preview.status,
        preview.errorMessage ?? null,
        preview.createdAt,
        preview.updatedAt,
      );
    const created = this.getTeammateDirectLinkPreview(preview.id);
    if (!created) {
      throw new Error(`Failed to create teammate direct link preview: ${preview.id}`);
    }
    return created;
  }

  getTeammateDirectLinkPreview(id: string): TeammateDirectLinkPreview | undefined {
    const row = this.context.database.prepare(teammateDirectLinkPreviewSelectSql("WHERE id = ?")).get(id);
    return row ? mapTeammateDirectLinkPreview(row as Record<string, SQLOutputValue>) : undefined;
  }

  listTeammateDirectLinkPreviews(options: ListTeammateDirectLinkPreviewsOptions): TeammateDirectLinkPreview[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.context.database
      .prepare(`${teammateDirectLinkPreviewSelectSql("WHERE workspace_id = ? AND teammate_id = ? AND thread_id = ?")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.teammateId, options.threadId, limit)
      .map((row) => mapTeammateDirectLinkPreview(row as Record<string, SQLOutputValue>));
  }

  updateTeammateDirectLinkPreview(id: string, input: UpdateTeammateDirectLinkPreviewInput, now: string): TeammateDirectLinkPreview | undefined {
    const existing = this.getTeammateDirectLinkPreview(id);
    if (!existing) {
      return undefined;
    }
    const next: TeammateDirectLinkPreview = {
      ...existing,
      title: nullableUpdate(input.title, existing.title),
      description: nullableUpdate(input.description, existing.description),
      imageUrl: nullableUpdate(input.imageUrl, existing.imageUrl),
      siteName: nullableUpdate(input.siteName, existing.siteName),
      status: input.status ?? existing.status,
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        UPDATE teammate_direct_link_previews
        SET
          title = ?,
          description = ?,
          image_url = ?,
          site_name = ?,
          status = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title ?? null,
        next.description ?? null,
        next.imageUrl ?? null,
        next.siteName ?? null,
        next.status,
        next.errorMessage ?? null,
        next.updatedAt,
        id,
      );
    return this.getTeammateDirectLinkPreview(id);
  }

  createTeammateDirectReplyIntervention(input: CreateTeammateDirectReplyInterventionInput, now: string): TeammateDirectReplyIntervention {
    this.assertTeammateExists(input.teammateId);
    const thread = this.getOrCreateTeammateDirectThread(input.teammateId, now);
    if (thread.id !== input.threadId) {
      throw new Error(`Direct thread does not belong to teammate: ${input.threadId}`);
    }
    this.assertThreadMessage(input.teammateId, input.threadId, input.sourceMessageId);
    const existing = this.context.database
      .prepare(teammateDirectReplyInterventionSelectSql("WHERE workspace_id = ? AND teammate_id = ? AND thread_id = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, input.teammateId, input.threadId, input.idempotencyKey);
    if (existing) {
      return mapTeammateDirectReplyIntervention(existing as Record<string, SQLOutputValue>);
    }
    const messagePayload = input.messagePayload ? normalizeTeammateDirectReplyInterventionMessagePayload(input.messagePayload) : undefined;
    if (messagePayload) {
      if (messagePayload.attachmentIds.length > 10) {
        throw new Error("A teammate direct reply intervention can reference at most 10 attachments");
      }
      for (const attachmentId of messagePayload.attachmentIds) {
        this.assertThreadAttachment(input.teammateId, input.threadId, attachmentId);
      }
      for (const linkPreviewId of messagePayload.linkPreviewIds) {
        this.assertThreadLinkPreview(input.teammateId, input.threadId, linkPreviewId);
      }
    }

    const intervention: TeammateDirectReplyIntervention = {
      id: input.id ?? createTeammateDirectReplyInterventionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId: input.teammateId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      sourceWorkUnitId: input.sourceWorkUnitId,
      mode: input.mode,
      status: "queued",
      instruction: input.instruction,
      messagePayload,
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy ?? "local-user",
      createdAt: now,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO teammate_direct_reply_interventions (
          id,
          workspace_id,
          teammate_id,
          thread_id,
          source_message_id,
          source_work_unit_id,
          mode,
          status,
          instruction,
          message_payload_json,
          idempotency_key,
          requested_by,
          continuation_message_id,
          continuation_work_unit_id,
          created_at,
          updated_at,
          started_at,
          completed_at,
          failure_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        intervention.id,
        intervention.workspaceId,
        intervention.teammateId,
        intervention.threadId,
        intervention.sourceMessageId,
        intervention.sourceWorkUnitId ?? null,
        intervention.mode,
        intervention.status,
        intervention.instruction,
        intervention.messagePayload ? stringifyJson(intervention.messagePayload) : null,
        intervention.idempotencyKey,
        intervention.requestedBy,
        intervention.continuationMessageId ?? null,
        intervention.continuationWorkUnitId ?? null,
        intervention.createdAt,
        intervention.updatedAt,
        intervention.startedAt ?? null,
        intervention.completedAt ?? null,
        intervention.failureReason ?? null,
      );
    const created = this.getTeammateDirectReplyIntervention(intervention.id);
    if (!created) {
      throw new Error(`Failed to create teammate direct reply intervention: ${intervention.id}`);
    }
    return created;
  }

  getTeammateDirectReplyIntervention(interventionId: string): TeammateDirectReplyIntervention | undefined {
    const row = this.context.database.prepare(teammateDirectReplyInterventionSelectSql("WHERE id = ?")).get(interventionId);
    return row ? mapTeammateDirectReplyIntervention(row as Record<string, SQLOutputValue>) : undefined;
  }

  listTeammateDirectReplyInterventions(options: ListTeammateDirectReplyInterventionsOptions = {}): TeammateDirectReplyIntervention[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.sourceWorkUnitId) {
      clauses.push("source_work_unit_id = ?");
      params.push(options.sourceWorkUnitId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.mode) {
      clauses.push("mode = ?");
      params.push(options.mode);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${teammateDirectReplyInterventionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(...params)
      .map((row) => mapTeammateDirectReplyIntervention(row as Record<string, SQLOutputValue>));
  }

  updateTeammateDirectReplyInterventionStatus(input: UpdateTeammateDirectReplyInterventionStatusInput): TeammateDirectReplyIntervention | undefined {
    const existing = this.getTeammateDirectReplyIntervention(input.interventionId);
    if (!existing) {
      return undefined;
    }
    const continuationMessageId = input.continuationMessageId === undefined ? existing.continuationMessageId ?? null : input.continuationMessageId;
    const continuationWorkUnitId = input.continuationWorkUnitId === undefined ? existing.continuationWorkUnitId ?? null : input.continuationWorkUnitId;
    const startedAt = input.startedAt === undefined ? existing.startedAt ?? null : input.startedAt;
    const completedAt = input.completedAt === undefined ? existing.completedAt ?? null : input.completedAt;
    const failureReason = input.failureReason === undefined ? existing.failureReason ?? null : input.failureReason;
    this.context.database
      .prepare(`
        UPDATE teammate_direct_reply_interventions
        SET status = ?,
            continuation_message_id = ?,
            continuation_work_unit_id = ?,
            updated_at = ?,
            started_at = ?,
            completed_at = ?,
            failure_reason = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        continuationMessageId,
        continuationWorkUnitId,
        input.now,
        startedAt,
        completedAt,
        failureReason,
        input.interventionId,
      );
    return this.getTeammateDirectReplyIntervention(input.interventionId);
  }

  cancelTeammateDirectReplyIntervention(interventionId: string, now: string, reason?: string): TeammateDirectReplyIntervention | undefined {
    const existing = this.getTeammateDirectReplyIntervention(interventionId);
    if (!existing) {
      return undefined;
    }
    if (existing.status === "started" || existing.status === "cancelled" || existing.status === "failed") {
      return existing;
    }
    return this.updateTeammateDirectReplyInterventionStatus({
      interventionId,
      status: "cancelled",
      completedAt: now,
      failureReason: reason ?? "cancelled",
      now,
    });
  }

  createTeammatePrivateAttachment(input: CreateTeammatePrivateAttachmentInput): TeammatePrivateAttachment {
    this.assertTeammateExists(input.teammateId);
    if (input.scope === "teammate_direct_thread") {
      if (!input.threadId) {
        throw new Error("threadId is required for teammate_direct_thread attachments");
      }
      const thread = this.getOrCreateTeammateDirectThread(input.teammateId, input.createdAt ?? new Date().toISOString());
      if (thread.id !== input.threadId) {
        throw new Error(`Direct thread does not belong to teammate: ${input.threadId}`);
      }
      if (input.messageId) {
        this.assertThreadMessage(input.teammateId, input.threadId, input.messageId);
      }
    }
    if (input.scope === "teammate_profile_avatar" && input.kind !== "image") {
      throw new Error("Avatar attachments must be images");
    }
    const attachment: TeammatePrivateAttachment = {
      id: createTeammatePrivateAttachmentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId: input.teammateId,
      threadId: input.threadId,
      messageId: input.messageId,
      scope: input.scope,
      kind: input.kind,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      path: input.path,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.context.database
      .prepare(`
        INSERT INTO teammate_private_attachments (
          id,
          workspace_id,
          teammate_id,
          thread_id,
          message_id,
          scope,
          kind,
          file_name,
          content_type,
          size_bytes,
          path,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attachment.id,
        attachment.workspaceId,
        attachment.teammateId,
        attachment.threadId ?? null,
        attachment.messageId ?? null,
        attachment.scope,
        attachment.kind,
        attachment.fileName,
        attachment.contentType,
        attachment.sizeBytes,
        attachment.path,
        attachment.createdAt,
      );
    const created = this.getTeammatePrivateAttachment(attachment.id);
    if (!created) {
      throw new Error(`Failed to create teammate private attachment: ${attachment.id}`);
    }
    return created;
  }

  getTeammatePrivateAttachment(id: string): TeammatePrivateAttachment | undefined {
    const row = this.context.database.prepare(teammatePrivateAttachmentSelectSql("WHERE id = ?")).get(id);
    return row ? mapTeammatePrivateAttachment(row as Record<string, SQLOutputValue>) : undefined;
  }

  listTeammatePrivateAttachments(options: ListTeammatePrivateAttachmentsOptions): TeammatePrivateAttachment[] {
    const clauses = ["workspace_id = ?", "teammate_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.teammateId];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.scope) {
      clauses.push("scope = ?");
      params.push(options.scope);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${teammatePrivateAttachmentSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapTeammatePrivateAttachment(row as Record<string, SQLOutputValue>));
  }

  deleteTeammatePrivateAttachment(id: string): boolean {
    const result = this.context.database.prepare("DELETE FROM teammate_private_attachments WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  private assertTeammateExists(teammateId: string): void {
    if (!this.ports.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
  }

  private assertThreadMessage(teammateId: string, threadId: string, messageId: string): TeammateDirectMessage {
    const message = this.getTeammateDirectMessage(messageId);
    if (!message || message.teammateId !== teammateId || message.threadId !== threadId) {
      throw new Error(`Direct message does not belong to teammate direct thread: ${messageId}`);
    }
    return message;
  }

  private assertThreadAttachment(teammateId: string, threadId: string, attachmentId: string): TeammatePrivateAttachment {
    const attachment = this.getTeammatePrivateAttachment(attachmentId);
    if (!attachment || attachment.teammateId !== teammateId || attachment.threadId !== threadId || attachment.scope !== "teammate_direct_thread") {
      throw new Error(`Private attachment does not belong to teammate direct thread: ${attachmentId}`);
    }
    return attachment;
  }

  private assertThreadLinkPreview(teammateId: string, threadId: string, linkPreviewId: string): TeammateDirectLinkPreview {
    const linkPreview = this.getTeammateDirectLinkPreview(linkPreviewId);
    if (!linkPreview || linkPreview.teammateId !== teammateId || linkPreview.threadId !== threadId) {
      throw new Error(`Link preview does not belong to teammate direct thread: ${linkPreviewId}`);
    }
    return linkPreview;
  }
}

function normalizeStringList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
