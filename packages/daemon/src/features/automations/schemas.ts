import type {
  AutomationDraftSource,
  AutomationDraftStatus,
  AutomationExecutionEnvironment,
  AutomationExecutionPolicy,
  AutomationKind,
  AutomationMode,
  AutomationOutputPolicy,
  AutomationPromptTemplate,
  AutomationReasoningEffort,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationStatus,
  AutomationTarget,
  AutomationTrigger,
  RunTool,
  SkillApprovalProfile,
  BuiltinAutomationTemplateId,
} from "@ling-stack/core";
import { readAutomationContextItemBudget, readOnlyRunTools } from "@ling-stack/core";
import { isRecord, readNullableString, readOptionalBoolean, readOptionalNumber, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";
import { isSupportedAutomationRRule } from "./recurrence.js";

export interface CreateAutomationRequest {
  readonly kind: AutomationKind;
  readonly title: string;
  readonly automationMode?: AutomationMode;
  readonly channelId?: string;
  readonly description?: string;
  readonly target?: AutomationTarget;
  readonly trigger?: AutomationTrigger;
  readonly rrule?: string;
  readonly cwds?: readonly string[];
  readonly targetThreadId?: string;
  readonly executionEnvironment?: AutomationExecutionEnvironment;
  readonly reasoningEffort?: AutomationReasoningEffort;
  readonly model?: string;
  readonly promptTemplate?: AutomationPromptTemplate;
  readonly executionPolicy?: AutomationExecutionPolicy;
  readonly outputPolicy?: AutomationOutputPolicy;
  readonly status?: AutomationStatus;
}

export interface UpdateAutomationRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly automationMode?: AutomationMode;
  readonly status?: AutomationStatus;
  readonly trigger?: AutomationTrigger;
  readonly rrule?: string | null;
  readonly cwds?: readonly string[];
  readonly targetThreadId?: string | null;
  readonly executionEnvironment?: AutomationExecutionEnvironment | null;
  readonly reasoningEffort?: AutomationReasoningEffort | null;
  readonly model?: string | null;
  readonly target?: AutomationTarget;
  readonly promptTemplate?: AutomationPromptTemplate;
  readonly executionPolicy?: AutomationExecutionPolicy;
  readonly outputPolicy?: AutomationOutputPolicy;
  readonly nextRunAt?: string | null;
}

export interface AutomationRunRequest {
  readonly idempotencyKey?: string;
  readonly triggerType?: AutomationTrigger["type"];
  readonly scheduledFor?: string;
}

export interface AutomationRunCancelRequest {
  readonly reason?: string;
}

type AutomationDraftPartialRequest = Partial<Omit<CreateAutomationRequest, "rrule">> & { readonly rrule?: string | null };

export interface CreateAutomationDraftRequest {
  readonly source: AutomationDraftSource;
  readonly templateId?: BuiltinAutomationTemplateId;
  readonly prompt?: string;
  readonly partialAutomation?: AutomationDraftPartialRequest;
  readonly proposedByRunId?: string;
  readonly proposedByThreadId?: string;
}

export interface UpdateAutomationDraftRequest {
  readonly partialAutomation?: AutomationDraftPartialRequest;
  readonly proposedByRunId?: string | null;
  readonly proposedByThreadId?: string | null;
}

const automationStatuses: readonly AutomationStatus[] = ["enabled", "disabled", "paused", "archived", "error"];
const automationKinds: readonly AutomationKind[] = ["daily_brief", "weekly_review", "project_monitor", "custom_prompt"];
const automationModes: readonly AutomationMode[] = ["cron", "heartbeat"];
const automationExecutionEnvironments: readonly AutomationExecutionEnvironment[] = ["local", "worktree"];
const automationReasoningEfforts: readonly AutomationReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const automationDraftSources: readonly AutomationDraftSource[] = ["template", "manual", "chat"];
const automationDraftStatuses: readonly AutomationDraftStatus[] = ["draft", "needs_user_input", "ready_for_confirmation", "confirmed", "discarded"];
const builtinAutomationTemplateIds: readonly BuiltinAutomationTemplateId[] = [
  "daily_brief",
  "weekly_review",
  "ci_failure_summary",
  "release_note_draft",
  "bug_scan",
  "pr_risk_summary",
  "ownership_suggestion",
  "dependency_check",
];
const automationRunStatuses: readonly AutomationRunStatus[] = [
  "queued",
  "skipped",
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
];
const runTools: readonly RunTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

export function parseCreateAutomationRequest(value: unknown): CreateAutomationRequest {
  if (!isRecord(value)) {
    throw new Error("Automation create request must be an object");
  }
  const kind = parseAutomationKind(readString(value, "kind"));
  if (kind === "project_monitor") {
    throw new Error("project_monitor_not_implemented");
  }
  const channelId = readOptionalString(value, "channelId");
  const target = parseOptionalAutomationTarget(value.target);
  const automationMode = parseOptionalAutomationMode(value.automationMode);
  const targetThreadId = readOptionalString(value, "targetThreadId");
  if (!channelId && !target && !(automationMode === "heartbeat" && targetThreadId)) {
    throw new Error("channelId or target is required");
  }
  return {
    kind,
    title: readString(value, "title"),
    automationMode,
    channelId,
    description: readOptionalString(value, "description"),
    target,
    trigger: parseOptionalAutomationTrigger(value.trigger),
    rrule: validateAutomationRRule(readOptionalString(value, "rrule")),
    cwds: readOptionalStringArray(value, "cwds"),
    targetThreadId,
    executionEnvironment: parseOptionalAutomationExecutionEnvironment(value.executionEnvironment),
    reasoningEffort: parseOptionalAutomationReasoningEffort(value.reasoningEffort),
    model: readOptionalString(value, "model"),
    promptTemplate: parseOptionalAutomationPromptTemplate(value.promptTemplate),
    executionPolicy: parseOptionalAutomationExecutionPolicy(value.executionPolicy),
    outputPolicy: parseOptionalAutomationOutputPolicy(value.outputPolicy),
    status: parseOptionalAutomationStatus(value.status),
  };
}

export function parseCreateAutomationDraftRequest(value: unknown): CreateAutomationDraftRequest {
  if (!isRecord(value)) {
    throw new Error("Automation draft create request must be an object");
  }
  return {
    source: parseAutomationDraftSource(readString(value, "source")),
    templateId: parseOptionalBuiltinAutomationTemplateId(value.templateId),
    prompt: readOptionalString(value, "prompt"),
    partialAutomation: parseDraftPartialAutomationRequest(value.partialAutomation),
    proposedByRunId: readOptionalString(value, "proposedByRunId"),
    proposedByThreadId: readOptionalString(value, "proposedByThreadId"),
  };
}

export function parseUpdateAutomationDraftRequest(value: unknown): UpdateAutomationDraftRequest {
  if (!isRecord(value)) {
    throw new Error("Automation draft update request must be an object");
  }
  return {
    partialAutomation: parseDraftPartialAutomationRequest(value.partialAutomation ?? value),
    proposedByRunId: readNullableString(value, "proposedByRunId"),
    proposedByThreadId: readNullableString(value, "proposedByThreadId"),
  };
}

export function parseUpdateAutomationRequest(value: unknown): UpdateAutomationRequest {
  if (!isRecord(value)) {
    throw new Error("Automation update request must be an object");
  }
  return {
    title: readOptionalString(value, "title"),
    description: readNullableString(value, "description"),
    automationMode: parseOptionalAutomationMode(value.automationMode),
    status: parseOptionalAutomationStatus(value.status),
    trigger: parseOptionalAutomationTrigger(value.trigger),
    rrule: validateAutomationRRule(readNullableString(value, "rrule")),
    cwds: readOptionalStringArray(value, "cwds"),
    targetThreadId: readNullableString(value, "targetThreadId"),
    executionEnvironment: parseNullableAutomationExecutionEnvironment(value.executionEnvironment),
    reasoningEffort: parseNullableAutomationReasoningEffort(value.reasoningEffort),
    model: readNullableString(value, "model"),
    target: parseOptionalAutomationTarget(value.target),
    promptTemplate: parseOptionalAutomationPromptTemplate(value.promptTemplate),
    executionPolicy: parseOptionalAutomationExecutionPolicy(value.executionPolicy),
    outputPolicy: parseOptionalAutomationOutputPolicy(value.outputPolicy),
    nextRunAt: readNullableString(value, "nextRunAt"),
  };
}

export function parseAutomationRunRequest(value: unknown | undefined): AutomationRunRequest {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Automation run request must be an object");
  }
  const triggerType = readOptionalString(value, "triggerType");
  if (triggerType !== undefined && triggerType !== "manual" && triggerType !== "schedule" && triggerType !== "monitor") {
    throw new Error("triggerType must be manual, schedule, or monitor");
  }
  return {
    idempotencyKey: readOptionalString(value, "idempotencyKey"),
    triggerType,
    scheduledFor: readOptionalString(value, "scheduledFor"),
  };
}

export function parseAutomationRunCancelRequest(value: unknown | undefined): AutomationRunCancelRequest {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Automation run cancel request must be an object");
  }
  return { reason: readOptionalString(value, "reason") };
}

export function parseOptionalAutomationRunStatusQuery(raw: string | null): AutomationRunStatus | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!automationRunStatuses.includes(raw as AutomationRunStatus)) {
    throw new Error(`Unsupported automation run status: ${raw}`);
  }
  return raw as AutomationRunStatus;
}

export function parseOptionalAutomationStatusQuery(raw: string | null): AutomationStatus | undefined {
  if (raw === null) {
    return undefined;
  }
  return parseAutomationStatus(raw);
}

export function parseOptionalAutomationKindQuery(raw: string | null): AutomationKind | undefined {
  if (raw === null) {
    return undefined;
  }
  return parseAutomationKind(raw);
}

export function parseOptionalAutomationDraftStatusQuery(raw: string | null): AutomationDraftStatus | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!automationDraftStatuses.includes(raw as AutomationDraftStatus)) {
    throw new Error(`Unsupported automation draft status: ${raw}`);
  }
  return raw as AutomationDraftStatus;
}

export function parseOptionalAutomationDraftSourceQuery(raw: string | null): AutomationDraftSource | undefined {
  if (raw === null) {
    return undefined;
  }
  return parseAutomationDraftSource(raw);
}

function parseAutomationDraftSource(value: string): AutomationDraftSource {
  if (!automationDraftSources.includes(value as AutomationDraftSource)) {
    throw new Error(`Unsupported automation draft source: ${value}`);
  }
  return value as AutomationDraftSource;
}

function parseAutomationKind(value: string): AutomationKind {
  if (!automationKinds.includes(value as AutomationKind)) {
    throw new Error(`Unsupported automation kind: ${value}`);
  }
  return value as AutomationKind;
}

function parseOptionalBuiltinAutomationTemplateId(value: unknown): BuiltinAutomationTemplateId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("templateId must be a string");
  }
  if (!builtinAutomationTemplateIds.includes(value as BuiltinAutomationTemplateId)) {
    throw new Error(`Unsupported automation template id: ${value}`);
  }
  return value as BuiltinAutomationTemplateId;
}

function parseDraftPartialAutomationRequest(value: unknown): AutomationDraftPartialRequest | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("partialAutomation must be an object");
  }
  const kind = readOptionalString(value, "kind");
  return {
    kind: kind ? parseAutomationKind(kind) : undefined,
    title: readOptionalString(value, "title"),
    automationMode: parseOptionalAutomationMode(value.automationMode),
    channelId: readOptionalString(value, "channelId"),
    description: readOptionalString(value, "description"),
    target: parseOptionalAutomationTarget(value.target),
    trigger: parseOptionalAutomationTrigger(value.trigger),
    rrule: validateAutomationRRule(readNullableString(value, "rrule")),
    cwds: readOptionalStringArray(value, "cwds"),
    targetThreadId: readOptionalString(value, "targetThreadId"),
    executionEnvironment: parseOptionalAutomationExecutionEnvironment(value.executionEnvironment),
    reasoningEffort: parseOptionalAutomationReasoningEffort(value.reasoningEffort),
    model: readOptionalString(value, "model"),
    promptTemplate: parseOptionalAutomationPromptTemplate(value.promptTemplate),
    executionPolicy: parseOptionalAutomationExecutionPolicy(value.executionPolicy),
    outputPolicy: parseOptionalAutomationOutputPolicy(value.outputPolicy),
    status: parseOptionalAutomationStatus(value.status),
  };
}

/** Validate authored rules before any definition or draft is persisted. */
function validateAutomationRRule<T extends string | null | undefined>(rule: T): T {
  if (rule && !isSupportedAutomationRRule(rule)) {
    throw new Error("rrule contains unsupported fields or invalid recurrence values");
  }
  return rule;
}

function parseAutomationStatus(value: string): AutomationStatus {
  if (!automationStatuses.includes(value as AutomationStatus)) {
    throw new Error(`Unsupported automation status: ${value}`);
  }
  return value as AutomationStatus;
}

function parseOptionalAutomationStatus(value: unknown): AutomationStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("status must be a string");
  }
  return parseAutomationStatus(value);
}

function parseOptionalAutomationMode(value: unknown): AutomationMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !automationModes.includes(value as AutomationMode)) {
    throw new Error("automationMode must be cron or heartbeat");
  }
  return value as AutomationMode;
}

function parseOptionalAutomationExecutionEnvironment(value: unknown): AutomationExecutionEnvironment | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !automationExecutionEnvironments.includes(value as AutomationExecutionEnvironment)) {
    throw new Error("executionEnvironment must be local or worktree");
  }
  return value as AutomationExecutionEnvironment;
}

function parseNullableAutomationExecutionEnvironment(value: unknown): AutomationExecutionEnvironment | null | undefined {
  if (value === null) {
    return null;
  }
  return parseOptionalAutomationExecutionEnvironment(value);
}

function parseOptionalAutomationReasoningEffort(value: unknown): AutomationReasoningEffort | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !automationReasoningEfforts.includes(value as AutomationReasoningEffort)) {
    throw new Error("reasoningEffort must be low, medium, high, or xhigh");
  }
  return value as AutomationReasoningEffort;
}

function parseNullableAutomationReasoningEffort(value: unknown): AutomationReasoningEffort | null | undefined {
  if (value === null) {
    return null;
  }
  return parseOptionalAutomationReasoningEffort(value);
}

function parseOptionalAutomationTrigger(value: unknown): AutomationTrigger | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("trigger must be an object");
  }
  const type = readString(value, "type");
  if (type === "manual") {
    return { type };
  }
  if (type === "schedule") {
    return {
      type,
      timezone: readString(value, "timezone"),
      schedule: parseAutomationSchedule(value.schedule),
      missedRunPolicy: parseMissedRunPolicy(readOptionalString(value, "missedRunPolicy")),
    };
  }
  if (type === "monitor") {
    throw new Error("monitor_not_implemented");
  }
  throw new Error(`Unsupported automation trigger type: ${type}`);
}

function parseAutomationSchedule(value: unknown): AutomationSchedule {
  if (!isRecord(value)) {
    throw new Error("schedule must be an object");
  }
  const cadence = readString(value, "cadence");
  if (cadence === "daily") {
    return { cadence, timeOfDay: readTimeOfDay(value, "timeOfDay") };
  }
  if (cadence === "weekly") {
    const weekday = readOptionalNumber(value, "weekday");
    if (weekday === undefined || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error("weekday must be an integer from 0 to 6");
    }
    return { cadence, weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay: readTimeOfDay(value, "timeOfDay") };
  }
  if (cadence === "interval") {
    const everyMs = readOptionalNumber(value, "everyMs");
    if (everyMs === undefined || everyMs < 1000) {
      throw new Error("everyMs must be at least 1000");
    }
    return { cadence, everyMs };
  }
  throw new Error(`Unsupported automation schedule cadence: ${cadence}`);
}

function parseMissedRunPolicy(value: string | undefined): "skip" | "run_one" {
  if (value === undefined || value === "skip") {
    return "skip";
  }
  if (value === "run_one") {
    return value;
  }
  throw new Error(`Unsupported missedRunPolicy: ${value}`);
}

function parseOptionalAutomationTarget(value: unknown): AutomationTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("target must be an object");
  }
  const scope = readString(value, "scope");
  if (scope !== "workspace" && scope !== "channel" && scope !== "task" && scope !== "thread" && scope !== "external_work") {
    throw new Error(`Unsupported automation target scope: ${scope}`);
  }
  return {
    scope,
    workspaceId: readString(value, "workspaceId"),
    channelId: readOptionalString(value, "channelId"),
    taskId: readOptionalString(value, "taskId"),
    threadId: readOptionalString(value, "threadId"),
    externalWorkId: readOptionalString(value, "externalWorkId"),
    cwd: readOptionalString(value, "cwd"),
  };
}

function parseOptionalAutomationPromptTemplate(value: unknown): AutomationPromptTemplate | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("promptTemplate must be an object");
  }
  const contextSelectors = value.contextSelectors;
  if (!Array.isArray(contextSelectors)) {
    throw new Error("promptTemplate.contextSelectors must be an array");
  }
  const maxContextItems = readAutomationContextItemBudget(value.maxContextItems);
  return {
    templateVersion: readOptionalNumber(value, "templateVersion") ?? 1,
    systemPurpose: readOptionalString(value, "systemPurpose"),
    promptMarkdown: readString(value, "promptMarkdown"),
    contextSelectors: contextSelectors.map(parseAutomationContextSelector),
    ...(maxContextItems === undefined ? {} : { maxContextItems }),
  };
}

function parseAutomationContextSelector(value: unknown): AutomationPromptTemplate["contextSelectors"][number] {
  if (!isRecord(value)) {
    throw new Error("context selector must be an object");
  }
  const kind = readString(value, "kind");
  if (kind === "channel_brief" || kind === "doctor_summary" || kind === "mcp_status") {
    return { kind, channelId: kind === "channel_brief" ? readOptionalString(value, "channelId") : undefined } as AutomationPromptTemplate["contextSelectors"][number];
  }
  if (kind === "recent_runs" || kind === "pending_approvals" || kind === "recent_artifacts" || kind === "state_transitions") {
    return { kind, limit: readBoundedLimit(value, "limit") } as AutomationPromptTemplate["contextSelectors"][number];
  }
  if (kind === "external_work") {
    return { kind, status: readOptionalString(value, "status"), limit: readBoundedLimit(value, "limit") };
  }
  throw new Error(`Unsupported automation context selector: ${kind}`);
}

function parseOptionalAutomationExecutionPolicy(value: unknown): AutomationExecutionPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("executionPolicy must be an object");
  }
  const allowedTools = value.allowedTools;
  return {
    providerPresetId: readOptionalString(value, "providerPresetId"),
    teammateId: readOptionalString(value, "teammateId"),
    requestedSkillId: readOptionalString(value, "requestedSkillId"),
    runnerId: readOptionalString(value, "runnerId"),
    allowedTools: allowedTools === undefined ? undefined : parseRunTools(allowedTools),
    approvalProfile: parseOptionalApprovalProfile(value.approvalProfile),
    permissionMode: parseOptionalPermissionMode(readOptionalString(value, "permissionMode")),
    skipProviderPreflight: readOptionalBoolean(value, "skipProviderPreflight"),
  };
}

function parseOptionalAutomationOutputPolicy(value: unknown): AutomationOutputPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("outputPolicy must be an object");
  }
  const destinations = value.destinations;
  if (!Array.isArray(destinations)) {
    throw new Error("outputPolicy.destinations must be an array");
  }
  for (const destination of destinations) {
    if (!isRecord(destination)) {
      throw new Error("outputPolicy destination must be an object");
    }
    const type = readString(destination, "type");
    if (type !== "automation_thread" && type !== "markdown_artifact") {
      throw new Error(`Unsupported P0 automation output destination: ${type}`);
    }
  }
  return {
    destinations: destinations as AutomationOutputPolicy["destinations"],
    artifactFormat: "markdown",
  };
}

function parseOptionalApprovalProfile(value: unknown): SkillApprovalProfile | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("approvalProfile must be an object");
  }
  return parseApprovalProfileObject(value, "approvalProfile");
}

function parseRunTools(value: unknown): readonly RunTool[] {
  if (!Array.isArray(value)) {
    throw new Error("allowedTools must be an array");
  }
  const tools = value.map((item) => {
    if (typeof item !== "string" || !runTools.includes(item as RunTool)) {
      throw new Error(`Unsupported run tool: ${String(item)}`);
    }
    return item as RunTool;
  });
  return tools.length > 0 ? [...new Set(tools)] : [...readOnlyRunTools];
}

function parseOptionalPermissionMode(value: string | undefined): AutomationExecutionPolicy["permissionMode"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === "read_only") {
    return "ask_everything";
  }
  if (value !== "ask_everything" && value !== "balanced" && value !== "workspace_write" && value !== "full_access" && value !== "custom") {
    throw new Error(`Unsupported permissionMode: ${value}`);
  }
  return value;
}

function readBoundedLimit(record: Record<string, unknown>, key: string): number {
  const value = readOptionalNumber(record, key) ?? 10;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${key} must be an integer from 1 to 100`);
  }
  return value;
}

function readTimeOfDay(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(`${key} must use HH:mm`);
  }
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`${key} must be a valid HH:mm time`);
  }
  return value;
}
