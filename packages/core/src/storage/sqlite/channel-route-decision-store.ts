import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  channelAutoReplyModes,
  channelMessageRouteDecisionCreatedByValues,
  channelMessageRouteDecisionStatuses,
  createChannelMessageRouteDecisionId,
  type ChannelMessage,
  type ChannelMessageRouteContextPackMetadata,
  type ChannelMessageRouteDecision,
  type CreateChannelMessageRouteDecisionInput,
  type ListChannelMessageRouteDecisionsOptions,
  type UpdateChannelMessageRouteDecisionInput,
} from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import { mapChannelMessageRouteDecision } from "./channel-routing-mappers.js";
import { channelMessageRouteDecisionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelRouteDecisionStorePorts {
  readonly hasChannel: (id: string) => boolean;
  readonly getChannelMessage: (id: string) => ChannelMessage | undefined;
}

export class SqliteChannelRouteDecisionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelRouteDecisionStorePorts,
  ) {}

  createChannelMessageRouteDecision(input: CreateChannelMessageRouteDecisionInput, now: string): ChannelMessageRouteDecision {
    validateChannelMessageRouteDecisionInput(input);
    if (!this.ports.hasChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const sourceMessage = this.ports.getChannelMessage(input.sourceMessageId);
    if (!sourceMessage || sourceMessage.channelId !== input.channelId) {
      throw new Error(`Source message does not belong to channel: ${input.sourceMessageId}`);
    }
    if (input.replyMessageId) {
      const replyMessage = this.ports.getChannelMessage(input.replyMessageId);
      if (!replyMessage || replyMessage.channelId !== input.channelId) {
        throw new Error(`Reply message does not belong to channel: ${input.replyMessageId}`);
      }
    }
    const decision: ChannelMessageRouteDecision = {
      schemaVersion: 1,
      id: createChannelMessageRouteDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      replyMessageId: input.replyMessageId,
      mode: input.mode,
      action: input.action,
      selectedTeammateId: input.selectedTeammateId,
      selectedProviderPresetId: input.selectedProviderPresetId,
      confidence: input.confidence,
      reason: input.reason,
      alternativesConsidered: input.alternativesConsidered ?? [],
      contextPack: input.contextPack,
      status: input.status,
      createdBy: input.createdBy,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_message_route_decisions (
          id,
          schema_version,
          workspace_id,
          channel_id,
          source_message_id,
          reply_message_id,
          mode,
          action,
          selected_teammate_id,
          selected_provider_preset_id,
          confidence,
          reason,
          alternatives_json,
          context_pack_json,
          status,
          created_by,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.schemaVersion,
        decision.workspaceId,
        decision.channelId,
        decision.sourceMessageId,
        decision.replyMessageId ?? null,
        decision.mode,
        decision.action,
        decision.selectedTeammateId ?? null,
        decision.selectedProviderPresetId ?? null,
        decision.confidence ?? null,
        decision.reason,
        stringifyJson(decision.alternativesConsidered),
        decision.contextPack ? stringifyJson(decision.contextPack) : null,
        decision.status,
        decision.createdBy,
        decision.errorMessage ?? null,
        decision.createdAt,
        decision.updatedAt,
      );

    const created = this.getChannelMessageRouteDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create channel message route decision: ${decision.id}`);
    }
    return created;
  }

  getChannelMessageRouteDecision(id: string): ChannelMessageRouteDecision | undefined {
    const row = this.context.database.prepare(channelMessageRouteDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelMessageRouteDecision(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelMessageRouteDecisions(options: ListChannelMessageRouteDecisionsOptions = {}): ChannelMessageRouteDecision[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceMessageId) {
      clauses.push("source_message_id = ?");
      params.push(options.sourceMessageId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelMessageRouteDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelMessageRouteDecision(row as Record<string, SQLOutputValue>));
  }

  updateChannelMessageRouteDecision(
    id: string,
    input: UpdateChannelMessageRouteDecisionInput,
    now: string,
  ): ChannelMessageRouteDecision | undefined {
    const existing = this.getChannelMessageRouteDecision(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelMessageRouteDecision = {
      ...existing,
      replyMessageId: nullableUpdate(input.replyMessageId, existing.replyMessageId),
      selectedProviderPresetId: nullableUpdate(input.selectedProviderPresetId, existing.selectedProviderPresetId),
      confidence: nullableUpdate(input.confidence, existing.confidence),
      reason: input.reason ?? existing.reason,
      alternativesConsidered: input.alternativesConsidered ?? existing.alternativesConsidered,
      contextPack: nullableUpdate(input.contextPack, existing.contextPack),
      status: input.status ?? existing.status,
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };
    validateChannelMessageRouteDecisionInput(next);
    if (next.replyMessageId) {
      const replyMessage = this.ports.getChannelMessage(next.replyMessageId);
      if (!replyMessage || replyMessage.channelId !== next.channelId) {
        throw new Error(`Reply message does not belong to channel: ${next.replyMessageId}`);
      }
    }

    this.context.database
      .prepare(`
        UPDATE channel_message_route_decisions
        SET
          reply_message_id = ?,
          selected_provider_preset_id = ?,
          confidence = ?,
          reason = ?,
          alternatives_json = ?,
          context_pack_json = ?,
          status = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.replyMessageId ?? null,
        next.selectedProviderPresetId ?? null,
        next.confidence ?? null,
        next.reason,
        stringifyJson(next.alternativesConsidered),
        next.contextPack ? stringifyJson(next.contextPack) : null,
        next.status,
        next.errorMessage ?? null,
        next.updatedAt,
        id,
      );

    return this.getChannelMessageRouteDecision(id);
  }
}

function validateChannelMessageRouteDecisionInput(
  decision: Pick<
    CreateChannelMessageRouteDecisionInput,
    "mode" | "action" | "confidence" | "reason" | "alternativesConsidered" | "contextPack" | "status" | "createdBy"
  >,
): void {
  if (!channelAutoReplyModes.includes(decision.mode)) {
    throw new Error("channel message route mode is not supported");
  }
  if (decision.action !== "reply" && decision.action !== "no_reply") {
    throw new Error("channel message route action is not supported");
  }
  if (!channelMessageRouteDecisionStatuses.includes(decision.status)) {
    throw new Error("channel message route status is not supported");
  }
  if (!channelMessageRouteDecisionCreatedByValues.includes(decision.createdBy)) {
    throw new Error("channel message route createdBy is not supported");
  }
  if (decision.confidence !== undefined && (decision.confidence < 0 || decision.confidence > 1)) {
    throw new Error("channel message route confidence must be between 0 and 1");
  }
  validateNonEmptyString(decision.reason, "channel message route reason");
  for (const alternative of decision.alternativesConsidered ?? []) {
    validateNonEmptyString(alternative.label, "channel message route alternative label");
    validateNonEmptyString(alternative.reason, "channel message route alternative reason");
    if (alternative.score !== undefined && (alternative.score < 0 || alternative.score > 1)) {
      throw new Error("channel message route alternative score must be between 0 and 1");
    }
  }
  validateChannelMessageRouteContextPackMetadata(decision.contextPack);
}

function validateChannelMessageRouteContextPackMetadata(
  metadata: ChannelMessageRouteContextPackMetadata | undefined,
): void {
  if (!metadata) {
    return;
  }
  if (metadata.schemaVersion !== 1) {
    throw new Error("channel message route context pack schemaVersion is not supported");
  }
  validateNonEmptyString(metadata.kind, "channel message route context pack kind");
  for (const sectionId of metadata.sectionIds) {
    validateNonEmptyString(sectionId, "channel message route context pack section id");
  }
  for (const sectionId of metadata.droppedSectionIds) {
    validateNonEmptyString(sectionId, "channel message route context pack dropped section id");
  }
  for (const compactionId of metadata.compactionIds) {
    validateNonEmptyString(compactionId, "channel message route context pack compaction id");
  }
  for (const [sourceType, count] of Object.entries(metadata.sourceRefCounts)) {
    validateNonEmptyString(sourceType, "channel message route context pack source ref type");
    if (!Number.isFinite(count) || count < 0) {
      throw new Error("channel message route context pack source ref count must be a non-negative number");
    }
  }
}

function validateNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}
