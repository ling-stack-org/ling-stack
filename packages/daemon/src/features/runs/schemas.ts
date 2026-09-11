import {
  authorizationModes,
  readOnlyRunTools,
  lingConversationTones,
  reasoningSummaryModes,
  permissionModeForPreset,
  permissionPresets,
  providerTransports,
  responseLanguages,
  runContinuationReasons,
  sessionPermissionModes,
  workspaceAccessModes,
  type AuthorizationMode,
  type ChannelMessageFileRef,
  type PermissionConfirmation,
  type DirectWorkspaceBinding,
  type DirectWorkspaceSnapshot,
  type LingTurnCreatedByActor,
  type LingConversationTone,
  type PermissionPreset,
  type ReasoningSummaryMode,
  type ResponseLanguage,
  type RunContinuationReason,
  type RunTool,
  type SessionPermissionMode,
  type SkillApprovalProfile,
  type SkillOptimizationMode,
  type WorkspaceAccessMode,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type {
  ChannelIntentExecutionOperationV1,
  ConversationContextProjectionMetadata,
  DelegatedStepRequirementV1,
  WorkflowParticipantProviderBindingV1,
} from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { WorkflowOperationExecutionSnapshot } from "./workflow-operation-snapshot.js";
import type { UserInputContinuationContext } from "./user-input-continuation-context.js";
import type { NormalConversationContextSnapshot } from "../conversations/normal-conversation-context.js";
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

export interface PreselectedMemoryUse {
  readonly memoryIds: readonly string[];
  readonly recallQuery: string;
  readonly policyVersion: string;
}

export interface RunRequest extends Omit<
  PiRunnerRunOptions,
  | "onApprovalRequired"
  | "onToolBefore"
  | "onEvent"
  | "provider"
  | "tools"
  | "mcpTools"
  | "onMcpToolCall"
  | "mediaGenerationTools"
  | "onMediaGenerationToolCall"
> {
  readonly workspaceCwd?: string;
  readonly providerPresetId?: string;
  /** Internal-only immutable provider ownership snapshot for workflow participant Runs. */
  readonly providerBinding?: WorkflowParticipantProviderBindingV1;
  readonly provider?: PiRunnerProviderConfig;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  /** Internal-only immutable delegated completion requirement. External request parsing does not accept it. */
  readonly delegatedRequirement?: DelegatedStepRequirementV1;
  /** Internal-only Host execution bindings for workflow-owned operations. */
  readonly executionOperationBindings?: readonly ChannelIntentExecutionOperationV1[];
  /** Internal-only full accepted plan plus exact step-owned IDs, durably captured at dispatch. */
  readonly workflowOperationExecution?: WorkflowOperationExecutionSnapshot;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runnerId?: string;
  readonly requestedSkillId?: string;
  readonly skillOptimizationMode?: SkillOptimizationMode;
  readonly tools?: readonly RunTool[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly skipProviderPreflight?: boolean;
  readonly idempotencyKey?: string;
  readonly lingConversationTone?: LingConversationTone;
  readonly responseLanguage?: ResponseLanguage;
  readonly reasoningSummary?: ReasoningSummaryMode;
  readonly conversationAttachmentIds?: readonly string[];
  readonly conversationFileRefs?: readonly ChannelMessageFileRef[];
  readonly parentRunId?: string;
  readonly interventionId?: string;
  readonly continuationReason?: RunContinuationReason;
  readonly sourceMessageId?: string;
  readonly linkedMessageId?: string;
  readonly createdByActor?: LingTurnCreatedByActor;
  readonly directWorkspaceBinding?: DirectWorkspaceBinding;
  readonly directWorkspaceSnapshot?: DirectWorkspaceSnapshot;
  readonly skipMemoryRecall?: boolean;
  /** Internal-only memory evidence already selected and rendered by a scoped context owner. */
  readonly preselectedMemoryUse?: PreselectedMemoryUse;
  /** Internal-only evidence version for conversation-derived runs. External request parsing does not accept it. */
  readonly contextProjection?: ConversationContextProjectionMetadata;
  /** Internal-only frozen normal input evidence. External request parsing never accepts it. */
  readonly normalConversationContext?: NormalConversationContextSnapshot;
  /** Internal acceptance evidence; never parsed from an external RunRequest. */
  readonly normalConversationAcceptedSnapshotId?: string;
  /** Internal immutable request preparation, never accepted by external parsing. */
  readonly normalConversationPreparedRequestRef?: { readonly id: string; readonly fingerprint: string };
  readonly normalConversationPreparedExecutionRef?: { readonly id: string; readonly fingerprint: string };
  /** Host-produced source SDK input. External parsing never accepts or restores it as authority. */
  readonly runnerExecutionInput?: import("./prepared-runner-input.js").PreparedRunnerInput;
  /** Internal-only answer continuation lineage; external parsing never accepts this field. */
  readonly userInputContinuationContext?: UserInputContinuationContext;
  /** Internal-only override used by trusted multi-reply channel orchestration. */
  readonly channelParallelLimit?: number;
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
  const workflowStepId = readOptionalString(value, "workflowStepId");
  const threadId = readOptionalString(value, "threadId");
  const turnId = readOptionalString(value, "turnId");
  const runnerId = readOptionalString(value, "runnerId");
  const requestedSkillId = readOptionalString(value, "requestedSkillId");
  const skillOptimizationMode = readOptionalSkillOptimizationMode(value, "skillOptimizationMode");
  const skipProviderPreflight = readOptionalBoolean(value, "skipProviderPreflight") ?? false;
  const idempotencyKey = readOptionalString(value, "idempotencyKey");
  const authorizationMode = readOptionalAuthorizationMode(value, "authorizationMode");
  const workspaceAccessMode = readOptionalWorkspaceAccessMode(value, "workspaceAccessMode");
  const permissionPreset = readOptionalPermissionPreset(value, "permissionPreset");
  const rawPermissionMode = readOptionalSessionPermissionMode(value, "permissionMode");
  const permissionMode = authorizationMode !== undefined || workspaceAccessMode !== undefined
    ? rawPermissionMode
    : resolvePermissionMode(permissionPreset, rawPermissionMode);

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
    workflowStepId,
    threadId,
    turnId,
    runnerId,
    requestedSkillId,
    skillOptimizationMode,
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
    authorizationMode,
    workspaceAccessMode,
    permissionPreset,
    permissionMode,
    permissionConfirmation: readOptionalPermissionConfirmation(value, "permissionConfirmation"),
    thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
    reasoningSummary: readOptionalReasoningSummary(value, "reasoningSummary"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
    runtimeToolFeatures: readOptionalRuntimeToolFeatures(value, "runtimeToolFeatures"),
    lingConversationTone: readOptionalLingConversationTone(value, "lingConversationTone"),
    responseLanguage: readOptionalResponseLanguage(value, "responseLanguage"),
    parentRunId: readOptionalString(value, "parentRunId"),
    interventionId: readOptionalString(value, "interventionId"),
    continuationReason: readOptionalRunContinuationReason(value, "continuationReason"),
  };
  assertFullAccessPermissionConfirmed(runRequest);
  return runRequest;
}

function readOptionalLingConversationTone(record: Record<string, unknown>, key: string): LingConversationTone | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!lingConversationTones.includes(value as LingConversationTone)) {
    throw new Error(`${key} must be one of: ${lingConversationTones.join(", ")}`);
  }
  return value as LingConversationTone;
}

function readOptionalReasoningSummary(record: Record<string, unknown>, key: string): ReasoningSummaryMode | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) return undefined;
  if (!reasoningSummaryModes.includes(value as ReasoningSummaryMode)) {
    throw new Error(`${key} must be one of: ${reasoningSummaryModes.join(", ")}`);
  }
  return value as ReasoningSummaryMode;
}

function readOptionalResponseLanguage(record: Record<string, unknown>, key: string): ResponseLanguage | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!responseLanguages.includes(value as ResponseLanguage)) {
    throw new Error(`${key} must be one of: ${responseLanguages.join(", ")}`);
  }
  return value as ResponseLanguage;
}

function readOptionalRuntimeToolFeatures(record: Record<string, unknown>, key: string): RunRequest["runtimeToolFeatures"] {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return {
    requestPermissions: readOptionalBoolean(value, "requestPermissions"),
    unifiedExec: readOptionalBoolean(value, "unifiedExec"),
    shellSnapshot: readOptionalBoolean(value, "shellSnapshot"),
  };
}

function assertFullAccessPermissionConfirmed(runRequest: RunRequest): void {
  const fullAccessRequested = runRequest.workspaceAccessMode !== undefined
    ? runRequest.workspaceAccessMode === "full_access"
    : runRequest.permissionMode === "full_access" || runRequest.permissionPreset === "full_access";
  if (!fullAccessRequested) {
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
    providerTransport: readOptionalProviderTransport(provider, "providerTransport"),
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

function readOptionalRunContinuationReason(record: Record<string, unknown>, key: string): RunContinuationReason | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!runContinuationReasons.includes(value as RunContinuationReason)) {
    throw new Error(`${key} must be one of: ${runContinuationReasons.join(", ")}`);
  }
  return value as RunContinuationReason;
}

function readOptionalProviderApi(record: Record<string, unknown>, key: string): PiRunnerProviderConfig["api"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "anthropic-messages",
    "google-generative-ai",
    "mistral-conversations",
  ])?.[0];
}

function readOptionalProviderTransport(record: Record<string, unknown>, key: string): PiRunnerProviderConfig["providerTransport"] {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!providerTransports.includes(value as NonNullable<PiRunnerProviderConfig["providerTransport"]>)) {
    throw new Error(`${key} must be one of: ${providerTransports.join(", ")}`);
  }
  return value as PiRunnerProviderConfig["providerTransport"];
}
