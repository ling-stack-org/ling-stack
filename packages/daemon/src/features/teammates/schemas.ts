import { basename } from "node:path";
import {
  authorizationModes,
  readOnlyRunTools,
  permissionPresets,
  workspaceAccessModes,
  type AiTeammate,
  type AiTeammateUpdateInput,
  type AuthorizationMode,
  type ChannelMessageFileRef,
  type CreateAiTeammateInput,
  type HardDeleteAiTeammateInput,
  type ReplaceTeammateChannelMembershipInput,
  type ReplaceTeammateMcpBindingInput,
  type ReplaceTeammateMemoryScopeInput,
  type ReplaceTeammateSkillBindingInput,
  type RunTool,
  type PermissionConfirmation,
  type PermissionPreset,
  type SkillOptimizationMode,
  type SkillApprovalProfile,
  type WorkspaceAccessMode,
} from "@ling-stack/core";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";
import { extractMarkdownTitle } from "../../shared/markdown.js";
import {
  isRecord,
  readNullableString,
  readOptionalBoolean,
  readOptionalString,
  readOptionalStringArray,
  readString,
  readStringAllowEmpty,
} from "../../shared/validation.js";
import {
  parseChannelAttachmentRequest,
  readOptionalChannelMessageFileRefs,
  type ChannelAttachmentRequest,
} from "../channels/schemas.js";

export interface TeammateDirectMessageRequest {
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly requestAiReply: boolean;
  readonly providerPresetId?: string;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly requestedSkillId?: string;
  readonly skillOptimizationMode?: SkillOptimizationMode;
}

export interface TeammatePrivateAttachmentRequest extends ChannelAttachmentRequest {
  readonly scope?: "teammate_direct_thread" | "teammate_profile_avatar";
}

const teammateDirectSkillOptimizationModes: readonly SkillOptimizationMode[] = [
  "no_operation",
  "report_only",
  "preview_on_demand",
  "auto_safe",
  "auto_runtime_experimental",
];

export function parseCreateAiTeammateInput(value: unknown): CreateAiTeammateInput {
  if (!isRecord(value)) {
    throw new Error("AI teammate request must be a JSON object");
  }
  const input: CreateAiTeammateInput = {
    templateId: readOptionalString(value, "templateId"),
    roleKey: readAiTeammateRoleKey(value, "roleKey"),
    displayName: readString(value, "displayName"),
    description: readStringAllowEmpty(value, "description"),
    avatarTone: readOptionalString(value, "avatarTone"),
    avatarImageAttachmentId: readOptionalString(value, "avatarImageAttachmentId"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    runnerId: readOptionalString(value, "runnerId"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
    approvalProfile: readApprovalProfile(value, "approvalProfile"),
    status: readOptionalAiTeammateStatus(value, "status"),
    pinned: readOptionalBoolean(value, "pinned"),
    hidden: readOptionalBoolean(value, "hidden"),
  };
  validateAiTeammateInput(input);
  return input;
}

export function parseAiTeammateUpdateInput(value: unknown): AiTeammateUpdateInput {
  if (!isRecord(value)) {
    throw new Error("AI teammate update must be a JSON object");
  }
  const input: AiTeammateUpdateInput = {
    templateId: readNullableString(value, "templateId"),
    roleKey: readOptionalAiTeammateRoleKey(value, "roleKey"),
    displayName: readOptionalString(value, "displayName"),
    description: readOptionalString(value, "description"),
    avatarTone: readNullableString(value, "avatarTone"),
    avatarImageAttachmentId: readNullableString(value, "avatarImageAttachmentId"),
    providerPresetId: readNullableString(value, "providerPresetId"),
    runnerId: readNullableString(value, "runnerId"),
    systemPrompt: readNullableString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
    approvalProfile: readOptionalApprovalProfile(value, "approvalProfile"),
    status: readOptionalAiTeammateStatus(value, "status"),
    pinned: readOptionalBoolean(value, "pinned"),
    hidden: readOptionalBoolean(value, "hidden"),
  };
  validateAiTeammateInput(input);
  return input;
}

export function parseReplaceTeammateChannelMembershipsRequest(value: unknown): readonly ReplaceTeammateChannelMembershipInput[] {
  if (!isRecord(value) || !Array.isArray(value.memberships)) {
    throw new Error("memberships must be an array");
  }
  return value.memberships.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`memberships[${index}] must be an object`);
    }
    return {
      channelId: readString(item, "channelId"),
      isDefault: readOptionalBoolean(item, "isDefault"),
    };
  });
}

export function parseReplaceTeammateMemoryScopesRequest(value: unknown): readonly ReplaceTeammateMemoryScopeInput[] {
  if (!isRecord(value) || !Array.isArray(value.scopes)) {
    throw new Error("scopes must be an array");
  }
  return value.scopes.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`scopes[${index}] must be an object`);
    }
    const enabled = readOptionalBoolean(item, "enabled");
    if (enabled === false) {
      throw new Error("Teammate memory is always enabled.");
    }
    return {
      id: readOptionalString(item, "id"),
      kind: readTeammateMemoryScopeKind(item, "kind"),
      channelId: readOptionalString(item, "channelId"),
      enabled,
    };
  });
}

export function parseReplaceTeammateSkillBindingsRequest(value: unknown): readonly ReplaceTeammateSkillBindingInput[] {
  if (!isRecord(value) || !Array.isArray(value.bindings)) {
    throw new Error("bindings must be an array");
  }
  return value.bindings.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`bindings[${index}] must be an object`);
    }
    const source = readOptionalString(item, "source");
    if (source !== undefined && source !== "template" && source !== "user") {
      throw new Error(`bindings[${index}].source must be template or user`);
    }
    return {
      skillId: readString(item, "skillId"),
      source,
      enabled: readOptionalBoolean(item, "enabled"),
    };
  });
}

export function parseReplaceTeammateMcpBindingsRequest(value: unknown): readonly ReplaceTeammateMcpBindingInput[] {
  if (!isRecord(value) || !Array.isArray(value.bindings)) {
    throw new Error("bindings must be an array");
  }
  return value.bindings.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`bindings[${index}] must be an object`);
    }
    const mode = readString(item, "mode");
    if (mode !== "selected" && mode !== "all_current_tools") {
      throw new Error(`bindings[${index}].mode must be selected or all_current_tools`);
    }
    return {
      serverId: readString(item, "serverId"),
      mode,
      selectedToolNames: readOptionalStringArray(item, "selectedToolNames"),
      approvalOverrides: readOptionalMcpApprovalOverrides(item, "approvalOverrides"),
      enabled: readOptionalBoolean(item, "enabled"),
    };
  });
}

export function parseTeammatePersonaDraft(value: unknown, teammate: AiTeammate): {
  readonly teammateId: string;
  readonly sourceKind: "agents-md" | "persona-md" | "markdown";
  readonly sourcePath?: string;
  readonly displayName: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly appendSystemPrompt: readonly string[];
  readonly warnings: readonly string[];
} {
  if (!isRecord(value)) {
    throw new Error("Persona draft request must be a JSON object");
  }
  const content = readString(value, "content");
  const sourcePath = readOptionalString(value, "sourcePath");
  const sourceKind = inferPersonaSourceKind(sourcePath);
  const title = extractMarkdownTitle(content);
  const trimmedContent = content.trim();
  const systemPrompt = trimmedContent.length > 12_000 ? `${trimmedContent.slice(0, 12_000)}\n\n[truncated]` : trimmedContent;
  const warnings = [
    "Persona draft was not applied to the durable teammate.",
    "Persona text can influence behavior, but cannot grant tools, approvals, secrets, provider capability, external-send, or file-system permissions.",
    ...personaPermissionWarnings(content),
    ...(trimmedContent.length > 12_000 ? ["Content was truncated to 12000 characters for the draft prompt."] : []),
  ];
  return {
    teammateId: teammate.id,
    sourceKind,
    sourcePath,
    displayName: title ?? teammate.displayName,
    description: title ? `Draft imported from ${sourceKind}.` : teammate.description,
    systemPrompt,
    appendSystemPrompt: [],
    warnings,
  };
}

export function parseTeammateDirectMessageRequest(value: unknown): TeammateDirectMessageRequest {
  if (!isRecord(value)) {
    throw new Error("Direct message request must be a JSON object");
  }
  const body = readString(value, "body");
  const input: TeammateDirectMessageRequest = {
    body,
    attachmentIds: readOptionalStringArray(value, "attachmentIds") ?? [],
    linkPreviewIds: readOptionalStringArray(value, "linkPreviewIds") ?? [],
    fileRefs: readOptionalChannelMessageFileRefs(value, "fileRefs") ?? [],
    requestAiReply: readOptionalBoolean(value, "requestAiReply") ?? false,
    providerPresetId: readOptionalString(value, "providerPresetId"),
    authorizationMode: readOptionalAuthorizationMode(value, "authorizationMode"),
    workspaceAccessMode: readOptionalWorkspaceAccessMode(value, "workspaceAccessMode"),
    permissionPreset: readOptionalPermissionPreset(value, "permissionPreset"),
    permissionConfirmation: readOptionalPermissionConfirmation(value, "permissionConfirmation"),
    requestedSkillId: readOptionalString(value, "requestedSkillId"),
    skillOptimizationMode: readOptionalSkillOptimizationMode(value, "skillOptimizationMode"),
  };
  if (!input.body.trim() && input.attachmentIds.length === 0 && input.linkPreviewIds.length === 0 && input.fileRefs.length === 0) {
    throw new Error("body, attachmentIds, linkPreviewIds, or fileRefs is required");
  }
  if (input.attachmentIds.length > 10) {
    throw new Error("A teammate direct message can reference at most 10 attachments");
  }
  if (input.linkPreviewIds.length > 10) {
    throw new Error("A teammate direct message can reference at most 10 link previews");
  }
  if (input.fileRefs.length > 12) {
    throw new Error("A teammate direct message can reference at most 12 workspace files");
  }
  return input;
}

function readOptionalAuthorizationMode(record: Record<string, unknown>, key: string): AuthorizationMode | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!authorizationModes.includes(value as AuthorizationMode)) {
    throw new Error(`${key} must be one of: ${authorizationModes.join(", ")}`);
  }
  return value as AuthorizationMode;
}

function readOptionalWorkspaceAccessMode(record: Record<string, unknown>, key: string): WorkspaceAccessMode | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!workspaceAccessModes.includes(value as WorkspaceAccessMode)) {
    throw new Error(`${key} must be one of: ${workspaceAccessModes.join(", ")}`);
  }
  return value as WorkspaceAccessMode;
}

function readOptionalPermissionPreset(record: Record<string, unknown>, key: string): PermissionPreset | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!permissionPresets.includes(value as PermissionPreset)) {
    throw new Error(`${key} must be one of: ${permissionPresets.join(", ")}`);
  }
  return value as PermissionPreset;
}

function readOptionalPermissionConfirmation(record: Record<string, unknown>, key: string): PermissionConfirmation | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const mode = readString(value, "mode");
  const confirmed = value.confirmed;
  const confirmedAt = readString(value, "confirmedAt");
  const reason = readString(value, "reason");
  if (mode !== "full_access" || confirmed !== true || !reason.trim() || Number.isNaN(Date.parse(confirmedAt))) {
    throw new Error(`${key} must contain a valid full_access confirmation`);
  }
  return { mode: "full_access", confirmed: true, confirmedAt, reason };
}

function readOptionalSkillOptimizationMode(record: Record<string, unknown>, key: string): SkillOptimizationMode | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!teammateDirectSkillOptimizationModes.includes(value as SkillOptimizationMode)) {
    throw new Error(`${key} must be one of: ${teammateDirectSkillOptimizationModes.join(", ")}`);
  }
  return value as SkillOptimizationMode;
}

export function parseTeammatePrivateAttachmentRequest(value: unknown): TeammatePrivateAttachmentRequest {
  const input = parseChannelAttachmentRequest(value);
  if (!isRecord(value)) {
    throw new Error("Private attachment request must be a JSON object");
  }
  const scope = readOptionalString(value, "scope");
  if (scope !== undefined && scope !== "teammate_direct_thread" && scope !== "teammate_profile_avatar") {
    throw new Error("scope must be teammate_direct_thread or teammate_profile_avatar");
  }
  return { ...input, scope };
}

export function parseHardDeleteAiTeammateRequest(value: unknown): HardDeleteAiTeammateInput {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Hard delete request must be a JSON object");
  }
  const reason = readOptionalString(value, "reason")?.trim();
  return reason ? { reason: reason.slice(0, 500) } : {};
}

function validateAiTeammateInput(input: AiTeammateUpdateInput): void {
  if (input.displayName !== undefined && input.displayName.trim().length === 0) {
    throw new Error("displayName must be a non-empty string");
  }
  if (input.allowedTools !== undefined && input.allowedTools.length === 0) {
    throw new Error("allowedTools must contain at least one tool");
  }
}

function readOptionalRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  return readOptionalStringArray(record, key, [...readOnlyRunTools, "bash", "edit", "write"] as const);
}

function readAiTeammateRoleKey(record: Record<string, unknown>, key: string): CreateAiTeammateInput["roleKey"] {
  const value = readString(record, key);
  if (!["product", "architect", "engineer", "designer", "qa", "security", "release", "docs", "custom"].includes(value)) {
    throw new Error(`${key} must be a supported AI teammate role`);
  }
  return value as CreateAiTeammateInput["roleKey"];
}

function readOptionalAiTeammateRoleKey(record: Record<string, unknown>, key: string): AiTeammateUpdateInput["roleKey"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!["product", "architect", "engineer", "designer", "qa", "security", "release", "docs", "custom"].includes(value)) {
    throw new Error(`${key} must be a supported AI teammate role`);
  }
  return value as AiTeammateUpdateInput["roleKey"];
}

function readOptionalAiTeammateStatus(record: Record<string, unknown>, key: string): CreateAiTeammateInput["status"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "active" && value !== "paused" && value !== "disabled") {
    throw new Error(`${key} must be one of: active, paused, disabled`);
  }
  return value;
}

function readTeammateMemoryScopeKind(record: Record<string, unknown>, key: string): ReplaceTeammateMemoryScopeInput["kind"] {
  const value = readString(record, key);
  if (value !== "channel-brief" && value !== "channel-decisions" && value !== "private-chat-summary" && value !== "private-notes") {
    throw new Error(`${key} must be a supported memory scope kind`);
  }
  return value;
}

function readOptionalMcpApprovalOverrides(
  record: Record<string, unknown>,
  key: string,
): ReplaceTeammateMcpBindingInput["approvalOverrides"] {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const result: Record<string, "allow" | "ask" | "deny"> = {};
  for (const [toolName, decision] of Object.entries(value)) {
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      throw new Error(`${key}.${toolName} must be allow, ask, or deny`);
    }
    result[toolName] = decision;
  }
  return result;
}

function inferPersonaSourceKind(sourcePath: string | undefined): "agents-md" | "persona-md" | "markdown" {
  const name = sourcePath ? basename(sourcePath).toLowerCase() : "";
  if (name === "agents.md" || name === "agent.md") {
    return "agents-md";
  }
  if (name === "persona.md") {
    return "persona-md";
  }
  return "markdown";
}

function personaPermissionWarnings(content: string): readonly string[] {
  const lower = content.toLowerCase();
  const warnings: string[] = [];
  if (/\b(tool|tools|bash|write|edit|approval|approvals|permission|permissions)\b/.test(lower)) {
    warnings.push("Draft mentions tools, approvals, or permissions; those fields are ignored for capability grants.");
  }
  if (/\b(secret|secrets|token|api key|credential|credentials)\b/.test(lower)) {
    warnings.push("Draft mentions secrets or credentials; secret access must remain configured through explicit secret policy.");
  }
  if (/\b(external-send|send externally|slack|github comment|deploy|push)\b/.test(lower)) {
    warnings.push("Draft mentions external sends, deploys, or pushes; external side effects still require explicit policy and approvals.");
  }
  return warnings;
}

function readApprovalProfile(record: Record<string, unknown>, key: string): SkillApprovalProfile {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return parseApprovalProfileObject(value, key);
}

function readOptionalApprovalProfile(record: Record<string, unknown>, key: string): SkillApprovalProfile | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return parseApprovalProfileObject(value, key);
}
