import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiRunnerCompactionRecovery, PiRunnerCompactionRecoveryMode } from "./types.js";
import { isRecord } from "./utils.js";
import { assertAcceptedTaskAnchor } from "./compaction-task-anchor.js";

const MAX_MODEL_VIEW_BYTES = 512 * 1024;

/** Install Host-verified Pi messages without replaying the original prompt. */
export function installCompactionRecoveryView(
  session: AgentSession,
  recovery: PiRunnerCompactionRecovery,
  acceptedTaskPrompt: string,
): PiRunnerCompactionRecoveryMode {
  const modelView = readCompactionRecoveryView(recovery);
  // A missing anchor is an incomplete seal, not permission to synthesize an
  // unsealed recovery prefix and execute effects before the Host can commit it.
  assertAcceptedTaskAnchor(modelView, acceptedTaskPrompt);
  if (!session.isIdle || session.messages.length !== 0) {
    throw new Error("Pi compaction recovery requires an idle empty session");
  }
  session.state.messages = structuredClone(modelView) as never;
  return recoveryMode(modelView)!;
}

/** Revalidate the sealed view at the Runner boundary before SDK state mutation. */
export function readCompactionRecoveryView(value: unknown): readonly unknown[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.modelView)
    || value.modelView.length === 0 || !isValidModelView(value.modelView)) {
    throw new Error("Invalid Pi compaction recovery model view");
  }
  return structuredClone(value.modelView);
}

function isValidModelView(value: readonly unknown[]): boolean {
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_MODEL_VIEW_BYTES) return false;
  } catch {
    return false;
  }
  const first = value[0];
  if (!isRecord(first) || first.role !== "compactionSummary" || typeof first.summary !== "string" || !first.summary.trim()) {
    return false;
  }
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of value) {
    if (!isRecord(message)) return false;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "toolCall") {
          if (typeof block.id !== "string" || calls.has(block.id)) return false;
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
  if (![...calls].every((id) => results.has(id))) return false;
  return recoveryMode(value) !== undefined;
}

function recoveryMode(value: readonly unknown[]): PiRunnerCompactionRecoveryMode | undefined {
  const last = value.at(-1);
  if (!isRecord(last)) return undefined;
  if (last.role === "toolResult") return "continue";
  if (last.role !== "assistant") return undefined;
  if (Array.isArray(last.content) && last.content.some((block) => isRecord(block) && block.type === "toolCall")) {
    return undefined;
  }
  return "complete";
}
