import type { RunEventDataByType, RunEventType } from "./runtime.js";

const RUN_EVENT_TYPES = new Set<RunEventType>([
  "run_created",
  "run_start",
  "turn_start",
  "turn_end",
  "assistant_text_delta",
  "assistant_thinking_delta",
  "tool_hydration_request",
  "tool_hydration_end",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "run_end",
  "run_error",
  "run_cancelled",
  "approval_requested",
  "approval_approved",
  "approval_denied",
  "approval_expired",
  "approval_cancelled",
  "artifact_created",
  "workspace_change_recovery_started",
  "workspace_changes_undone",
  "workspace_changes_reapplied",
  "run_intervention_created",
  "run_followup_queued",
  "run_interrupt_requested",
  "run_continuation_starting",
  "run_continuation_started",
  "run_intervention_failed",
  "stale_runner_completion_ignored",
  "result",
  "progress",
]);

export function isRunEventType(value: unknown): value is RunEventType {
  return typeof value === "string" && RUN_EVENT_TYPES.has(value as RunEventType);
}

export function isRunEventData<K extends RunEventType>(
  type: K,
  value: unknown,
): value is RunEventDataByType[K] {
  if (!isRecord(value)) return false;
  switch (type) {
    case "assistant_text_delta":
    case "assistant_thinking_delta":
      return typeof value.text === "string";
    case "tool_start":
      return typeof value.toolName === "string"
        && optionalString(value.toolCallId);
    case "tool_update":
      return typeof value.toolName === "string"
        && optionalString(value.toolCallId);
    case "tool_end":
      return typeof value.toolName === "string"
        && typeof value.isError === "boolean"
        && optionalString(value.toolCallId);
    case "run_error":
      return typeof value.message === "string";
    case "approval_requested":
      return typeof value.approvalId === "string"
        && optionalString(value.toolCallId)
        && optionalString(value.title)
        && optionalString(value.description)
        && optionalString(value.expiresAt);
    case "approval_approved":
    case "approval_denied":
    case "approval_expired":
    case "approval_cancelled":
      return typeof value.approvalId === "string"
        && optionalString(value.decisionReason);
    case "run_cancelled":
      return optionalString(value.reason)
        && (value.active === undefined || typeof value.active === "boolean");
    case "message_end":
      return optionalString(value.role)
        && optionalString(value.text)
        && optionalString(value.stopReason)
        && optionalString(value.errorMessage)
        && (value.contentKinds === undefined
          || (Array.isArray(value.contentKinds) && value.contentKinds.every((item) => typeof item === "string")));
    case "progress":
      return optionalString(value.message);
    default:
      return true;
  }
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
