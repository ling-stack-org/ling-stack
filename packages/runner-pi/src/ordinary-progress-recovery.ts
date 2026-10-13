import { convertToLlm, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { assertAcceptedTaskAnchor } from "./compaction-task-anchor.js";
import { boundModelToolResults } from "./model-context-budget.js";
import { appendPiSessionAuthority } from "./session-continuation.js";
import { piConversation, piTranscript } from "./session-transcript.js";
import type { PiRunnerOrdinaryProgressRecovery } from "./types.js";
import { isRecord } from "./utils.js";

const MAX_MODEL_VIEW_BYTES = 512 * 1024;
const MAX_JSON_NODES = 40_000;
const credentialField = /^(?:api[_-]?key|authorization|proxy[_-]?authorization|password|passwd|secret|credentials?|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|cookie|set[_-]?cookie)$/iu;
const credentialText = /(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

/** Private defense in depth; Host/Core additionally redact actual resolved secret values. */
export function readOrdinaryProgressRecoveryView(value: unknown): readonly unknown[] {
  try {
    const state = { nodes: 0, bytes: 0, ancestors: new Set<object>() };
    const captured = captureJson(value, state);
    if (!isRecord(captured) || Object.keys(captured).sort().join(",") !== "modelView,schemaVersion"
      || captured.schemaVersion !== 1 || !Array.isArray(captured.modelView)
      || Buffer.byteLength(JSON.stringify(captured.modelView), "utf8") > MAX_MODEL_VIEW_BYTES
      || !validConversation(captured.modelView)) throw new Error();
    return captured.modelView;
  } catch {
    throw new Error("Invalid Pi ordinary progress recovery model view");
  }
}

/** Install only ordinary messages into the existing idle SDK Session; never prompt or compact. */
export function installOrdinaryProgressRecoveryView(
  session: AgentSession,
  recovery: PiRunnerOrdinaryProgressRecovery,
  acceptedTaskPrompt: string,
): "continue" | "complete" {
  const view = readOrdinaryProgressRecoveryView(recovery);
  assertAcceptedTaskAnchor(view, acceptedTaskPrompt);
  if (!session.isIdle || session.messages.length !== 0) {
    throw new Error("Pi ordinary progress recovery requires an idle empty session");
  }
  // Same frozen authority initializer and public SessionManager path as compaction/approval recovery.
  appendPiSessionAuthority(session);
  for (const message of view) session.sessionManager.appendMessage(structuredClone(message) as never);
  session.refreshContext();
  return (view.at(-1) as { role: string }).role === "toolResult" ? "continue" : "complete";
}

/** Exact deterministic conversation projection, with no generated-summary metadata exemption. */
export function assertOrdinaryProgressRecoveryModelContext(
  recovery: PiRunnerOrdinaryProgressRecovery,
  context: Context,
): void {
  const view = readOrdinaryProgressRecoveryView(recovery);
  const expected = convertToLlm(boundModelToolResults(view).messages as Parameters<typeof convertToLlm>[0]);
  const actual = piConversation(piTranscript(context).messages);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Pi ordinary progress recovery changed before the first model request");
  }
}

function validConversation(view: readonly unknown[]): boolean {
  if (view.length < 2 || !isRecord(view[0]) || view[0].role !== "user") return false;
  const calls = new Map<string, string>();
  const pending = new Set<string>();
  for (const [index, message] of view.entries()) {
    if (!isRecord(message) || !Number.isFinite(message.timestamp) || typeof message.timestamp !== "number") return false;
    if (message.role === "user") {
      // Ordinary recovery preserves the original accepted task, not new user/steering authority.
      if (index !== 0 || !validContent(message.content, "user")) return false;
    } else if (message.role === "assistant") {
      if (pending.size || !validContent(message.content, "assistant")
        || message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage !== undefined) return false;
      const blocks = message.content as Record<string, unknown>[];
      const hasCalls = blocks.some(block => block.type === "toolCall");
      if (message.stopReason !== undefined && message.stopReason !== (hasCalls ? "toolUse" : "stop")) return false;
      for (const block of blocks) {
        if (block.type !== "toolCall") continue;
        if (typeof block.id !== "string" || !block.id.trim() || calls.has(block.id)
          || typeof block.name !== "string" || !block.name.trim() || !isRecord(block.arguments)) return false;
        calls.set(block.id, block.name);
        pending.add(block.id);
      }
    } else if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !pending.has(message.toolCallId)
        || calls.get(message.toolCallId) !== message.toolName || typeof message.isError !== "boolean"
        || !validContent(message.content, "toolResult")) return false;
      pending.delete(message.toolCallId);
    } else return false;
  }
  const last = view.at(-1) as Record<string, unknown>;
  // A missing/partial terminal reason is not authority to emit run_end without SDK settlement.
  return pending.size === 0 && (last.role === "toolResult" || (last.role === "assistant" && last.stopReason === "stop"));
}

function validContent(value: unknown, role: "user" | "assistant" | "toolResult"): boolean {
  if (role === "user" && typeof value === "string") return Boolean(value.trim());
  if (!Array.isArray(value) || (role !== "toolResult" && value.length === 0)) return false;
  return value.every(block => {
    if (!isRecord(block)) return false;
    if (block.type === "text") return typeof block.text === "string";
    if (block.type === "image") return role !== "assistant" && typeof block.data === "string" && typeof block.mimeType === "string";
    if (block.type === "thinking") return role === "assistant" && typeof block.thinking === "string";
    return block.type === "toolCall" && role === "assistant";
  });
}

/** Own descriptor capture rejects accessors/toJSON/prototypes without invoking their user code. */
function captureJson(value: unknown, state: { nodes: number; bytes: number; ancestors: Set<object> }, depth = 0): unknown {
  if (++state.nodes > MAX_JSON_NODES || depth > 64) throw new Error();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error(); return value; }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_MODEL_VIEW_BYTES || credentialText.test(value)) throw new Error();
    return value;
  }
  if (typeof value !== "object" || state.ancestors.has(value)) throw new Error();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) throw new Error();
  state.ancestors.add(value);
  try {
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || Object.keys(descriptors).length !== length + 1) throw new Error();
      return Array.from({ length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
        return captureJson(descriptor.value, state, depth + 1);
      });
    }
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable || key === "toJSON" || key === "__proto__"
        || credentialField.test(key)) throw new Error();
      state.bytes += Buffer.byteLength(key, "utf8");
      if (state.bytes > MAX_MODEL_VIEW_BYTES) throw new Error();
      Object.defineProperty(result, key, { value: captureJson(descriptor.value, state, depth + 1), enumerable: true });
    }
    return result;
  } finally { state.ancestors.delete(value); }
}
