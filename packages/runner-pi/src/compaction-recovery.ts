import { convertToLlm, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { PiRunnerCompactionRecovery, PiRunnerCompactionRecoveryMode } from "./types.js";
import { isRecord } from "./utils.js";
import { assertAcceptedTaskAnchor } from "./compaction-task-anchor.js";
import { appendPiSessionAuthority } from "./session-continuation.js";
import { piConversation, piTranscript } from "./session-transcript.js";
import { boundModelToolResults } from "./model-context-budget.js";

/** Compare the actual first request with the sealed conversation, not just a nonempty history. */
export function assertCompactionRecoveryModelContext(recovery: PiRunnerCompactionRecovery, context: Context): void {
  const sealed = readCompactionRecoveryView(recovery);
  const expected = convertToLlm(boundModelToolResults(sealed).messages as Parameters<typeof convertToLlm>[0]);
  const actual = piConversation(piTranscript(context).messages);
  // appendCompaction creates its own timestamp. It is conversion metadata,
  // absent from wire requests; all sealed content and every retained tail entry
  // must remain byte-for-byte equal. Do not normalize any tail metadata.
  const comparison = (messages: typeof actual) => messages.map((message, index) => index === 0
    ? { ...message, timestamp: 0 } : message);
  if (JSON.stringify(comparison(actual)) !== JSON.stringify(comparison(expected))) {
    throw new Error("Pi compaction recovery changed before the first model request");
  }
}

const MAX_MODEL_VIEW_BYTES = 512 * 1024;

/**
 * Map only a restored compaction's SDK-generated metadata back to its Host seal.
 * The canonical journal and provider context keep the SDK's own metadata. Public
 * projection provenance binds this mapping to one source entry; a later genuine
 * compaction is never rewritten, even if its summary text happens to be identical.
 */
export function createCompactionRecoveryCheckpointProjector(
  session: Pick<AgentSession, "sessionManager">,
  recovery: PiRunnerCompactionRecovery,
): (messages: readonly unknown[]) => readonly unknown[] {
  const sealedSummary = readCompactionRecoveryView(recovery)[0];
  const current = () => session.sessionManager.buildSessionProjection().entries.find(entry =>
    entry.sourceEntry.type === "compaction" && entry.messages.some(message => message.role === "compactionSummary"));
  const restored = current();
  const sdkSummary = restored?.messages.find(message => message.role === "compactionSummary");
  if (!restored || sdkSummary?.role !== "compactionSummary" || !isRecord(sealedSummary)
    || sdkSummary.summary !== sealedSummary.summary) {
    throw new Error("Pi recovered checkpoint has no matching canonical compaction summary");
  }
  const sourceEntryId = restored.sourceEntry.id;
  const summaryProof = JSON.stringify(sdkSummary);
  return messages => {
    const active = current();
    if (!active) throw new Error("Pi recovered checkpoint lost its canonical compaction summary");
    if (active.sourceEntry.id !== sourceEntryId) return messages;
    const activeSummary = active.messages.find(message => message.role === "compactionSummary");
    if (JSON.stringify(activeSummary) !== summaryProof || JSON.stringify(messages[0]) !== summaryProof) {
      throw new Error("Pi recovered checkpoint changed its canonical compaction summary");
    }
    // No old tail is reinserted: genuine history drift remains visible to the
    // Host's byte-exact prefix check. Cloning prevents a consumer editing the seal.
    return [structuredClone(sealedSummary), ...messages.slice(1)];
  };
}

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
  appendPiSessionAuthority(session);
  const summary = modelView[0] as { summary: string; tokensBefore?: number };
  session.sessionManager.appendCompaction(summary.summary, null,
    Number.isSafeInteger(summary.tokensBefore) && summary.tokensBefore! >= 0 ? summary.tokensBefore! : 0);
  for (const message of modelView.slice(1)) session.sessionManager.appendMessage(structuredClone(message) as never);
  session.refreshContext();
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
    if (message !== first && !["user", "assistant", "toolResult"].includes(String(message.role))) return false;
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
  // Match the Host's completion boundary before mutating SDK state or sending
  // its prepared ACK. Assistant text alone is not provider settlement evidence.
  if (last.role !== "assistant" || last.stopReason !== "stop" || !Array.isArray(last.content)) return undefined;
  if (last.content.some((block) => isRecord(block) && block.type === "toolCall")) {
    return undefined;
  }
  return "complete";
}
