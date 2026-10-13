import type { SQLOutputValue } from "node:sqlite";
import {
  type AutomationDraft,
  type AutomationDraftField,
  type AutomationDraftSource,
  type AutomationDraftStatus,
  type AutomationDefinition,
  type AutomationExecutionEnvironment,
  type AutomationExecutionPolicy,
  type AutomationKind,
  type AutomationMode,
  type AutomationOutputPolicy,
  type AutomationPromptTemplate,
  type AutomationReasoningEffort,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationStatus,
  type AutomationTarget,
  type AutomationTrigger,
} from "../../automation-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  parseJsonStringArray,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapAutomationDefinition(row: Record<string, SQLOutputValue>): AutomationDefinition {
  const trigger = parseAutomationTrigger(readString(row, "trigger_json"));
  const target = parseAutomationTarget(readString(row, "target_json"));
  const rrule = readNullableString(row, "rrule") ?? automationTriggerToRRule(trigger);
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    threadId: readString(row, "thread_id"),
    automationMode: parseAutomationMode(readNullableString(row, "automation_mode") ?? "cron"),
    title: readString(row, "title"),
    description: readNullableString(row, "description"),
    kind: readString(row, "kind") as AutomationKind,
    status: readString(row, "status") as AutomationStatus,
    trigger,
    rrule,
    cwds: parseJsonStringArray(readNullableString(row, "cwds_json") ?? "[]"),
    targetThreadId: readNullableString(row, "target_thread_id"),
    executionEnvironment: parseOptionalAutomationExecutionEnvironment(readNullableString(row, "execution_environment")),
    reasoningEffort: parseOptionalAutomationReasoningEffort(readNullableString(row, "reasoning_effort")),
    model: readNullableString(row, "model"),
    target,
    promptTemplate: parseAutomationPromptTemplate(readString(row, "prompt_template_json")),
    executionPolicy: parseAutomationExecutionPolicy(readString(row, "execution_policy_json")),
    outputPolicy: parseAutomationOutputPolicy(readString(row, "output_policy_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    lastRunId: readNullableString(row, "last_run_id"),
    nextRunAt: readNullableString(row, "next_run_at"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
  });
}

export function mapAutomationDraft(row: Record<string, SQLOutputValue>): AutomationDraft {
  const payload = parseJsonObject(readString(row, "draft_json"));
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    source: readString(row, "source") as AutomationDraftSource,
    status: readString(row, "status") as AutomationDraftStatus,
    title: readOptionalStringValue(payload.title),
    description: readOptionalStringValue(payload.description),
    kind: readOptionalStringValue(payload.kind) as AutomationKind | undefined,
    trigger: payload.trigger as AutomationTrigger | undefined,
    rrule: readOptionalStringValue(payload.rrule),
    target: payload.target as AutomationTarget | undefined,
    promptTemplate: payload.promptTemplate as AutomationPromptTemplate | undefined,
    executionPolicy: payload.executionPolicy as AutomationExecutionPolicy | undefined,
    outputPolicy: payload.outputPolicy as AutomationOutputPolicy | undefined,
    missingFields: parseJsonStringArray(readString(row, "missing_fields_json")).filter(isAutomationDraftField),
    warnings: parseJson(readString(row, "warnings_json")) as AutomationDraft["warnings"],
    proposedByRunId: readNullableString(row, "proposed_by_run_id"),
    proposedByThreadId: readNullableString(row, "proposed_by_thread_id"),
    confirmedAutomationId: readNullableString(row, "confirmed_automation_id"),
    discardedAt: readNullableString(row, "discarded_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapAutomationRun(row: Record<string, SQLOutputValue>): AutomationRun {
  return omitUndefined({
    id: readString(row, "id"),
    automationId: readString(row, "automation_id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    threadId: readString(row, "thread_id"),
    runId: readNullableString(row, "run_id"),
    triggerType: readString(row, "trigger_type") as AutomationRun["triggerType"],
    scheduledFor: readNullableString(row, "scheduled_for"),
    firedAt: readString(row, "fired_at"),
    startedAt: readNullableString(row, "started_at"),
    completedAt: readNullableString(row, "completed_at"),
    status: readString(row, "status") as AutomationRunStatus,
    idempotencyKey: readString(row, "idempotency_key"),
    contextPreviewArtifactId: readNullableString(row, "context_preview_artifact_id"),
    outputArtifactIds: parseJsonStringArray(readString(row, "output_artifact_ids_json")),
    skipReason: readNullableString(row, "skip_reason"),
    errorMessage: readNullableString(row, "error_message"),
  });
}

function parseAutomationTrigger(value: string): AutomationTrigger {
  const parsed = parseJsonObject(value);
  if (parsed.type !== "manual" && parsed.type !== "schedule" && parsed.type !== "monitor") {
    throw new Error("Expected automation trigger from SQLite");
  }
  return parsed as unknown as AutomationTrigger;
}

function parseAutomationMode(value: string): AutomationMode {
  if (value !== "cron" && value !== "heartbeat") {
    throw new Error("Expected automation mode from SQLite");
  }
  return value;
}

function parseOptionalAutomationExecutionEnvironment(value: string | undefined): AutomationExecutionEnvironment | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "local" && value !== "worktree") {
    throw new Error("Expected automation execution environment from SQLite");
  }
  return value;
}

function parseOptionalAutomationReasoningEffort(value: string | undefined): AutomationReasoningEffort | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "low" && value !== "medium" && value !== "high" && value !== "xhigh") {
    throw new Error("Expected automation reasoning effort from SQLite");
  }
  return value;
}

function automationTriggerToRRule(trigger: AutomationTrigger): string | undefined {
  if (trigger.type !== "schedule") {
    return undefined;
  }
  if (trigger.schedule.cadence === "daily") {
    const [hour = "09", minute = "00"] = trigger.schedule.timeOfDay.split(":");
    return `FREQ=DAILY;BYHOUR=${Number.parseInt(hour, 10)};BYMINUTE=${Number.parseInt(minute, 10)};BYSECOND=0`;
  }
  if (trigger.schedule.cadence === "weekly") {
    const [hour = "09", minute = "00"] = trigger.schedule.timeOfDay.split(":");
    const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][trigger.schedule.weekday] ?? "MO";
    return `FREQ=WEEKLY;BYDAY=${weekday};BYHOUR=${Number.parseInt(hour, 10)};BYMINUTE=${Number.parseInt(minute, 10)};BYSECOND=0`;
  }
  if (trigger.schedule.cadence === "interval") {
    const minutes = Math.max(Math.round(trigger.schedule.everyMs / 60000), 1);
    return `FREQ=MINUTELY;INTERVAL=${minutes}`;
  }
  return undefined;
}

function parseAutomationTarget(value: string): AutomationTarget {
  const parsed = parseJsonObject(value);
  if (
    parsed.scope !== "workspace" &&
    parsed.scope !== "channel" &&
    parsed.scope !== "task" &&
    parsed.scope !== "thread" &&
    parsed.scope !== "external_work"
  ) {
    throw new Error("Expected automation target from SQLite");
  }
  if (typeof parsed.workspaceId !== "string") {
    throw new Error("Expected automation target workspaceId from SQLite");
  }
  return parsed as unknown as AutomationTarget;
}

function parseAutomationPromptTemplate(value: string): AutomationPromptTemplate {
  const parsed = parseJsonObject(value);
  if (
    typeof parsed.templateVersion !== "number" ||
    typeof parsed.promptMarkdown !== "string" ||
    !Array.isArray(parsed.contextSelectors)
  ) {
    throw new Error("Expected automation prompt template from SQLite");
  }
  return parsed as unknown as AutomationPromptTemplate;
}

function parseAutomationExecutionPolicy(value: string): AutomationExecutionPolicy {
  return parseJsonObject(value) as unknown as AutomationExecutionPolicy;
}

function parseAutomationOutputPolicy(value: string): AutomationOutputPolicy {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed.destinations) || parsed.artifactFormat !== "markdown") {
    throw new Error("Expected automation output policy from SQLite");
  }
  return parsed as unknown as AutomationOutputPolicy;
}

function isAutomationDraftField(value: string): value is AutomationDraftField {
  return (
    value === "title" ||
    value === "kind" ||
    value === "trigger" ||
    value === "target" ||
    value === "promptTemplate" ||
    value === "outputPolicy"
  );
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
