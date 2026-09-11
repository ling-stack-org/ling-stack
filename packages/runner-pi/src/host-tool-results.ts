import type { AgentToolResult, ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { normalizeHandledToolResult } from "./content.js";
import type { PiRunnerToolHandledResult } from "./types.js";

interface PendingHostResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly details: unknown;
  readonly isError: boolean;
}

/**
 * Bridge Host result status through the SDK's supported post-execution hook.
 * A resolved AgentToolResult does not carry SDK isError. Match the exact normalized
 * content object, call identity and details, never status-like fields in tool data.
 * Each extension installation owns a weak registry; aborted/unconsumed results do
 * not retain payloads, and separate sessions cannot share or overwrite call IDs.
 */
export function createHostToolResultAdapter(pi: Pick<ExtensionAPI, "on">) {
  const pending = new WeakMap<AgentToolResult<unknown>["content"], PendingHostResult>();
  pi.on("tool_result", (event: ToolResultEvent): { isError: boolean } | undefined => {
    const result = pending.get(event.content);
    if (!result) return undefined;
    pending.delete(event.content);
    // SDK exceptions/cancellation have priority. Do not replace their evidence.
    if (event.isError) return undefined;
    const matches = event.toolCallId === result.toolCallId
      && event.toolName === result.toolName && event.details === result.details;
    // A recognized result with conflicting identity must never be called success.
    return { isError: !matches || result.isError };
  });
  return (toolCallId: string, toolName: string, result: PiRunnerToolHandledResult): AgentToolResult<unknown> => {
    const normalized = normalizeHandledToolResult(result);
    pending.set(normalized.content, {
      toolCallId, toolName, details: normalized.details, isError: result.isError === true,
    });
    return normalized;
  };
}

export type HostToolResultAdapter = ReturnType<typeof createHostToolResultAdapter>;
