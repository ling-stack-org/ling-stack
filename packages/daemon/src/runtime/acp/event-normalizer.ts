import { posix, win32 } from "node:path";
import type { Diff, PromptResponse } from "@agentclientprotocol/sdk";
import type { NativeRunOutput } from "@ling-stack/core";
import { NativeOutputError, NativeSecretRegistry, NativeStreamRedactor, redactNativeOutput, type NativeOutputSecrets } from "../adapters/native-stream-redaction.js";
import { nativeAcpContent } from "./content.js";
import type { AcpSessionUpdate } from "./live-client.js";
import { record, text } from "./live-errors.js";
import { mergeAcpToolObservation } from "./tool-observation.js";

export interface AcpEventNormalizerOptions {
  readonly requireAssistantText: boolean;
  readonly extraSecrets?: readonly string[];
  readonly maxBytes?: number;
  readonly maxItems?: number;
}
interface ToolState { readonly value: Record<string, unknown>; readonly closed: boolean }

/** ACP display observations never establish executable meaning or permission. */
export class AcpEventNormalizer {
  readonly #assistant: NativeStreamRedactor;
  readonly #thought: NativeStreamRedactor;
  readonly #tools = new Map<string, ToolState>();
  readonly #contentKinds = new Set<string>();
  readonly #options: AcpEventNormalizerOptions;
  readonly #secrets: NativeOutputSecrets;
  readonly #limit: number;
  readonly #items: number;
  #text = "";
  #bytes = 0;
  #contentItems = 0;
  #ended = false;

  constructor(readonly sessionId: string, options: AcpEventNormalizerOptions, secretRegistry?: NativeSecretRegistry) {
    this.#options = structuredClone(options);
    this.#limit = options.maxBytes ?? 8 * 1024 * 1024;
    this.#items = options.maxItems ?? 1024;
    if (!text(sessionId) || typeof options.requireAssistantText !== "boolean") invalid();
    if (![this.#limit, this.#items].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2 ** 30)) capacity();
    if (secretRegistry !== undefined && !(secretRegistry instanceof NativeSecretRegistry)) invalid();
    secretRegistry?.register((this.#options.extraSecrets ?? []).filter(secret => secret !== ""));
    this.#secrets = secretRegistry ?? this.#options.extraSecrets ?? [];
    this.#assistant = new NativeStreamRedactor(this.#secrets, this.#limit);
    this.#thought = new NativeStreamRedactor(this.#secrets, this.#limit);
  }

  receive(event: AcpSessionUpdate): NativeRunOutput[] {
    if (this.#ended || event.sessionId !== this.sessionId || !record(event.update)) invalid();
    this.#bytes += Buffer.byteLength(JSON.stringify(event.update));
    if (this.#bytes > this.#limit) capacity();
    const update = event.update;
    let events: NativeRunOutput[];
    switch (update.sessionUpdate) {
      case "agent_message_chunk": case "agent_thought_chunk": {
        const assistant = update.sessionUpdate === "agent_message_chunk";
        const content = nativeAcpContent(update.content);
        if (content.type !== "text") {
          if (!assistant) unsupported();
          if (this.#tools.size + this.#contentItems >= this.#items) capacity();
          this.#contentKinds.add(content.type);
          events = [{ type: "progress", data: { nativeKind: "assistant_content", role: "assistant",
            itemId: `assistant-content-${++this.#contentItems}`, content: [content] } }];
          break;
        }
        if (assistant && content.text) this.#contentKinds.add("text");
        const chunk = (assistant ? this.#assistant : this.#thought).push(content.text);
        if (assistant) this.#text += chunk;
        events = chunk ? [{ type: assistant ? "assistant_text_delta" : "assistant_thinking_delta", data: { text: chunk } }] : [];
        break;
      }
      case "tool_call": case "tool_call_update": events = this.#tool(update); break;
      case "plan":
        if (!Array.isArray(update.entries) || update.entries.length > 256 || update.entries.some(entry => !record(entry)
          || typeof entry.content !== "string" || !["pending", "in_progress", "completed"].some(status => status === entry.status)
          || !["high", "medium", "low"].some(priority => priority === entry.priority))) invalid();
        events = [{ type: "progress", data: { nativeKind: "plan", plan: update.entries.map(entry => ({
          content: entry.content, status: entry.status, priority: entry.priority })) } }];
        break;
      case "user_message_chunk":
        // Prompt echo is not a second assistant response.
        events = []; break;
      default: return unsupported();
    }
    return redactNativeOutput(events, this.#secrets);
  }

  finish(result: PromptResponse): NativeRunOutput[] {
    if (this.#ended) invalid();
    this.#ended = true;
    const events: NativeRunOutput[] = [];
    for (const [toolCallId, tool] of this.#tools) if (!tool.closed) {
      if (result.stopReason === "end_turn") invalid();
      events.push({ type: "tool_end", data: { toolCallId, toolName: "native_tool", isError: true,
        result: { status: result.stopReason, content: [] } } });
    }
    const thought = this.#thought.finish();
    if (thought) events.push({ type: "assistant_thinking_delta", data: { text: thought } });
    const tail = this.#assistant.finish();
    if (tail) { this.#text += tail; events.push({ type: "assistant_text_delta", data: { text: tail } }); }
    if (result.stopReason === "end_turn" && this.#options.requireAssistantText && !this.#text.trim()) throw new NativeOutputError("empty_output");
    events.push({ type: "message_end", data: { role: "assistant", text: this.#text, stopReason: result.stopReason,
      contentKinds: [...this.#contentKinds] } }, { type: "turn_end", data: {} });
    return redactNativeOutput(events, this.#secrets);
  }

  #tool(update: Readonly<Record<string, unknown>>): NativeRunOutput[] {
    if (!text(update.toolCallId)) invalid();
    const previous = this.#tools.get(update.toolCallId);
    if (previous?.closed || (update.sessionUpdate === "tool_call") === Boolean(previous)) invalid();
    if (!previous && this.#tools.size + this.#contentItems >= this.#items) capacity();
    const value = structuredClone(mergeAcpToolObservation(previous?.value, update));
    if (typeof value.status !== "string" || !["pending", "in_progress", "completed", "failed"].includes(value.status)) invalid();
    const closed = value.status === "completed" || value.status === "failed";
    const content = toolContent(value.content);
    this.#tools.set(update.toolCallId, { value, closed });
    const events: NativeRunOutput[] = [];
    if (!previous) events.push({ type: "tool_start", data: { toolCallId: update.toolCallId, toolName: "native_tool",
      args: { title: typeof value.title === "string" ? value.title : undefined, kind: value.kind,
        ...(value.rawInput !== undefined ? { input: value.rawInput } : {}) } } });
    const result = { status: value.status, content,
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.kind === "string" ? { kind: value.kind } : {}) };
    if (closed) events.push({ type: "tool_end", data: { toolCallId: update.toolCallId, toolName: "native_tool", result, isError: value.status === "failed" } });
    else if (previous || content.length) events.push({ type: "tool_update", data: { toolCallId: update.toolCallId, toolName: "native_tool", partialResult: result } });
    return events;
  }
}

function toolContent(value: unknown): Array<ReturnType<typeof nativeAcpContent> | (Diff & { type: "diff" })> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 256) invalid();
  return value.map(part => {
    if (!record(part)) return invalid();
    if (part.type === "content") return nativeAcpContent(part.content);
    if (part.type !== "diff") return unsupported();
    if (!text(part.path) || /[\x00-\x1f\x7f]/.test(part.path)
      || !(posix.isAbsolute(part.path) || win32.isAbsolute(part.path))
      || typeof part.newText !== "string" || (part.oldText != null && typeof part.oldText !== "string")) invalid();
    // A display diff is not an applied patch or authority to read the referenced file.
    return { type: "diff", path: part.path, oldText: part.oldText ?? null, newText: part.newText };
  });
}
function invalid(): never { throw new NativeOutputError("invalid_event"); }
function capacity(): never { throw new NativeOutputError("capacity_exceeded"); }
function unsupported(): never { throw new NativeOutputError("unsupported_item"); }
