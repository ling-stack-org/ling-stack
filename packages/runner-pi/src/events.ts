import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiRunnerEvent } from "./types.js";

export function translatePiEvent(event: AgentSessionEvent): PiRunnerEvent | undefined {
  switch (event.type) {
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
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
        isError: event.isError || isHandledUnifiedExecError(event.result),
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
  const contentKinds = role === "assistant" ? getContentKinds(message) : [];
  return {
    type: "message_end",
    role,
    ...(text ? { text } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(contentKinds.length > 0 ? { contentKinds } : {}),
  };
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

function isHandledUnifiedExecError(result: unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }
  if (result.isError === true) {
    return true;
  }
  const details = result.details;
  if (!isRecord(details)) {
    return false;
  }
  const unifiedExec = details.unifiedExec;
  if (!isRecord(unifiedExec)) {
    return false;
  }
  const status = unifiedExec.status;
  return status === "failed" || status === "timed_out" || status === "cancelled";
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
