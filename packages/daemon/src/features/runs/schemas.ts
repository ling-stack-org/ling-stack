import {
  readOnlyRunTools,
  runInterventionModes,
  sessionPermissionModes,
  type PermissionConfirmation,
  type RunInterventionMode,
  type RunTool,
  type SessionPermissionMode,
  type SkillApprovalProfile,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";
import {
  isRecord,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringArray,
  readOptionalStringRecord,
  readString,
} from "../../shared/validation.js";

export interface RunRequest extends Omit<PiRunnerRunOptions, "onApprovalRequired" | "onEvent" | "provider" | "tools" | "mcpTools" | "onMcpToolCall"> {
  readonly workspaceCwd?: string;
  readonly providerPresetId?: string;
  readonly provider?: PiRunnerProviderConfig;
  readonly teammateId?: string;
  readonly requestedSkillId?: string;
  readonly tools?: readonly RunTool[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly permissionMode?: SessionPermissionMode;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly skipProviderPreflight?: boolean;
  readonly idempotencyKey?: string;
  readonly parentRunId?: string;
  readonly interventionId?: string;
  readonly continuationReason?: RunInterventionMode;
}

export function parseRunRequest(value: unknown): RunRequest {
  if (!isRecord(value)) {
    throw new Error("Run request must be a JSON object");
  }

  const cwd = readString(value, "cwd");
  const workspaceCwd = readOptionalString(value, "workspaceCwd");
  const task = value.task;
  const provider = value.provider;
  const providerPresetId = readOptionalString(value, "providerPresetId");
  const teammateId = readOptionalString(value, "teammateId");
  const requestedSkillId = readOptionalString(value, "requestedSkillId");
  const skipProviderPreflight = readOptionalBoolean(value, "skipProviderPreflight") ?? false;
  const idempotencyKey = readOptionalString(value, "idempotencyKey");

  if (!isRecord(task)) {
    throw new Error("task must be an object");
  }
  if (provider !== undefined && !isRecord(provider)) {
    throw new Error("provider must be an object");
  }
  if (providerPresetId && provider !== undefined) {
    throw new Error("providerPresetId and provider cannot both be supplied");
  }
  if (!providerPresetId && provider === undefined) {
    throw new Error("Either providerPresetId or provider is required");
  }

  const runRequest: RunRequest = {
    cwd,
    workspaceCwd,
    providerPresetId,
    teammateId,
    requestedSkillId,
    skipProviderPreflight,
    idempotencyKey,
    task: {
      id: readString(task, "id"),
      title: readString(task, "title"),
      prompt: readString(task, "prompt"),
      channelId: readOptionalString(task, "channelId"),
    },
    provider: provider ? parseInlineProvider(provider) : undefined,
    tools: readOptionalStringArray(value, "tools", ["read", "bash", "edit", "write", "grep", "find", "ls"]) ?? [...readOnlyRunTools],
    approvalProfile: readOptionalApprovalProfile(value, "approvalProfile"),
    permissionMode: readOptionalSessionPermissionMode(value, "permissionMode"),
    permissionConfirmation: readOptionalPermissionConfirmation(value, "permissionConfirmation"),
    thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
    parentRunId: readOptionalString(value, "parentRunId"),
    interventionId: readOptionalString(value, "interventionId"),
    continuationReason: readOptionalRunInterventionMode(value, "continuationReason"),
  };
  assertFullAccessPermissionConfirmed(runRequest);
  return runRequest;
}

function assertFullAccessPermissionConfirmed(runRequest: RunRequest): void {
  if (runRequest.permissionMode !== "full_access") {
    return;
  }
  const confirmation = runRequest.permissionConfirmation;
  if (
    !confirmation ||
    confirmation.mode !== "full_access" ||
    confirmation.confirmed !== true ||
    !confirmation.reason.trim() ||
    Number.isNaN(Date.parse(confirmation.confirmedAt))
  ) {
    throw new HttpError(
      400,
      "full_access_confirmation_required",
      "Full access runs require explicit permission confirmation.",
    );
  }
}

function parseInlineProvider(provider: Record<string, unknown>): PiRunnerProviderConfig {
  return {
    provider: readString(provider, "provider"),
    model: readString(provider, "model"),
    displayName: readOptionalString(provider, "displayName"),
    apiKey: readOptionalString(provider, "apiKey"),
    baseUrl: readOptionalString(provider, "baseUrl"),
    api: readOptionalProviderApi(provider, "api"),
    headers: readOptionalStringRecord(provider, "headers"),
    authHeader: readOptionalBoolean(provider, "authHeader"),
    reasoning: readOptionalBoolean(provider, "reasoning"),
    input: readOptionalStringArray(provider, "input", ["text", "image"]),
    contextWindow: readOptionalNumber(provider, "contextWindow"),
    maxTokens: readOptionalNumber(provider, "maxTokens"),
    compat: isRecord(provider.compat) ? provider.compat : undefined,
  };
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

function readOptionalThinkingLevel(record: Record<string, unknown>, key: string): RunRequest["thinkingLevel"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ])?.[0];
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

function readOptionalRunInterventionMode(record: Record<string, unknown>, key: string): RunInterventionMode | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!runInterventionModes.includes(value as RunInterventionMode)) {
    throw new Error(`${key} must be one of: ${runInterventionModes.join(", ")}`);
  }
  return value as RunInterventionMode;
}

function readOptionalProviderApi(record: Record<string, unknown>, key: string): PiRunnerProviderConfig["api"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "mistral-conversations",
  ])?.[0];
}
