import {
  readOnlyRunTools,
  sessionPermissionModes,
  taskStatuses,
  type CreateTaskInput,
  type PermissionConfirmation,
  type RunTool,
  type SessionPermissionMode,
  type SkillApprovalProfile,
  type TaskStatus,
  type TaskUpdateInput,
} from "@ling-stack/core";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";
import { isRecord, readNullableString, readOptionalBoolean, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";

export interface TaskRunRequest {
  readonly providerPresetId: string;
  readonly runnerId?: string;
  readonly requestedSkillId?: string;
  readonly skipProviderPreflight: boolean;
  readonly idempotencyKey?: string;
  readonly tools?: readonly RunTool[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly permissionMode?: SessionPermissionMode;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
    currentRunId: readNullableString(value, "currentRunId"),
  };
  validateTaskInput(input);
  return input;
}

export function parseTaskRunRequest(value: unknown): TaskRunRequest {
  if (!isRecord(value)) {
    throw new Error("Task run request must be a JSON object");
  }
  return {
    providerPresetId: readString(value, "providerPresetId"),
    runnerId: readOptionalString(value, "runnerId"),
    requestedSkillId: readOptionalString(value, "requestedSkillId"),
    skipProviderPreflight: readOptionalBoolean(value, "skipProviderPreflight") ?? false,
    idempotencyKey: readOptionalString(value, "idempotencyKey"),
    tools: readOptionalRunTools(value, "tools"),
    approvalProfile: readOptionalApprovalProfile(value, "approvalProfile"),
    permissionMode: readOptionalSessionPermissionMode(value, "permissionMode"),
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
  if (value !== "off" && value !== "minimal" && value !== "low" && value !== "medium" && value !== "high" && value !== "xhigh") {
    throw new Error(`${key} must be one of: off, minimal, low, medium, high, xhigh`);
  }
  return value;
}
