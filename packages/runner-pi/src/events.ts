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
      return { type: "message_end", role: getMessageRole(event.message) };
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
