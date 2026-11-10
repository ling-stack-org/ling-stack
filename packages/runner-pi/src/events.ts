import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiRunnerEvent, PiRunnerTokenUsage } from "./types.js";
import { extractSafeReasoningSummary } from "./reasoning-summary.js";
import { classifyProviderError } from "./provider-error-diagnostic.js";

export function translatePiEvents(event: AgentSessionEvent): readonly PiRunnerEvent[] {
  if (event.type === "message_end") {
    const terminal = messageEndEvent(event.message);
    const summary = extractSafeReasoningSummary(event.message);
    return summary ? [{ type: "assistant_reasoning_summary", ...summary }, terminal] : [terminal];
  }
  const translated = translatePiEvent(event);
  return translated ? [translated] : [];
}

export function translatePiEvent(event: AgentSessionEvent): PiRunnerEvent | undefined {
  switch (event.type) {
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "auto_retry_start":
    case "summarization_retry_scheduled": {
      const retryAttempt = readTokenCount(event.attempt);
      const maxRetryAttempts = readTokenCount(event.maxAttempts);
      const delayMs = readTokenCount(event.delayMs);
      if (!retryAttempt || !maxRetryAttempts || retryAttempt > maxRetryAttempts || delayMs === undefined) return undefined;
      return { type: "provider_retry", policyVersion: "pi_sdk_retry_v1",
        scope: event.type === "auto_retry_start" ? "assistant" : "summarization", phase: "scheduled",
        retryAttempt, maxRetryAttempts, delayMs, errorDiagnostic: classifyProviderError({ errorMessage: event.errorMessage }) };
    }
    case "auto_retry_end": {
      const retryAttempt = readTokenCount(event.attempt);
      if (!retryAttempt || typeof event.success !== "boolean") return undefined;
      if (event.success) return { type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "assistant",
        phase: "settled", retryAttempt, outcome: "succeeded" };
      const errorDiagnostic = classifyProviderError({ errorMessage: event.finalError });
      return { type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "settled",
        retryAttempt, outcome: event.finalError === "Retry cancelled" ? "cancelled" : "failed", errorDiagnostic };
    }
    case "summarization_retry_attempt_start":
      if (event.source === "branchSummary") return { type: "provider_retry", policyVersion: "pi_sdk_retry_v1",
        scope: "summarization", phase: "attempt_start", source: "branch_summary" };
      if (event.source === "compaction" && ["manual", "threshold", "overflow"].includes(event.reason)) {
        return { type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "summarization",
          phase: "attempt_start", source: "compaction", reason: event.reason };
      }
      return undefined;
    case "summarization_retry_finished":
      // Pi does not provide an outcome here; the compaction_end is the authority.
      return { type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "summarization", phase: "settled" };
    case "compaction_start":
      return { type: "context_compaction_start", reason: event.reason, policyVersion: "pi_sdk_lifecycle_v1" };
    case "compaction_end": {
      const tokensBefore = readTokenCount(event.result?.tokensBefore);
      const estimatedTokensAfter = readTokenCount(event.result?.estimatedTokensAfter);
      const usage = readTokenUsage(event.result?.usage);
      return {
        type: "context_compaction_end",
        reason: event.reason,
        policyVersion: "pi_sdk_lifecycle_v1",
        outcome: event.aborted ? "aborted" : event.result ? "sdk_installed" : "failed",
        willRetry: event.willRetry,
        ...(tokensBefore === undefined ? {} : { tokensBefore }),
        ...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }),
        ...(usage ? { usage } : {}),
      };
    }
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        return { type: "assistant_text_delta", text: event.assistantMessageEvent.delta };
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        return { type: "assistant_thinking_delta", text: event.assistantMessageEvent.delta };
      }
      return undefined;
    case "message_end":
      return messageEndEvent(event.message);
    case "tool_execution_start":
      return {
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    default:
      return undefined;
  }
}

function messageEndEvent(message: unknown): Extract<PiRunnerEvent, { readonly type: "message_end" }> {
  const role = getMessageRole(message);
  const text = role === "assistant" ? getMessageText(message) : undefined;
  const stopReason = role === "assistant" ? getStopReason(message) : undefined;
  const errorMessage = role === "assistant" ? getSafeErrorMessage(message) : undefined;
  const errorDiagnostic = role === "assistant" && (errorMessage || stopReason === "error" || stopReason === "aborted")
    ? classifyProviderError(message) : undefined;
  const contentKinds = role === "assistant" ? getContentKinds(message) : [];
  const usage = role === "assistant" && isRecord(message) ? readTokenUsage(message.usage) : undefined;
  return {
    type: "message_end",
    role,
    ...(text ? { text } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(errorDiagnostic ? { errorDiagnostic } : {}),
    ...(contentKinds.length > 0 ? { contentKinds } : {}),
    ...(usage ? { usage } : {}),
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readTokenUsage(value: unknown): PiRunnerTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = readTokenCount(value.input);
  const output = readTokenCount(value.output);
  const cacheRead = readTokenCount(value.cacheRead);
  const cacheWrite = readTokenCount(value.cacheWrite);
  const totalTokens = readTokenCount(value.totalTokens);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || totalTokens === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function getMessageText(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? content : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter((item): item is Record<string, unknown> => isRecord(item) && (item.type === "text" || item.type === "output_text"))
    .map((item) => typeof item.text === "string" ? item.text : "")
    .join("");
  return text.trim() ? text : undefined;
}

function getStopReason(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const value = message.stopReason ?? message.stop_reason ?? message.finishReason ?? message.finish_reason;
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim();
  return /^[a-z0-9_.:-]{1,64}$/i.test(normalized) ? normalized : "other";
}

function getSafeErrorMessage(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  if (typeof message.errorMessage === "string" || typeof message.error_message === "string" || isRecord(message.error)) {
    return "Provider message ended with an error.";
  }
  return undefined;
}

function getContentKinds(message: unknown): readonly string[] {
  if (!isRecord(message)) {
    return [];
  }
  if (typeof message.content === "string") {
    return message.content.trim() ? ["text"] : [];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }
  const kinds = message.content.map((item) => {
    if (!isRecord(item) || typeof item.type !== "string") {
      return "other";
    }
    return ["text", "output_text", "thinking", "reasoning", "tool_call", "tool_use", "image", "audio"].includes(item.type)
      ? item.type
      : "other";
  });
  return [...new Set(kinds)];
}

function getMessageRole(message: unknown): string {
  if (typeof message === "object" && message !== null && "role" in message) {
    const role = (message as { role?: unknown }).role;
    if (typeof role === "string") {
      return role;
    }
  }
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
