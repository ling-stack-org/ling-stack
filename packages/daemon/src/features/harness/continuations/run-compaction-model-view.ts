const MAX_MODEL_VIEW_BYTES = 512 * 1024;

export type CompactionRecoveryMode = "complete" | "continue";

/** SDK-installed view, including a summary and complete kept tool pairs. */
export function isValidCompactedModelView(summary: unknown, value: unknown): value is readonly unknown[] {
  if (typeof summary !== "string" || !summary.trim() || !Array.isArray(value) || value.length === 0) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_MODEL_VIEW_BYTES) return false;
  } catch {
    return false;
  }
  const first = value[0];
  if (!isRecord(first) || first.role !== "compactionSummary" || first.summary !== summary) return false;
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of value) {
    if (!isRecord(message)) return false;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
          if (calls.has(block.id)) return false;
          calls.add(block.id);
        }
      }
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !calls.has(message.toolCallId) || results.has(message.toolCallId)) {
        return false;
      }
      results.add(message.toolCallId);
    }
  }
  return [...calls].every((id) => results.has(id)) && recoveryMode(value) !== undefined;
}

/**
 * Decide whether a sealed SDK view is a completed assistant turn or an
 * interrupted tool loop. A completed assistant turn must never be sent to
 * `agent.continue()`: Pi rejects that state and no provider call is needed.
 */
export function compactionRecoveryMode(value: readonly unknown[]): CompactionRecoveryMode | undefined {
  return recoveryMode(value);
}

function recoveryMode(value: readonly unknown[]): CompactionRecoveryMode | undefined {
  const last = value.at(-1);
  if (!isRecord(last)) return undefined;
  if (last.role === "toolResult") return "continue";
  // A final-looking text is not a settled successful provider response. In
  // particular, a cancelled/error/truncated response must never skip continue()
  // and become a successful Run merely because its role is assistant.
  if (last.role !== "assistant" || last.stopReason !== "stop" || !Array.isArray(last.content)) return undefined;
  if (last.content.some((block) => isRecord(block) && block.type === "toolCall")) {
    return undefined;
  }
  return "complete";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
