import {
  authorizationModes,
  readOnlyRunTools,
  permissionModeForPreset,
  permissionPresets,
  sessionPermissionModes,
  taskStatuses,
  workspaceAccessModes,
  normalizeRunnerId,
  type AuthorizationMode,
  type CreateTaskInput,
  type PermissionConfirmation,
  type PermissionPreset,
  type RunTool,
  type SessionPermissionMode,
  type SkillApprovalProfile,
  type SkillOptimizationMode,
  type TaskStatus,
  type TaskUpdateInput,
  type WorkspaceAccessMode,
} from "@ling-stack/core";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";
import { assertPermissionContractVersion } from "../../shared/permission-contract.js";
import { isRecord, readNullableString, readOptionalBoolean, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";

export interface TaskRunRequest {
  readonly providerPresetId: string;
  readonly runnerId?: string;
  readonly requestedSkillId?: string;
  readonly skillOptimizationMode?: SkillOptimizationMode;
  readonly skipProviderPreflight: boolean;
  readonly idempotencyKey?: string;
  readonly tools?: readonly RunTool[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly agentDir?: string;
}

export function parseCreateTaskInput(value: unknown): CreateTaskInput {
  if (!isRecord(value)) {
    throw new Error("Task request must be a JSON object");
  }
  const input: CreateTaskInput = {
    channelId: readString(value, "channelId"),
    title: readString(value, "title"),
    prompt: readString(value, "prompt"),
    status: readOptionalTaskStatus(value, "status"),
    assigneeTeammateId: readOptionalString(value, "assigneeTeammateId"),
    requestedSkillId: readOptionalString(value, "requestedSkillId"),
    attachmentIds: readOptionalStringArray(value, "attachmentIds"),
  };
  validateTaskInput(input);
  return input;
}

export function parseTaskUpdateInput(value: unknown): TaskUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Task update must be a JSON object");
  }
  const input: TaskUpdateInput = {
    channelId: readOptionalString(value, "channelId"),
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    status: readOptionalTaskStatus(value, "status"),
    assigneeTeammateId: readNullableString(value, "assigneeTeammateId"),
    requestedSkillId: readNullableString(value, "requestedSkillId"),
    attachmentIds: readOptionalStringArray(value, "attachmentIds"),
    currentRunId: readNullableString(value, "currentRunId"),
  };
  validateTaskInput(input);
  return input;
}

export function parseTaskRunRequest(value: unknown): TaskRunRequest {
  if (!isRecord(value)) {
    throw new Error("Task run request must be a JSON object");
  }
  assertPermissionContractVersion(value);
  const permissionPreset = readOptionalPermissionPreset(value, "permissionPreset");
  const authorizationMode = readOptionalAuthorizationMode(value, "authorizationMode");
  const workspaceAccessMode = readOptionalWorkspaceAccessMode(value, "workspaceAccessMode");
  const rawPermissionMode = readOptionalSessionPermissionMode(value, "permissionMode");
  const permissionMode = authorizationMode !== undefined || workspaceAccessMode !== undefined
    ? rawPermissionMode
    : resolvePermissionMode(permissionPreset, rawPermissionMode);
  return {
    providerPresetId: readString(value, "providerPresetId"),
    runnerId: normalizeRunnerId(readOptionalString(value, "runnerId")),
    requestedSkillId: readOptionalString(value, "requestedSkillId"),
    skillOptimizationMode: readOptionalSkillOptimizationMode(value, "skillOptimizationMode"),
    skipProviderPreflight: readOptionalBoolean(value, "skipProviderPreflight") ?? false,
    idempotencyKey: readOptionalString(value, "idempotencyKey"),
    tools: readOptionalRunTools(value, "tools"),
    approvalProfile: readOptionalApprovalProfile(value, "approvalProfile"),
    authorizationMode,
    workspaceAccessMode,
    permissionPreset,
    permissionMode,
    permissionConfirmation: readOptionalPermissionConfirmation(value, "permissionConfirmation"),
    thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
  };
}

function readOptionalSessionPermissionMode(record: Record<string, unknown>, key: string): SessionPermissionMode | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!sessionPermissionModes.includes(value as SessionPermissionMode)) {
    throw new Error(`${key} must be one of: ${sessionPermissionModes.join(", ")}`);
  }
  return value as SessionPermissionMode;
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

function readOptionalSkillOptimizationMode(record: Record<string, unknown>, key: string): SkillOptimizationMode | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  const modes: readonly SkillOptimizationMode[] = [
    "no_operation",
    "report_only",
    "preview_on_demand",
    "auto_safe",
    "auto_runtime_experimental",
  ];
  if (!modes.includes(value as SkillOptimizationMode)) {
    throw new Error(`${key} must be one of: ${modes.join(", ")}`);
  }
  return value as SkillOptimizationMode;
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

function resolvePermissionMode(
  permissionPreset: PermissionPreset | undefined,
  permissionMode: SessionPermissionMode | undefined,
): SessionPermissionMode | undefined {
  if (permissionPreset === undefined) {
    return permissionMode;
  }
  const presetMode = permissionModeForPreset(permissionPreset);
  if (permissionMode !== undefined && permissionPreset !== "custom" && permissionMode !== presetMode) {
    throw new Error("permissionPreset and permissionMode must describe the same permission scope");
  }
  return permissionMode ?? presetMode;
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
  if (mode !== "full_access") {
    throw new Error(`${key}.mode must be full_access`);
  }
  if (confirmed !== true) {
    throw new Error(`${key}.confirmed must be true`);
  }
  if (!reason.trim()) {
    throw new Error(`${key}.reason is required`);
  }
  if (Number.isNaN(Date.parse(confirmedAt))) {
    throw new Error(`${key}.confirmedAt must be an ISO date string`);
  }
  return {
    mode: "full_access",
    confirmed: true,
    confirmedAt,
    reason,
  };
}

export function readOptionalTaskStatusQuery(url: URL): TaskStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`status must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function validateTaskInput(input: TaskUpdateInput): void {
  if (input.channelId !== undefined && input.channelId.trim().length === 0) {
    throw new Error("channelId must be a non-empty string");
  }
  if (input.title !== undefined && input.title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (input.prompt !== undefined && input.prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
  if (input.requestedSkillId !== undefined && input.requestedSkillId !== null && input.requestedSkillId.trim().length === 0) {
    throw new Error("requestedSkillId must be a non-empty string");
  }
  if (input.attachmentIds !== undefined && input.attachmentIds.length > 10) {
    throw new Error("A task can reference at most 10 attachments");
  }
}

function readOptionalTaskStatus(record: Record<string, unknown>, key: string): TaskStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`${key} must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function readOptionalRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  return readOptionalStringArray(record, key, [...readOnlyRunTools, "bash", "edit", "write"] as const);
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

function readOptionalThinkingLevel(record: Record<string, unknown>, key: string): TaskRunRequest["thinkingLevel"] {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "off" && value !== "minimal" && value !== "low" && value !== "medium" && value !== "high" && value !== "xhigh" && value !== "max" && value !== "ultra") {
    throw new Error(`${key} must be one of: off, minimal, low, medium, high, xhigh, max, ultra`);
  }
  return value;
}
