import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  channelAutoReplyModes,
  channelProtocolDraftCreatedByValues,
  channelProtocolDraftStatuses,
  channelWorkflowPreferences,
  createChannelCollaborationProtocolDraftId,
  createChannelCollaborationProtocolOverrideId,
  type ChannelCollaborationProtocolDraft,
  type ChannelCollaborationProtocolOverride,
  type ChannelCollaborationProtocolPatch,
  type ChannelProtocolDraftStatus,
  type ChannelProtocolSourceRef,
  type ChannelProtocolSourceRefType,
  type CreateChannelCollaborationProtocolDraftInput,
  type UpsertChannelCollaborationProtocolOverrideInput,
} from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import {
  mapChannelCollaborationProtocolDraft,
  mapChannelCollaborationProtocolOverride,
} from "./channel-protocol-mappers.js";
import {
  channelCollaborationProtocolDraftSelectSql,
  channelCollaborationProtocolOverrideSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelProtocolStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly assertChannelProtocolSourceRefsInChannel: (channelId: string, sourceRefs: readonly ChannelProtocolSourceRef[]) => void;
}

export class SqliteChannelProtocolStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelProtocolStorePorts,
  ) {}

  getChannelCollaborationProtocolOverride(channelId: string): ChannelCollaborationProtocolOverride | undefined {
    const row = this.context.database
      .prepare(channelCollaborationProtocolOverrideSelectSql("WHERE channel_id = ? AND workspace_id = ?"))
      .get(channelId, DEFAULT_WORKSPACE_ID);
    return row ? mapChannelCollaborationProtocolOverride(row as Record<string, SQLOutputValue>) : undefined;
  }

  upsertChannelCollaborationProtocolOverride(
    input: UpsertChannelCollaborationProtocolOverrideInput,
    now: string,
  ): ChannelCollaborationProtocolOverride {
    this.ports.assertChannelExists(input.channelId);
    this.ports.assertChannelProtocolSourceRefsInChannel(input.channelId, input.sourceRefs ?? []);
    validateChannelCollaborationProtocolOverrideInput(input);
    const existing = this.getChannelCollaborationProtocolOverride(input.channelId);
    const override: ChannelCollaborationProtocolOverride = {
      id: existing?.id ?? createChannelCollaborationProtocolOverrideId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      version: (existing?.version ?? 0) + 1,
      defaultWorkflowPreference: input.defaultWorkflowPreference ?? existing?.defaultWorkflowPreference ?? "manual",
      visibleMultiReplyMaxParticipants: input.visibleMultiReplyMaxParticipants ?? existing?.visibleMultiReplyMaxParticipants ?? 3,
      privacyRules: input.privacyRules ?? existing?.privacyRules ?? [],
      reviewRules: input.reviewRules ?? existing?.reviewRules ?? [],
      sourceRefs: input.sourceRefs ?? existing?.sourceRefs ?? [],
      updatedBy: input.updatedBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO channel_collaboration_protocols (
          id,
          workspace_id,
          channel_id,
          version,
          default_workflow_preference,
          visible_multi_reply_max_participants,
          privacy_rules_json,
          review_rules_json,
          source_refs_json,
          updated_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, channel_id) DO UPDATE SET
          version = excluded.version,
          default_workflow_preference = excluded.default_workflow_preference,
          visible_multi_reply_max_participants = excluded.visible_multi_reply_max_participants,
          privacy_rules_json = excluded.privacy_rules_json,
          review_rules_json = excluded.review_rules_json,
          source_refs_json = excluded.source_refs_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `)
      .run(
        override.id,
        override.workspaceId,
        override.channelId,
        override.version,
        override.defaultWorkflowPreference,
        override.visibleMultiReplyMaxParticipants,
        stringifyJson(override.privacyRules),
        stringifyJson(override.reviewRules),
        stringifyJson(override.sourceRefs),
        override.updatedBy,
        override.createdAt,
        override.updatedAt,
      );
    const saved = this.getChannelCollaborationProtocolOverride(input.channelId);
    if (!saved) {
      throw new Error(`Failed to save channel collaboration protocol override: ${input.channelId}`);
    }
    return saved;
  }

  deleteChannelCollaborationProtocolOverride(channelId: string): boolean {
    const result = this.context.database
      .prepare("DELETE FROM channel_collaboration_protocols WHERE workspace_id = ? AND channel_id = ?")
      .run(DEFAULT_WORKSPACE_ID, channelId);
    return result.changes > 0;
  }

  createChannelCollaborationProtocolDraft(
    input: CreateChannelCollaborationProtocolDraftInput,
    now: string,
  ): ChannelCollaborationProtocolDraft {
    this.ports.assertChannelExists(input.channelId);
    this.ports.assertChannelProtocolSourceRefsInChannel(input.channelId, input.sourceRefs ?? []);
    validateChannelCollaborationProtocolDraftInput(input);
    const draft: ChannelCollaborationProtocolDraft = {
      id: createChannelCollaborationProtocolDraftId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      baseVersion: input.baseVersion,
      proposedPatch: input.proposedPatch,
      reason: input.reason,
      createdBy: input.createdBy,
      sourceRefs: input.sourceRefs ?? [],
      status: "draft",
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO channel_collaboration_protocol_drafts (
          id,
          workspace_id,
          channel_id,
          base_version,
          proposed_patch_json,
          reason,
          created_by,
          source_refs_json,
          status,
          applied_protocol_version,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        draft.id,
        draft.workspaceId,
        draft.channelId,
        draft.baseVersion ?? null,
        stringifyJson(draft.proposedPatch),
        draft.reason,
        draft.createdBy,
        stringifyJson(draft.sourceRefs),
        draft.status,
        draft.appliedProtocolVersion ?? null,
        draft.expiresAt ?? null,
        draft.createdAt,
        draft.updatedAt,
      );
    const saved = this.getChannelCollaborationProtocolDraft(draft.id);
    if (!saved) {
      throw new Error(`Failed to create channel collaboration protocol draft: ${draft.id}`);
    }
    return saved;
  }

  getChannelCollaborationProtocolDraft(id: string): ChannelCollaborationProtocolDraft | undefined {
    const row = this.context.database.prepare(channelCollaborationProtocolDraftSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelCollaborationProtocolDraft(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelCollaborationProtocolDrafts(options: {
    readonly channelId: string;
    readonly status?: ChannelProtocolDraftStatus;
    readonly limit?: number;
  }): ChannelCollaborationProtocolDraft[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    params.push(limit);
    return this.context.database
      .prepare(`${channelCollaborationProtocolDraftSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelCollaborationProtocolDraft(row as Record<string, SQLOutputValue>));
  }

  updateChannelCollaborationProtocolDraft(
    id: string,
    input: { readonly status?: ChannelProtocolDraftStatus; readonly appliedProtocolVersion?: number | null },
    now: string,
  ): ChannelCollaborationProtocolDraft | undefined {
    const existing = this.getChannelCollaborationProtocolDraft(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelCollaborationProtocolDraft = {
      ...existing,
      status: input.status ?? existing.status,
      appliedProtocolVersion: nullableUpdate(input.appliedProtocolVersion, existing.appliedProtocolVersion),
      updatedAt: now,
    };
    if (!channelProtocolDraftStatuses.includes(next.status)) {
      throw new Error("channel protocol draft status is not supported");
    }
    this.context.database
      .prepare(`
        UPDATE channel_collaboration_protocol_drafts
        SET status = ?, applied_protocol_version = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.status, next.appliedProtocolVersion ?? null, next.updatedAt, id);
    return this.getChannelCollaborationProtocolDraft(id);
  }
}

function validateChannelCollaborationProtocolOverrideInput(input: UpsertChannelCollaborationProtocolOverrideInput): void {
  if (input.defaultWorkflowPreference !== undefined && !channelWorkflowPreferences.includes(input.defaultWorkflowPreference)) {
    throw new Error("channel protocol workflow preference is not supported");
  }
  if (
    input.visibleMultiReplyMaxParticipants !== undefined &&
    (!Number.isInteger(input.visibleMultiReplyMaxParticipants) || input.visibleMultiReplyMaxParticipants < 1 || input.visibleMultiReplyMaxParticipants > 8)
  ) {
    throw new Error("channel protocol visible multi-reply max participants must be between 1 and 8");
  }
  if (!channelProtocolDraftCreatedByValues.includes(input.updatedBy)) {
    throw new Error("channel protocol updatedBy is not supported");
  }
  validateStringList(input.privacyRules ?? [], "channel protocol privacy rules");
  validateStringList(input.reviewRules ?? [], "channel protocol review rules");
  validateChannelProtocolSourceRefs(input.sourceRefs ?? []);
}

function validateChannelCollaborationProtocolDraftInput(input: CreateChannelCollaborationProtocolDraftInput): void {
  if (input.baseVersion !== undefined && (!Number.isInteger(input.baseVersion) || input.baseVersion < 0)) {
    throw new Error("channel protocol draft baseVersion must be a non-negative integer");
  }
  validateChannelCollaborationProtocolPatch(input.proposedPatch);
  validateNonEmptyString(input.reason, "channel protocol draft reason");
  if (!channelProtocolDraftCreatedByValues.includes(input.createdBy)) {
    throw new Error("channel protocol draft createdBy is not supported");
  }
  validateChannelProtocolSourceRefs(input.sourceRefs ?? []);
}

function validateChannelCollaborationProtocolPatch(patch: ChannelCollaborationProtocolPatch): void {
  if (Object.keys(patch).length === 0) {
    throw new Error("channel protocol patch must include at least one field");
  }
  if (patch.responseLanguage !== undefined && patch.responseLanguage !== null && !parseOptionalChannelResponseLanguage(patch.responseLanguage)) {
    throw new Error("channel protocol responseLanguage is not supported");
  }
  if (patch.autoReplyMode !== undefined && patch.autoReplyMode !== null && !channelAutoReplyModes.includes(patch.autoReplyMode)) {
    throw new Error("channel protocol autoReplyMode is not supported");
  }
  if (patch.defaultTeammateId !== undefined && patch.defaultTeammateId !== null) {
    validateNonEmptyString(patch.defaultTeammateId, "channel protocol default teammate id");
  }
  if (patch.defaultWorkflowPreference !== undefined && !channelWorkflowPreferences.includes(patch.defaultWorkflowPreference)) {
    throw new Error("channel protocol workflow preference is not supported");
  }
  if (
    patch.visibleMultiReplyMaxParticipants !== undefined &&
    (!Number.isInteger(patch.visibleMultiReplyMaxParticipants) || patch.visibleMultiReplyMaxParticipants < 1 || patch.visibleMultiReplyMaxParticipants > 8)
  ) {
    throw new Error("channel protocol visible multi-reply max participants must be between 1 and 8");
  }
  validateStringList(patch.privacyRules ?? [], "channel protocol privacy rules");
  validateStringList(patch.reviewRules ?? [], "channel protocol review rules");
}

function validateChannelProtocolSourceRefs(sourceRefs: readonly ChannelProtocolSourceRef[]): void {
  for (const sourceRef of sourceRefs) {
    if (!isChannelProtocolSourceRefTypeValue(sourceRef.type)) {
      throw new Error("channel protocol source ref type is not supported");
    }
    validateNonEmptyString(sourceRef.id, "channel protocol source ref id");
  }
}

function isChannelProtocolSourceRefTypeValue(value: unknown): value is ChannelProtocolSourceRefType {
  return (
    value === "message" ||
    value === "channel_decision" ||
    value === "context_summary" ||
    value === "task" ||
    value === "run" ||
    value === "workflow" ||
    value === "workflow_step"
  );
}

function parseOptionalChannelResponseLanguage(value: unknown): boolean {
  return value === "workspace" || value === "follow_user" || value === "zh-CN" || value === "en-US";
}

function validateNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}

function validateStringList(value: readonly string[], label: string): void {
  for (const item of value) {
    if (!item.trim()) {
      throw new Error(`${label} must not contain empty strings`);
    }
  }
}
