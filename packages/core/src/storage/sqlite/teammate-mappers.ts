import type { SQLOutputValue } from "node:sqlite";
import { type RunTool } from "../../approval-policy.js";
import { type AiTeammateRoleKey, type SkillApprovalProfile } from "../../skill-types.js";
import {
  isLingAgentTeammateId,
  lingAgentEditableFields,
  type AiTeammate,
  type AiTeammateModelBindingMode,
  type AiTeammateStatus,
  type TeammateChannelMembership,
  type TeammateMemoryScope,
  type TeammateMemoryScopeKind,
  type TeammateSkillBinding,
  type TeammateSkillBindingSource,
} from "../../workspace-types.js";
import {
  omitUndefined,
  parseJsonObject,
  parseJsonStringArray,
  readBoolean,
  readNullableString,
  readString,
} from "./helpers.js";
import { normalizeStoredRunnerId } from "./runtime-work-mappers.js";

export function mapAiTeammate(row: Record<string, SQLOutputValue>): AiTeammate {
  return withSystemTeammateMetadata(omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    templateId: readNullableString(row, "template_id"),
    roleKey: readString(row, "role_key") as AiTeammateRoleKey,
    displayName: readString(row, "display_name"),
    description: readString(row, "description"),
    avatarTone: readNullableString(row, "avatar_tone"),
    avatarImageAttachmentId: readNullableString(row, "avatar_image_attachment_id"),
    modelBindingMode: readString(row, "model_binding_mode") as AiTeammateModelBindingMode,
    providerPresetId: readNullableString(row, "provider_preset_id"),
    runnerId: normalizeStoredRunnerId(readNullableString(row, "runner_id")),
    systemPrompt: readNullableString(row, "system_prompt"),
    appendSystemPrompt: parseJsonStringArray(readString(row, "append_system_prompt_json")),
    allowedTools: parseJsonStringArray(readString(row, "allowed_tools_json")) as RunTool[],
    approvalProfile: parseApprovalProfile(readString(row, "approval_profile_json")),
    status: readString(row, "status") as AiTeammateStatus,
    pinned: readBoolean(row, "pinned"),
    hidden: readBoolean(row, "hidden"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  }));
}

export function withSystemTeammateMetadata(teammate: AiTeammate): AiTeammate {
  if (!isLingAgentTeammateId(teammate.id)) {
    return teammate;
  }
  return {
    ...teammate,
    kind: "system_teammate",
    systemRole: "ling_agent",
    protectedProfile: true,
    editableFields: lingAgentEditableFields,
  };
}

export function mapTeammateChannelMembership(row: Record<string, SQLOutputValue>): TeammateChannelMembership {
  return {
    teammateId: readString(row, "teammate_id"),
    channelId: readString(row, "channel_id"),
    isDefault: readBoolean(row, "is_default"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapTeammateSkillBinding(row: Record<string, SQLOutputValue>): TeammateSkillBinding {
  return {
    teammateId: readString(row, "teammate_id"),
    skillId: readString(row, "skill_id"),
    source: readString(row, "source") as TeammateSkillBindingSource,
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapTeammateMemoryScope(row: Record<string, SQLOutputValue>): TeammateMemoryScope {
  return omitUndefined({
    id: readString(row, "id"),
    teammateId: readString(row, "teammate_id"),
    kind: readString(row, "kind") as TeammateMemoryScopeKind,
    channelId: readNullableString(row, "channel_id"),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseApprovalProfile(value: string): SkillApprovalProfile {
  const parsed = parseJsonObject(value);
  if (parsed.mode !== "none" && parsed.mode !== "standard" && parsed.mode !== "strict") {
    throw new Error("Expected approval profile mode from SQLite");
  }
  return parsed as unknown as SkillApprovalProfile;
}
