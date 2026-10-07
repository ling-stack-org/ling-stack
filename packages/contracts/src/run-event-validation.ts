import type { RunEventDataByType, RunEventType } from "./runtime.js";
import { isHostCommandPreparedV1, isHostCommandSettledV1 } from "./host-command-journal.js";
import { isRunProviderErrorDiagnostic, isRunProviderRetryEvidence } from "./provider-diagnostics.js";

const RUN_EVENT_TYPES = new Set<RunEventType>([
  "host_command_prepared",
  "host_command_settled",
  "run_created",
  "run_start",
  "turn_start",
  "turn_end",
  "provider_retry",
  "context_compaction_start",
  "context_compaction_end",
  "assistant_text_delta",
  "assistant_thinking_delta",
  "assistant_reasoning_summary",
  "tool_hydration_request",
  "tool_hydration_end",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "loop_detected",
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
    case "host_command_prepared": return isHostCommandPreparedV1(value);
    case "host_command_settled": return isHostCommandSettledV1(value);
    case "provider_retry": return isRunProviderRetryEvidence(value);
    case "assistant_text_delta":
    case "assistant_thinking_delta":
      return typeof value.text === "string";
    case "assistant_reasoning_summary":
      return value.semantic === "safe_summary"
        && value.source === "openai_responses"
        && typeof value.truncated === "boolean"
        && typeof value.text === "string"
        && value.text.length > 0
        && value.text.length <= 24_001
        && Array.isArray(value.parts)
        && value.parts.length > 0
        && value.parts.length <= 32
        && value.parts.every((part) => typeof part === "string" && part.length > 0 && part.length <= 24_001)
        && value.text === value.parts.join("\n\n")
        && (value.attemptId === undefined
          || (typeof value.attemptId === "string" && value.attemptId.trim().length > 0));
    case "context_compaction_start":
      return isCompactionReason(value.reason)
        && value.policyVersion === "pi_sdk_lifecycle_v1"
        && optionalNonEmptyString(value.attemptId);
    case "context_compaction_end":
      return isCompactionReason(value.reason)
        && value.policyVersion === "pi_sdk_lifecycle_v1"
        && ["sdk_installed", "aborted", "failed"].includes(String(value.outcome))
        && typeof value.willRetry === "boolean"
        && optionalNonNegativeSafeInteger(value.tokensBefore)
        && optionalNonNegativeSafeInteger(value.estimatedTokensAfter)
        && (value.usage === undefined || isRunTokenUsage(value.usage))
        && optionalNonEmptyString(value.attemptId);
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
    case "loop_detected":
      return value.code === "execution_loop_detected"
        && typeof value.attemptId === "string"
        && ["exact_repeat", "repeated_update", "cycle", "no_progress_budget"].includes(String(value.loopKind))
        && ["tool_start", "tool_update", "tool_end"].includes(String(value.observedEventType))
        && nonNegativeSafeInteger(value.observedEventSeq)
        && positiveSafeInteger(value.repeatedCount)
        && nonNegativeSafeInteger(value.noProgressActionCount)
        && (value.cycleLength === undefined || positiveSafeInteger(value.cycleLength))
        && typeof value.fingerprint === "string"
        && /^[a-f0-9]{64}$/u.test(value.fingerprint)
        && typeof value.message === "string"
        && value.message.length > 0
        && value.retryable === false;
    case "run_error":
      return typeof value.message === "string"
        && (value.errorDiagnostic === undefined || isRunProviderErrorDiagnostic(value.errorDiagnostic));
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
        && (value.errorDiagnostic === undefined || isRunProviderErrorDiagnostic(value.errorDiagnostic))
        && (value.contentKinds === undefined
          || (Array.isArray(value.contentKinds) && value.contentKinds.every((item) => typeof item === "string")))
        && (value.usage === undefined || isRunTokenUsage(value.usage));
    case "progress":
      return optionalString(value.message);
    default:
      return true;
  }
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

function optionalNonNegativeSafeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeSafeInteger(value);
}

function isCompactionReason(value: unknown): boolean {
  return value === "manual" || value === "threshold" || value === "overflow";
}

function isRunTokenUsage(value: unknown): boolean {
  return isRecord(value)
    && nonNegativeSafeInteger(value.input)
    && nonNegativeSafeInteger(value.output)
    && nonNegativeSafeInteger(value.cacheRead)
    && nonNegativeSafeInteger(value.cacheWrite)
    && nonNegativeSafeInteger(value.totalTokens);
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
