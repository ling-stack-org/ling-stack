import type { SQLOutputValue } from "node:sqlite";
import {
  channelAutoReplyModes,
  channelWorkflowPreferences,
  type ChannelAutoReplyMode,
  type ChannelCollaborationProtocolDraft,
  type ChannelCollaborationProtocolOverride,
  type ChannelCollaborationProtocolPatch,
  type ChannelProtocolDraftCreatedBy,
  type ChannelProtocolDraftStatus,
  type ChannelProtocolSourceRef,
  type ChannelProtocolSourceRefType,
  type ChannelResponseLanguage,
  type ChannelWorkflowPreference,
} from "../../workspace-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  parseJsonStringArray,
  readNullableNumber,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapChannelCollaborationProtocolOverride(row: Record<string, SQLOutputValue>): ChannelCollaborationProtocolOverride {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    version: readNumber(row, "version"),
    defaultWorkflowPreference: readString(row, "default_workflow_preference") as ChannelCollaborationProtocolOverride["defaultWorkflowPreference"],
    visibleMultiReplyMaxParticipants: readNumber(row, "visible_multi_reply_max_participants"),
    privacyRules: parseJsonStringArray(readString(row, "privacy_rules_json")),
    reviewRules: parseJsonStringArray(readString(row, "review_rules_json")),
    sourceRefs: parseChannelProtocolSourceRefs(readString(row, "source_refs_json")),
    updatedBy: readString(row, "updated_by") as ChannelCollaborationProtocolOverride["updatedBy"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapChannelCollaborationProtocolDraft(row: Record<string, SQLOutputValue>): ChannelCollaborationProtocolDraft {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    baseVersion: readNullableNumber(row, "base_version"),
    proposedPatch: parseChannelCollaborationProtocolPatch(readString(row, "proposed_patch_json")),
    reason: readString(row, "reason"),
    createdBy: readString(row, "created_by") as ChannelProtocolDraftCreatedBy,
    sourceRefs: parseChannelProtocolSourceRefs(readString(row, "source_refs_json")),
    status: readString(row, "status") as ChannelProtocolDraftStatus,
    appliedProtocolVersion: readNullableNumber(row, "applied_protocol_version"),
    expiresAt: readNullableString(row, "expires_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseChannelProtocolSourceRefs(value: string): ChannelProtocolSourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel protocol source refs array from SQLite");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Expected channel protocol source ref object from SQLite");
    }
    const record = item as Record<string, unknown>;
    if (!isChannelProtocolSourceRefTypeValue(record.type) || typeof record.id !== "string" || record.id.trim().length === 0) {
      throw new Error("Invalid channel protocol source ref from SQLite");
    }
    return omitUndefined({
      type: record.type,
      id: record.id,
      label: readOptionalStringValue(record.label),
    });
  });
}

function parseChannelCollaborationProtocolPatch(value: string): ChannelCollaborationProtocolPatch {
  const parsed = parseJsonObject(value);
  return normalizeChannelCollaborationProtocolPatch(parsed);
}

function normalizeChannelCollaborationProtocolPatch(record: Record<string, unknown>): ChannelCollaborationProtocolPatch {
  const patch = omitUndefined({
    responseLanguage: readNullableChannelResponseLanguageValue(record.responseLanguage, "responseLanguage"),
    autoReplyMode: readNullableChannelAutoReplyModeValue(record.autoReplyMode, "autoReplyMode"),
    defaultTeammateId: readNullableNonEmptyStringValue(record.defaultTeammateId, "defaultTeammateId"),
    defaultWorkflowPreference: readChannelWorkflowPreferenceValue(record.defaultWorkflowPreference, "defaultWorkflowPreference"),
    visibleMultiReplyMaxParticipants: readVisibleMultiReplyMaxParticipantsValue(record.visibleMultiReplyMaxParticipants, "visibleMultiReplyMaxParticipants"),
    privacyRules: readProtocolStringListValue(record.privacyRules, "privacyRules"),
    reviewRules: readProtocolStringListValue(record.reviewRules, "reviewRules"),
  });
  if (Object.keys(patch).length === 0) {
    throw new Error("channel protocol patch must include at least one field");
  }
  return patch;
}

function readNullableNonEmptyStringValue(value: unknown, label: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string or null`);
  }
  return value;
}

function readNullableChannelResponseLanguageValue(value: unknown, label: string): ChannelResponseLanguage | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const parsed = parseOptionalChannelResponseLanguage(value);
  if (!parsed) {
    throw new Error(`${label} must be workspace, follow_user, zh-CN, en-US, or null`);
  }
  return parsed;
}

function readNullableChannelAutoReplyModeValue(value: unknown, label: string): ChannelAutoReplyMode | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !channelAutoReplyModes.includes(value as ChannelAutoReplyMode)) {
    throw new Error(`${label} must be ${channelAutoReplyModes.join(", ")}, or null`);
  }
  return value as ChannelAutoReplyMode;
}

function readChannelWorkflowPreferenceValue(
  value: unknown,
  label: string,
): ChannelWorkflowPreference | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !channelWorkflowPreferences.includes(value as ChannelWorkflowPreference)) {
    throw new Error(`${label} must be one of: ${channelWorkflowPreferences.join(", ")}`);
  }
  return value as ChannelWorkflowPreference;
}

function readVisibleMultiReplyMaxParticipantsValue(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error(`${label} must be an integer between 1 and 8`);
  }
  return value;
}

function readProtocolStringListValue(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseOptionalChannelResponseLanguage(value: unknown): ChannelResponseLanguage | undefined {
  return value === "workspace" || value === "follow_user" || value === "zh-CN" || value === "en-US" ? value : undefined;
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
