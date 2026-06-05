import {
  channelDecisionStatuses,
  channelContextSummaryAuthorTypes,
  channelContextSummaryTargetTypes,
  channelHandoffStatuses,
  channelWorkflowStatuses,
  channelWorkflowStepStatuses,
  readOnlyRunTools,
  type Channel,
  type ChannelContextSummaryAuthorType,
  type ChannelContextSummaryTargetType,
  type ChannelDecisionStatus,
  type ChannelExecutionProposalStep,
  type ChannelExecutionProposalStatus,
  type ChannelHandoffStatus,
  type ChannelMention,
  type ChannelMessageAuthorType,
  type ChannelMessageIntent,
  type ChannelMessageKind,
  type ChannelWorkflowStatus,
  type ChannelWorkflowStepStartMode,
  type ChannelWorkflowStepStatus,
  type ChannelUpdateInput,
  type CreateChannelExecutionProposalInput,
  type CreateChannelInput,
  type RunTool,
  type UpdateChannelExecutionProposalInput,
} from "@ling-stack/core";
import {
  isRecord,
  readNullableString,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringArray,
  readString,
  readStringAllowEmpty,
} from "../../shared/validation.js";

export interface ChannelExecutionProposalRequest {
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly collaborationSteps: readonly ChannelExecutionProposalStep[];
  readonly requiredTools: readonly RunTool[];
  readonly riskSummary?: string;
}

export interface ChannelDecisionRequest {
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly alternatives: readonly string[];
  readonly status?: ChannelDecisionStatus;
  readonly supersedesDecisionId?: string;
  readonly createdBy: string;
}

export interface ChannelDecisionUpdateRequest {
  readonly title?: string;
  readonly decision?: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
}

export interface ChannelHandoffRequest {
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly status?: ChannelHandoffStatus;
  readonly createdBy: string;
}

export interface ChannelHandoffUpdateRequest {
  readonly fromParticipantId?: string;
  readonly fromParticipantLabel?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly reason?: string;
  readonly requiredInput?: string;
  readonly expectedOutput?: string;
  readonly status?: ChannelHandoffStatus;
}

export interface ChannelContextSummaryRequest {
  readonly targetType: ChannelContextSummaryTargetType;
  readonly targetId: string;
  readonly sourceMessageIds: readonly string[];
  readonly decisionIds: readonly string[];
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly authorType: ChannelContextSummaryAuthorType;
  readonly authorId?: string;
}

export interface ChannelContextSummaryUpdateRequest {
  readonly targetType?: ChannelContextSummaryTargetType;
  readonly targetId?: string;
  readonly sourceMessageIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly summary?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly authorType?: ChannelContextSummaryAuthorType;
  readonly authorId?: string | null;
}

export interface ChannelBriefRequest {
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly risks: readonly string[];
  readonly decisionIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly updatedBy: string;
}

export interface ChannelLinkPreviewRequest {
  readonly url: string;
  readonly messageId?: string;
}

export interface ChannelAttachmentRequest {
  readonly fileName: string;
  readonly contentType?: string;
  readonly contentBase64: string;
  readonly messageId?: string;
}

export interface ChannelMessageRequest {
  readonly threadId?: string;
  readonly kind?: ChannelMessageKind;
  readonly intent?: ChannelMessageIntent;
  readonly authorType: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly requestAiReply: boolean;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
}

export interface ChannelWorkflowRequest {
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status?: ChannelWorkflowStatus;
  readonly createdBy: string;
}

export interface ChannelWorkflowFromHandoffRequest {
  readonly title?: string;
  readonly objective?: string;
  readonly contextSummaryId?: string;
  readonly createdBy: string;
}

export interface ChannelWorkflowUpdateRequest {
  readonly title?: string;
  readonly objective?: string;
  readonly status?: ChannelWorkflowStatus;
}

export interface ChannelWorkflowStepRequest {
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly position?: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly status?: ChannelWorkflowStepStatus;
}

export interface ChannelWorkflowStepUpdateRequest {
  readonly sourceHandoffId?: string | null;
  readonly contextSummaryId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly position?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly blocker?: string | null;
  readonly resultSummary?: string | null;
}

export interface ChannelWorkflowStepStartRequest {
  readonly mode: ChannelWorkflowStepStartMode;
  readonly taskTitle?: string;
  readonly taskPrompt?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly assigneeTeammateId?: string;
  readonly idempotencyKey?: string;
  readonly skipProviderPreflight?: boolean;
}

export function parseCreateChannelInput(value: unknown): CreateChannelInput {
  if (!isRecord(value)) {
    throw new Error("Channel request must be a JSON object");
  }
  const input: CreateChannelInput = {
    name: readString(value, "name"),
    status: readOptionalChannelStatus(value, "status"),
    boundPath: readOptionalString(value, "boundPath"),
    defaultProviderPresetId: readOptionalString(value, "defaultProviderPresetId"),
    defaultTeammateId: readOptionalString(value, "defaultTeammateId"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
    runtimePolicy: readOptionalChannelRuntimePolicy(value, "runtimePolicy"),
  };
  validateChannelInput(input);
  return input;
}

export function parseChannelUpdateInput(value: unknown): ChannelUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Channel update must be a JSON object");
  }
  const input: ChannelUpdateInput = {
    name: readOptionalString(value, "name"),
    status: readOptionalChannelStatus(value, "status"),
    boundPath: readNullableString(value, "boundPath"),
    defaultProviderPresetId: readNullableString(value, "defaultProviderPresetId"),
    defaultTeammateId: readNullableString(value, "defaultTeammateId"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
    runtimePolicy: readOptionalChannelRuntimePolicy(value, "runtimePolicy"),
  };
  validateChannelInput(input);
  return input;
}

export function parseChannelExecutionProposalRequest(value: unknown): ChannelExecutionProposalRequest {
  if (!isRecord(value)) {
    throw new Error("Channel proposal request must be a JSON object");
  }
  const input: ChannelExecutionProposalRequest = {
    sourceMessageId: readString(value, "sourceMessageId"),
    proposedByTeammateId: readString(value, "proposedByTeammateId"),
    title: readString(value, "title"),
    prompt: readString(value, "prompt"),
    assigneeTeammateId: readString(value, "assigneeTeammateId"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria") ?? [],
    collaborationSteps: readOptionalChannelExecutionProposalSteps(value, "collaborationSteps") ?? [],
    requiredTools: readOptionalRunTools(value, "requiredTools") ?? [],
    riskSummary: readOptionalString(value, "riskSummary"),
  };
  validateChannelExecutionProposalInput(input);
  return input;
}

export function parseChannelExecutionProposalUpdateInput(value: unknown): UpdateChannelExecutionProposalInput {
  if (!isRecord(value)) {
    throw new Error("Channel proposal update must be a JSON object");
  }
  const input: UpdateChannelExecutionProposalInput = {
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    assigneeTeammateId: readOptionalString(value, "assigneeTeammateId"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria"),
    collaborationSteps: readOptionalChannelExecutionProposalSteps(value, "collaborationSteps"),
    requiredTools: readOptionalRunTools(value, "requiredTools"),
    riskSummary: readNullableString(value, "riskSummary"),
    status: readOptionalChannelExecutionProposalStatus(value, "status"),
    linkedTaskId: readNullableString(value, "linkedTaskId"),
    linkedRunId: readNullableString(value, "linkedRunId"),
    errorMessage: readNullableString(value, "errorMessage"),
  };
  validateChannelExecutionProposalInput(input);
  return input;
}

export function readOptionalChannelExecutionProposalStatusQuery(url: URL): ChannelExecutionProposalStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (value !== "draft" && value !== "accepted" && value !== "cancelled" && value !== "superseded" && value !== "blocked" && value !== "run_failed") {
    throw new Error("status must be one of: draft, accepted, cancelled, superseded, blocked, run_failed");
  }
  return value;
}

export function parseChannelDecisionRequest(value: unknown): ChannelDecisionRequest {
  if (!isRecord(value)) {
    throw new Error("Channel decision request must be a JSON object");
  }
  return {
    sourceMessageId: readOptionalString(value, "sourceMessageId"),
    sourceTaskId: readOptionalString(value, "sourceTaskId"),
    sourceRunId: readOptionalString(value, "sourceRunId"),
    title: readString(value, "title"),
    decision: readString(value, "decision"),
    rationale: readOptionalString(value, "rationale"),
    alternatives: readOptionalStringArray(value, "alternatives") ?? [],
    status: readOptionalChannelDecisionStatus(value, "status"),
    supersedesDecisionId: readOptionalString(value, "supersedesDecisionId"),
    createdBy: readString(value, "createdBy"),
  };
}

export function parseChannelDecisionUpdateRequest(value: unknown): ChannelDecisionUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel decision update must be a JSON object");
  }
  return {
    title: readOptionalString(value, "title"),
    decision: readOptionalString(value, "decision"),
    rationale: readOptionalString(value, "rationale"),
    alternatives: readOptionalStringArray(value, "alternatives"),
    status: readOptionalChannelDecisionStatus(value, "status"),
  };
}

export function readOptionalChannelDecisionStatusQuery(url: URL, key: string): ChannelDecisionStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelDecisionStatuses.includes(value as ChannelDecisionStatus)) {
    throw new Error(`${key} must be one of: ${channelDecisionStatuses.join(", ")}`);
  }
  return value as ChannelDecisionStatus;
}

export function parseChannelHandoffRequest(value: unknown): ChannelHandoffRequest {
  if (!isRecord(value)) {
    throw new Error("Channel handoff request must be a JSON object");
  }
  return {
    sourceMessageId: readOptionalString(value, "sourceMessageId"),
    sourceTaskId: readOptionalString(value, "sourceTaskId"),
    sourceRunId: readOptionalString(value, "sourceRunId"),
    fromParticipantId: readString(value, "fromParticipantId"),
    fromParticipantLabel: readString(value, "fromParticipantLabel"),
    toParticipantId: readString(value, "toParticipantId"),
    toParticipantLabel: readString(value, "toParticipantLabel"),
    reason: readStringAllowEmpty(value, "reason"),
    requiredInput: readStringAllowEmpty(value, "requiredInput"),
    expectedOutput: readStringAllowEmpty(value, "expectedOutput"),
    status: readOptionalChannelHandoffStatus(value, "status"),
    createdBy: readString(value, "createdBy"),
  };
}

export function parseChannelHandoffUpdateRequest(value: unknown): ChannelHandoffUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel handoff update must be a JSON object");
  }
  return {
    fromParticipantId: readOptionalString(value, "fromParticipantId"),
    fromParticipantLabel: readOptionalString(value, "fromParticipantLabel"),
    toParticipantId: readOptionalString(value, "toParticipantId"),
    toParticipantLabel: readOptionalString(value, "toParticipantLabel"),
    reason: readOptionalString(value, "reason"),
    requiredInput: readOptionalString(value, "requiredInput"),
    expectedOutput: readOptionalString(value, "expectedOutput"),
    status: readOptionalChannelHandoffStatus(value, "status"),
  };
}

export function readOptionalChannelHandoffStatusQuery(url: URL, key: string): ChannelHandoffStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelHandoffStatuses.includes(value as ChannelHandoffStatus)) {
    throw new Error(`${key} must be one of: ${channelHandoffStatuses.join(", ")}`);
  }
  return value as ChannelHandoffStatus;
}

export function parseChannelContextSummaryRequest(value: unknown): ChannelContextSummaryRequest {
  if (!isRecord(value)) {
    throw new Error("Channel context summary request must be a JSON object");
  }
  return {
    targetType: readChannelContextSummaryTargetType(value, "targetType"),
    targetId: readString(value, "targetId"),
    sourceMessageIds: readOptionalStringArray(value, "sourceMessageIds") ?? [],
    decisionIds: readOptionalStringArray(value, "decisionIds") ?? [],
    summary: readString(value, "summary"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria") ?? [],
    openQuestions: readOptionalStringArray(value, "openQuestions") ?? [],
    authorType: readChannelContextSummaryAuthorType(value, "authorType"),
    authorId: readOptionalString(value, "authorId"),
  };
}

export function parseChannelContextSummaryUpdateRequest(value: unknown): ChannelContextSummaryUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel context summary update must be a JSON object");
  }
  return {
    targetType: readOptionalChannelContextSummaryTargetType(value, "targetType"),
    targetId: readOptionalString(value, "targetId"),
    sourceMessageIds: readOptionalStringArray(value, "sourceMessageIds"),
    decisionIds: readOptionalStringArray(value, "decisionIds"),
    summary: readOptionalString(value, "summary"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria"),
    openQuestions: readOptionalStringArray(value, "openQuestions"),
    authorType: readOptionalChannelContextSummaryAuthorType(value, "authorType"),
    authorId: readNullableString(value, "authorId"),
  };
}

export function readOptionalChannelContextSummaryTargetTypeQuery(
  url: URL,
  key: string,
): ChannelContextSummaryTargetType | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelContextSummaryTargetTypes.includes(value as ChannelContextSummaryTargetType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryTargetTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryTargetType;
}

export function parseChannelBriefRequest(value: unknown): ChannelBriefRequest {
  if (!isRecord(value)) {
    throw new Error("Channel brief request must be a JSON object");
  }
  return {
    objective: readStringAllowEmpty(value, "objective"),
    scope: readStringAllowEmpty(value, "scope"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria") ?? [],
    openQuestions: readOptionalStringArray(value, "openQuestions") ?? [],
    risks: readOptionalStringArray(value, "risks") ?? [],
    decisionIds: readOptionalStringArray(value, "decisionIds") ?? [],
    attachmentIds: readOptionalStringArray(value, "attachmentIds") ?? [],
    linkPreviewIds: readOptionalStringArray(value, "linkPreviewIds") ?? [],
    updatedBy: readString(value, "updatedBy"),
  };
}

export function parseChannelLinkPreviewRequest(value: unknown): ChannelLinkPreviewRequest {
  if (!isRecord(value)) {
    throw new Error("Channel link preview request must be a JSON object");
  }
  return {
    url: readString(value, "url"),
    messageId: readOptionalString(value, "messageId"),
  };
}

export function parseChannelAttachmentRequest(value: unknown): ChannelAttachmentRequest {
  if (!isRecord(value)) {
    throw new Error("Channel attachment request must be a JSON object");
  }
  const input: ChannelAttachmentRequest = {
    fileName: readString(value, "fileName"),
    contentType: readOptionalString(value, "contentType"),
    contentBase64: readString(value, "contentBase64"),
    messageId: readOptionalString(value, "messageId"),
  };
  if (!input.fileName.trim()) {
    throw new Error("fileName must be a non-empty string");
  }
  if (!input.contentBase64.trim()) {
    throw new Error("contentBase64 must be a non-empty string");
  }
  return input;
}

export function parseChannelMessageRequest(value: unknown): ChannelMessageRequest {
  if (!isRecord(value)) {
    throw new Error("Channel message request must be a JSON object");
  }
  const input: ChannelMessageRequest = {
    threadId: readOptionalString(value, "threadId"),
    kind: readOptionalChannelMessageKind(value, "kind"),
    intent: readOptionalChannelMessageIntent(value, "intent") ?? "discuss",
    authorType: readOptionalChannelMessageAuthorType(value, "authorType") ?? "local-user",
    authorId: readOptionalString(value, "authorId"),
    body: readString(value, "body"),
    mentions: readOptionalChannelMentions(value, "mentions") ?? [],
    attachmentIds: readOptionalStringArray(value, "attachmentIds") ?? [],
    linkPreviewIds: readOptionalStringArray(value, "linkPreviewIds") ?? [],
    linkedTaskId: readOptionalString(value, "linkedTaskId"),
    linkedRunId: readOptionalString(value, "linkedRunId"),
    requestAiReply: readOptionalBoolean(value, "requestAiReply") ?? false,
    providerPresetId: readOptionalString(value, "providerPresetId"),
    teammateId: readOptionalString(value, "teammateId"),
  };
  if (!input.body.trim() && input.attachmentIds.length === 0 && input.linkPreviewIds.length === 0) {
    throw new Error("body, attachmentIds, or linkPreviewIds is required");
  }
  if (input.attachmentIds.length > 10) {
    throw new Error("A channel message can reference at most 10 attachments");
  }
  return input;
}

export function parseChannelWorkflowRequest(value: unknown): ChannelWorkflowRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow request must be a JSON object");
  }
  return {
    sourceHandoffId: readOptionalString(value, "sourceHandoffId"),
    title: readString(value, "title"),
    objective: readStringAllowEmpty(value, "objective"),
    status: readOptionalChannelWorkflowStatus(value, "status"),
    createdBy: readString(value, "createdBy"),
  };
}

export function parseChannelWorkflowFromHandoffRequest(value: unknown): ChannelWorkflowFromHandoffRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow from handoff request must be a JSON object");
  }
  return {
    title: readOptionalString(value, "title"),
    objective: readOptionalString(value, "objective"),
    createdBy: readString(value, "createdBy"),
    contextSummaryId: readOptionalString(value, "contextSummaryId"),
  };
}

export function parseChannelWorkflowUpdateRequest(value: unknown): ChannelWorkflowUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow update must be a JSON object");
  }
  return {
    title: readOptionalString(value, "title"),
    objective: readOptionalString(value, "objective"),
    status: readOptionalChannelWorkflowStatus(value, "status"),
  };
}

export function parseChannelWorkflowStepRequest(value: unknown): ChannelWorkflowStepRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow step request must be a JSON object");
  }
  return {
    sourceHandoffId: readOptionalString(value, "sourceHandoffId"),
    contextSummaryId: readOptionalString(value, "contextSummaryId"),
    position: readOptionalNumber(value, "position"),
    title: readString(value, "title"),
    prompt: readString(value, "prompt"),
    toParticipantId: readString(value, "toParticipantId"),
    toParticipantLabel: readString(value, "toParticipantLabel"),
    status: readOptionalChannelWorkflowStepStatus(value, "status"),
  };
}

export function parseChannelWorkflowStepUpdateRequest(value: unknown): ChannelWorkflowStepUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow step update must be a JSON object");
  }
  return {
    sourceHandoffId: readNullableString(value, "sourceHandoffId"),
    contextSummaryId: readNullableString(value, "contextSummaryId"),
    taskId: readNullableString(value, "taskId"),
    runId: readNullableString(value, "runId"),
    position: readOptionalNumber(value, "position"),
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    toParticipantId: readOptionalString(value, "toParticipantId"),
    toParticipantLabel: readOptionalString(value, "toParticipantLabel"),
    status: readOptionalChannelWorkflowStepStatus(value, "status"),
    blocker: readNullableString(value, "blocker"),
    resultSummary: readNullableString(value, "resultSummary"),
  };
}

export function parseChannelWorkflowStepStartRequest(value: unknown): ChannelWorkflowStepStartRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow step start request must be a JSON object");
  }
  return {
    mode: readChannelWorkflowStepStartMode(value, "mode"),
    taskTitle: readOptionalString(value, "taskTitle"),
    taskPrompt: readOptionalString(value, "taskPrompt"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    runnerId: readOptionalString(value, "runnerId"),
    assigneeTeammateId: readOptionalString(value, "assigneeTeammateId"),
    idempotencyKey: readOptionalString(value, "idempotencyKey"),
    skipProviderPreflight: readOptionalBoolean(value, "skipProviderPreflight"),
  };
}

export function readOptionalChannelWorkflowStatusQuery(url: URL, key: string): ChannelWorkflowStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelWorkflowStatuses.includes(value as ChannelWorkflowStatus)) {
    throw new Error(`${key} must be one of: ${channelWorkflowStatuses.join(", ")}`);
  }
  return value as ChannelWorkflowStatus;
}

export function readOptionalChannelWorkflowStepStatusQuery(url: URL, key: string): ChannelWorkflowStepStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelWorkflowStepStatuses.includes(value as ChannelWorkflowStepStatus)) {
    throw new Error(`${key} must be one of: ${channelWorkflowStepStatuses.join(", ")}`);
  }
  return value as ChannelWorkflowStepStatus;
}

function validateChannelInput(input: ChannelUpdateInput): void {
  if (input.name !== undefined && input.name.trim().length === 0) {
    throw new Error("name must be a non-empty string");
  }
  if (input.allowedTools !== undefined && input.allowedTools.length === 0) {
    throw new Error("allowedTools must contain at least one tool");
  }
}

function validateChannelExecutionProposalInput(
  input: Partial<Pick<CreateChannelExecutionProposalInput, "title" | "prompt" | "assigneeTeammateId" | "acceptanceCriteria" | "collaborationSteps">>,
): void {
  if (input.title !== undefined && input.title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (input.prompt !== undefined && input.prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
  if (input.assigneeTeammateId !== undefined && input.assigneeTeammateId.trim().length === 0) {
    throw new Error("assigneeTeammateId must be a non-empty string");
  }
  if (input.acceptanceCriteria?.some((item) => !item.trim())) {
    throw new Error("acceptanceCriteria entries must be non-empty strings");
  }
  if (input.collaborationSteps?.some((step) => !step.teammateId.trim() || !step.summary.trim())) {
    throw new Error("collaborationSteps entries must contain teammateId and summary");
  }
}

function readOptionalRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  return readOptionalStringArray(record, key, [...readOnlyRunTools, "bash", "edit", "write"] as const);
}

function readOptionalChannelExecutionProposalSteps(
  record: Record<string, unknown>,
  key: string,
): ChannelExecutionProposalStep[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const action = readString(item, "action");
    if (action !== "coordinated" && action !== "consulted" && action !== "reviewed" && action !== "flagged_risk") {
      throw new Error(`${key}[${index}].action must be one of: coordinated, consulted, reviewed, flagged_risk`);
    }
    return {
      teammateId: readString(item, "teammateId"),
      action,
      summary: readString(item, "summary"),
    };
  });
}

function readOptionalChannelExecutionProposalStatus(
  record: Record<string, unknown>,
  key: string,
): ChannelExecutionProposalStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "draft" && value !== "accepted" && value !== "cancelled" && value !== "superseded" && value !== "blocked" && value !== "run_failed") {
    throw new Error(`${key} must be one of: draft, accepted, cancelled, superseded, blocked, run_failed`);
  }
  return value;
}

function readOptionalChannelDecisionStatus(record: Record<string, unknown>, key: string): ChannelDecisionStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelDecisionStatuses.includes(value as ChannelDecisionStatus)) {
    throw new Error(`${key} must be one of: ${channelDecisionStatuses.join(", ")}`);
  }
  return value as ChannelDecisionStatus;
}

function readOptionalChannelHandoffStatus(record: Record<string, unknown>, key: string): ChannelHandoffStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelHandoffStatuses.includes(value as ChannelHandoffStatus)) {
    throw new Error(`${key} must be one of: ${channelHandoffStatuses.join(", ")}`);
  }
  return value as ChannelHandoffStatus;
}

function readOptionalChannelWorkflowStatus(record: Record<string, unknown>, key: string): ChannelWorkflowStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelWorkflowStatuses.includes(value as ChannelWorkflowStatus)) {
    throw new Error(`${key} must be one of: ${channelWorkflowStatuses.join(", ")}`);
  }
  return value as ChannelWorkflowStatus;
}

function readOptionalChannelWorkflowStepStatus(record: Record<string, unknown>, key: string): ChannelWorkflowStepStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelWorkflowStepStatuses.includes(value as ChannelWorkflowStepStatus)) {
    throw new Error(`${key} must be one of: ${channelWorkflowStepStatuses.join(", ")}`);
  }
  return value as ChannelWorkflowStepStatus;
}

function readChannelWorkflowStepStartMode(record: Record<string, unknown>, key: string): ChannelWorkflowStepStartMode {
  const value = readString(record, key);
  if (value !== "create_task" && value !== "create_and_run_task") {
    throw new Error(`${key} must be one of: create_task, create_and_run_task`);
  }
  return value;
}

function readOptionalChannelMessageKind(record: Record<string, unknown>, key: string): ChannelMessageKind | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "message" && value !== "ai_reply" && value !== "system" && value !== "task_link") {
    throw new Error(`${key} must be one of: message, ai_reply, system, task_link`);
  }
  return value;
}

function readOptionalChannelMessageIntent(record: Record<string, unknown>, key: string): ChannelMessageIntent | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "discuss" && value !== "task") {
    throw new Error(`${key} must be one of: discuss, task`);
  }
  return value;
}

function readOptionalChannelMessageAuthorType(record: Record<string, unknown>, key: string): ChannelMessageAuthorType | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "local-user" && value !== "ai-teammate" && value !== "system") {
    throw new Error(`${key} must be one of: local-user, ai-teammate, system`);
  }
  return value;
}

function readOptionalChannelMentions(record: Record<string, unknown>, key: string): ChannelMention[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const id = readString(item, "id");
    const label = readString(item, "label");
    const kind = readString(item, "kind");
    if (kind !== "ai-teammate" && kind !== "local-user" && kind !== "channel") {
      throw new Error(`${key}[${index}].kind must be one of: ai-teammate, local-user, channel`);
    }
    return { id, label, kind };
  });
}

function readChannelContextSummaryTargetType(record: Record<string, unknown>, key: string): ChannelContextSummaryTargetType {
  const value = readString(record, key);
  if (!channelContextSummaryTargetTypes.includes(value as ChannelContextSummaryTargetType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryTargetTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryTargetType;
}

function readOptionalChannelContextSummaryTargetType(
  record: Record<string, unknown>,
  key: string,
): ChannelContextSummaryTargetType | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelContextSummaryTargetTypes.includes(value as ChannelContextSummaryTargetType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryTargetTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryTargetType;
}

function readChannelContextSummaryAuthorType(record: Record<string, unknown>, key: string): ChannelContextSummaryAuthorType {
  const value = readString(record, key);
  if (!channelContextSummaryAuthorTypes.includes(value as ChannelContextSummaryAuthorType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryAuthorTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryAuthorType;
}

function readOptionalChannelContextSummaryAuthorType(
  record: Record<string, unknown>,
  key: string,
): ChannelContextSummaryAuthorType | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelContextSummaryAuthorTypes.includes(value as ChannelContextSummaryAuthorType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryAuthorTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryAuthorType;
}

function readOptionalChannelStatus(record: Record<string, unknown>, key: string): Channel["status"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "active" && value !== "paused" && value !== "archived") {
    throw new Error(`${key} must be one of: active, paused, archived`);
  }
  return value;
}

function readOptionalChannelRuntimePolicy(
  record: Record<string, unknown>,
  key: string,
): CreateChannelInput["runtimePolicy"] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const policy: {
    maxConcurrentRuns?: number;
    executionMode?: "serial" | "parallel";
    writeLockScope?: "channel" | "boundPath" | "workspace";
    allowReadOnlyParallel?: boolean;
    queueOnConflict?: boolean;
  } = {};
  const maxConcurrentRuns = value.maxConcurrentRuns;
  if (maxConcurrentRuns !== undefined) {
    if (typeof maxConcurrentRuns !== "number" || !Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 20) {
      throw new Error(`${key}.maxConcurrentRuns must be an integer between 1 and 20`);
    }
    policy.maxConcurrentRuns = maxConcurrentRuns;
  }
  if (value.executionMode !== undefined) {
    if (value.executionMode !== "serial" && value.executionMode !== "parallel") {
      throw new Error(`${key}.executionMode must be serial or parallel`);
    }
    policy.executionMode = value.executionMode;
  }
  if (value.writeLockScope !== undefined) {
    if (value.writeLockScope !== "channel" && value.writeLockScope !== "boundPath" && value.writeLockScope !== "workspace") {
      throw new Error(`${key}.writeLockScope must be channel, boundPath, or workspace`);
    }
    policy.writeLockScope = value.writeLockScope;
  }
  if (value.allowReadOnlyParallel !== undefined) {
    if (typeof value.allowReadOnlyParallel !== "boolean") {
      throw new Error(`${key}.allowReadOnlyParallel must be a boolean`);
    }
    policy.allowReadOnlyParallel = value.allowReadOnlyParallel;
  }
  if (value.queueOnConflict !== undefined) {
    if (typeof value.queueOnConflict !== "boolean") {
      throw new Error(`${key}.queueOnConflict must be a boolean`);
    }
    policy.queueOnConflict = value.queueOnConflict;
  }
  return policy;
}
