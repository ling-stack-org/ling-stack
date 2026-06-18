import type { SQLOutputValue } from "node:sqlite";
import {
  createChannelInputMaterializationId,
  type ChannelInputMaterialization,
  type CreateChannelInputMaterializationInput,
  type ListChannelInputMaterializationsOptions,
} from "../../input-materialization-types.js";
import {
  DEFAULT_WORKSPACE_ID,
  createChannelAttachmentId,
  createChannelLinkPreviewId,
  type ChannelAttachment,
  type ChannelLinkPreview,
  type CreateChannelAttachmentInput,
  type CreateChannelLinkPreviewInput,
  type ListChannelAttachmentsOptions,
  type ListChannelLinkPreviewsOptions,
  type UpdateChannelLinkPreviewInput,
} from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import {
  mapChannelAttachment,
  mapChannelInputMaterialization,
  mapChannelLinkPreview,
} from "./channel-asset-mappers.js";
import {
  channelAttachmentSelectSql,
  channelInputMaterializationSelectSql,
  channelLinkPreviewSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelAssetStorePorts {
  readonly hasChannel: (id: string) => boolean;
}

export class SqliteChannelAssetStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelAssetStorePorts,
  ) {}

  createChannelAttachment(input: CreateChannelAttachmentInput): ChannelAttachment {
    if (!this.ports.hasChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const attachment: ChannelAttachment = {
      id: createChannelAttachmentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      messageId: input.messageId,
      kind: input.kind,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      path: input.path,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.context.database
      .prepare(`
        INSERT INTO channel_attachments (
          id,
          workspace_id,
          channel_id,
          message_id,
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
        attachment.channelId,
        attachment.messageId ?? null,
        attachment.kind,
        attachment.fileName,
        attachment.contentType,
        attachment.sizeBytes,
        attachment.path,
        attachment.createdAt,
      );

    const created = this.getChannelAttachment(attachment.id);
    if (!created) {
      throw new Error(`Failed to create channel attachment: ${attachment.id}`);
    }
    return created;
  }

  getChannelAttachment(id: string): ChannelAttachment | undefined {
    const row = this.context.database.prepare(channelAttachmentSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelAttachment(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelAttachments(options: ListChannelAttachmentsOptions): ChannelAttachment[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.context.database
      .prepare(`${channelAttachmentSelectSql("WHERE workspace_id = ? AND channel_id = ?")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.channelId, limit)
      .map((row) => mapChannelAttachment(row as Record<string, SQLOutputValue>));
  }

  deleteChannelAttachment(id: string): boolean {
    const result = this.context.database.prepare("DELETE FROM channel_attachments WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createChannelLinkPreview(input: CreateChannelLinkPreviewInput, now: string): ChannelLinkPreview {
    if (!this.ports.hasChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const preview: ChannelLinkPreview = {
      id: createChannelLinkPreviewId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
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
        INSERT INTO channel_link_previews (
          id,
          workspace_id,
          channel_id,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        preview.id,
        preview.workspaceId,
        preview.channelId,
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

    const created = this.getChannelLinkPreview(preview.id);
    if (!created) {
      throw new Error(`Failed to create channel link preview: ${preview.id}`);
    }
    return created;
  }

  getChannelLinkPreview(id: string): ChannelLinkPreview | undefined {
    const row = this.context.database.prepare(channelLinkPreviewSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelLinkPreview(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelLinkPreviews(options: ListChannelLinkPreviewsOptions): ChannelLinkPreview[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.context.database
      .prepare(`${channelLinkPreviewSelectSql("WHERE workspace_id = ? AND channel_id = ?")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.channelId, limit)
      .map((row) => mapChannelLinkPreview(row as Record<string, SQLOutputValue>));
  }

  updateChannelLinkPreview(id: string, input: UpdateChannelLinkPreviewInput, now: string): ChannelLinkPreview | undefined {
    const existing = this.getChannelLinkPreview(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelLinkPreview = {
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
        UPDATE channel_link_previews
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
    return this.getChannelLinkPreview(id);
  }

  createChannelInputMaterialization(
    input: CreateChannelInputMaterializationInput,
    now: string,
  ): ChannelInputMaterialization {
    if (!this.ports.hasChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const materialization: ChannelInputMaterialization = {
      id: createChannelInputMaterializationId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceFingerprint: input.sourceFingerprint,
      extractorId: input.extractorId,
      extractorVersion: input.extractorVersion,
      contentKind: input.contentKind,
      status: input.status,
      contentText: input.contentText,
      structuredSummaryJson: input.structuredSummaryJson,
      byteCount: input.byteCount,
      tokenEstimate: input.tokenEstimate,
      truncated: input.truncated ?? false,
      policyDecisionJson: input.policyDecisionJson,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };
    this.context.database
      .prepare(`
        INSERT INTO channel_input_materializations (
          id,
          workspace_id,
          channel_id,
          source_kind,
          source_id,
          source_fingerprint,
          extractor_id,
          extractor_version,
          content_kind,
          status,
          content_text,
          structured_summary_json,
          byte_count,
          token_estimate,
          truncated,
          policy_decision_json,
          error_code,
          error_message,
          created_at,
          updated_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, source_kind, source_id, source_fingerprint, extractor_id)
        DO UPDATE SET
          extractor_version = excluded.extractor_version,
          content_kind = excluded.content_kind,
          status = excluded.status,
          content_text = excluded.content_text,
          structured_summary_json = excluded.structured_summary_json,
          byte_count = excluded.byte_count,
          token_estimate = excluded.token_estimate,
          truncated = excluded.truncated,
          policy_decision_json = excluded.policy_decision_json,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .run(
        materialization.id,
        materialization.workspaceId,
        materialization.channelId,
        materialization.sourceKind,
        materialization.sourceId,
        materialization.sourceFingerprint,
        materialization.extractorId,
        materialization.extractorVersion,
        materialization.contentKind,
        materialization.status,
        materialization.contentText ?? null,
        materialization.structuredSummaryJson ? stringifyJson(materialization.structuredSummaryJson) : null,
        materialization.byteCount ?? null,
        materialization.tokenEstimate ?? null,
        materialization.truncated ? 1 : 0,
        materialization.policyDecisionJson ? stringifyJson(materialization.policyDecisionJson) : null,
        materialization.errorCode ?? null,
        materialization.errorMessage ?? null,
        materialization.createdAt,
        materialization.updatedAt,
        materialization.expiresAt ?? null,
      );

    const created = this.context.database
      .prepare(channelInputMaterializationSelectSql(`
        WHERE workspace_id = ?
          AND channel_id = ?
          AND source_kind = ?
          AND source_id = ?
          AND source_fingerprint = ?
          AND extractor_id = ?
      `))
      .get(
        DEFAULT_WORKSPACE_ID,
        input.channelId,
        input.sourceKind,
        input.sourceId,
        input.sourceFingerprint,
        input.extractorId,
      );
    if (!created) {
      throw new Error(`Failed to create channel input materialization for source: ${input.sourceKind}:${input.sourceId}`);
    }
    return mapChannelInputMaterialization(created as Record<string, SQLOutputValue>);
  }

  getChannelInputMaterialization(id: string): ChannelInputMaterialization | undefined {
    const row = this.context.database.prepare(channelInputMaterializationSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelInputMaterialization(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelInputMaterializations(options: ListChannelInputMaterializationsOptions): ChannelInputMaterialization[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const conditions = ["workspace_id = ?", "channel_id = ?"];
    const values: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.sourceKind) {
      conditions.push("source_kind = ?");
      values.push(options.sourceKind);
    }
    if (options.sourceId) {
      conditions.push("source_id = ?");
      values.push(options.sourceId);
    }
    if (options.status) {
      conditions.push("status = ?");
      values.push(options.status);
    }
    values.push(limit);
    return this.context.database
      .prepare(`${channelInputMaterializationSelectSql(`WHERE ${conditions.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...values)
      .map((row) => mapChannelInputMaterialization(row as Record<string, SQLOutputValue>));
  }
}
