import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { NativeRunOutput } from "@ling-stack/core";
import type { CodexNotification } from "./duplex.js";
import { NativeOutputError, NativeStreamRedactor, redactNativeOutput } from "../native-stream-redaction.js";
import { codexOutputTools, codexToolOutput, content, type CodexToolOutput } from "./tool-output.js";
import { codexToolArgsMatch } from "./observed-tools.js";
import { codexFunctionContent } from "./tool-content.js";

export interface CodexEventNormalizerOptions {
  readonly threadId: string;
  readonly turnId: string;
  readonly requireAssistantText: boolean;
  readonly extraSecrets?: readonly string[];
  readonly maxItems?: number;
  readonly maxBytes?: number;
}
interface ItemState {
  readonly type: string;
  readonly id: string;
  readonly stream: NativeStreamRedactor;
  raw: string;
  output: string;
  closed: boolean;
  summaryParts?: string[];
  finalHash?: string;
  observationHash?: string;
  start?: CodexToolOutput;
}

/** One accepted native turn. Observations only; no tool execution or permission decisions. */
export class CodexEventNormalizer {
  readonly #options: CodexEventNormalizerOptions;
  readonly #items = new Map<string, ItemState>();
  readonly #secrets: readonly string[];
  readonly #maxItems: number;
  readonly #maxBytes: number;
  readonly #assistantStream: NativeStreamRedactor;
  #bytes = 0;
  #ended = false;
  #started = false;
  #assistantText = "";

  constructor(options: CodexEventNormalizerOptions) {
    this.#options = { threadId: options.threadId, turnId: options.turnId, requireAssistantText: options.requireAssistantText };
    this.#secrets = [...(options.extraSecrets ?? [])];
    this.#maxItems = options.maxItems ?? 1024;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.#assistantStream = new NativeStreamRedactor(this.#secrets, this.#maxBytes);
    if (!id(options.threadId) || !id(options.turnId) || typeof options.requireAssistantText !== "boolean") invalid();
    if (![this.#maxItems, this.#maxBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2 ** 30)) capacity();
  }

  receive(message: CodexNotification): NativeRunOutput[] {
    if (this.#ended) invalid();
    const params = message.params;
    if (!record(params) || params.threadId !== this.#options.threadId) invalid();
    const turn = message.method === "turn/started" || message.method === "turn/completed";
    if ((turn ? record(params.turn) ? params.turn.id : undefined : params.turnId) !== this.#options.turnId) invalid();
    const bytes = Buffer.byteLength(JSON.stringify(params), "utf8");
    if (this.#bytes + bytes > this.#maxBytes) capacity();
    this.#bytes += bytes;
    let events: NativeRunOutput[] = [];
    switch (message.method) {
      case "turn/started":
        if (!this.#started) { this.#started = true; events = [{ type: "turn_start", data: {} }]; }
        break;
      case "turn/completed":
        events = this.#complete(params.turn as Record<string, unknown>);
        break;
      case "item/started":
      case "item/completed":
        if (!record(params.item)) invalid();
        events = this.#item(params.item, message.method === "item/completed");
        break;
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta": {
        if (!id(params.itemId) || typeof params.delta !== "string") invalid();
        const type = message.method === "item/agentMessage/delta" ? "agentMessage" : message.method === "item/plan/delta" ? "plan" : "reasoning";
        const state = this.#state(params.itemId, type);
        if (state.closed) invalid();
        if (type === "reasoning") { events = this.#summary(state, params.summaryIndex, params.delta); break; }
        state.raw += params.delta;
        events = this.#text(state, this.#stream(state).push(params.delta));
        break;
      }
      case "item/reasoning/textDelta":
        // Summary is the selected visible reasoning channel; raw content is never exposed in parallel.
        if (!id(params.itemId) || typeof params.delta !== "string" || !Number.isSafeInteger(params.contentIndex) || Number(params.contentIndex) < 0) invalid();
        if (this.#state(params.itemId, "reasoning").closed) invalid();
        break;
      case "item/reasoning/summaryPartAdded":
        if (!id(params.itemId)) invalid();
        events = this.#summary(this.#state(params.itemId, "reasoning"), params.summaryIndex, "");
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        if (!id(params.itemId) || typeof params.delta !== "string") invalid();
        const state = this.#items.get(params.itemId);
        const expected = message.method === "item/commandExecution/outputDelta" ? "commandExecution" : "fileChange";
        if (!state || !state.start || state.closed || state.type !== expected) invalid();
        state.raw += params.delta;
        state.output += state.stream.push(params.delta);
        events = [{ type: "tool_update", data: { toolCallId: state.id, toolName: state.start.toolName,
          partialResult: { content: content(state.output) } } }];
        break;
      }
      case "item/commandExecution/terminalInteraction": {
        if (!id(params.itemId) || !id(params.processId) || typeof params.stdin !== "string") invalid();
        const state = this.#items.get(params.itemId);
        if (!state?.start || state.closed || state.type !== "commandExecution") invalid();
        events = [{ type: "tool_update", data: { toolCallId: state.id, toolName: state.start.toolName,
          partialResult: { processId: params.processId, stdin: params.stdin } } }];
        break;
      }
      case "item/mcpToolCall/progress": {
        if (!id(params.itemId) || typeof params.message !== "string") invalid();
        const state = this.#items.get(params.itemId);
        if (!state?.start || state.closed || state.type !== "mcpToolCall") invalid();
        events = [{ type: "tool_update", data: { toolCallId: state.id, toolName: state.start.toolName,
          partialResult: { content: content(params.message) } } }];
        break;
      }
      case "item/fileChange/patchUpdated":
        // Approval context owns these pre-execution previews; do not invent a running tool.
        break;
      case "error":
        if (typeof params.willRetry !== "boolean") invalid();
        events = [{ type: "progress", data: { nativeKind: "error", retrying: params.willRetry } }];
        break;
      case "turn/plan/updated":
      case "turn/diff/updated":
        events = [{ type: "progress", data: { nativeKind: message.method,
          ...(message.method === "turn/plan/updated" ? { plan: params.plan } : { diff: params.diff }) } }];
        break;
      case "model/rerouted": break; // Binding validation is owned by the live client.
      case "turn/moderationMetadata":
        // Codex 0.158.0 sends private JSON observations; they are not user output or activity.
        // Identity and cumulative byte bounds above still apply to every observation.
        if (!Object.hasOwn(params, "metadata") || params.metadata === undefined) invalid();
        break;
      default: throw new NativeOutputError("unsupported_item");
    }
    return redactNativeOutput(events, this.#secrets);
  }

  #state(itemId: string, type: string): ItemState {
    const previous = this.#items.get(itemId);
    if (previous) { if (previous.type !== type) invalid(); return previous; }
    if (this.#items.size >= this.#maxItems) capacity();
    const state: ItemState = { id: itemId, type, raw: "", output: "", closed: false,
      stream: new NativeStreamRedactor(this.#secrets, this.#maxBytes) };
    this.#items.set(itemId, state);
    return state;
  }

  #item(item: Record<string, unknown>, completed: boolean): NativeRunOutput[] {
    if (!id(item.id) || typeof item.type !== "string") invalid();
    const state = this.#state(item.id, item.type);
    const hash = createHash("sha256").update(JSON.stringify(item)).digest("hex");
    if (state.closed) { if (completed && state.finalHash === hash) return []; invalid(); }
    const events: NativeRunOutput[] = [];
    if (codexOutputTools.has(item.type)) {
      const observation = codexToolOutput(item, completed);
      if (state.start && (!codexToolArgsMatch(item.type, state.start.args, observation.args) || state.start.toolName !== observation.toolName)) invalid();
      if (!state.start) {
        events.push({ type: "tool_start", data: { toolCallId: state.id, toolName: observation.toolName, args: observation.args } });
      }
      state.start = structuredClone(observation);
      if (completed) {
        state.output += state.stream.finish();
        const result = { ...observation.result };
        if (!Array.isArray(result.content) || result.content.length === 0) result.content = content(state.output);
        events.push({ type: "tool_end", data: { toolCallId: state.id, toolName: observation.toolName, result, isError: observation.isError } });
      }
    } else if (["agentMessage", "reasoning", "plan"].includes(item.type)) {
      if (completed) {
        const final = item.type === "reasoning" ? stringArray(item.summary).join("\n") : typeof item.text === "string" ? item.text : invalid();
        if (state.raw && state.raw !== final) invalid();
        if (state.raw && state.summaryParts && !isDeepStrictEqual(state.summaryParts, item.summary)) invalid();
        if (!state.raw) { state.raw = final; events.push(...this.#text(state, this.#stream(state).push(final))); }
        if (state.type !== "agentMessage") events.push(...this.#text(state, state.stream.finish()));
      }
    } else if (item.type === "functionCallOutput") {
      if (!id(item.name) || !(item.namespace === null || id(item.namespace))) invalid();
      const output = codexFunctionContent(item.output);
      if (completed) events.push({ type: "progress", data: { nativeKind: "function_output", itemId: state.id,
        toolName: item.namespace ? `${item.namespace}.${item.name}` : item.name, ...output } });
    } else if (item.type === "subAgentActivity") {
      if (typeof item.kind !== "string" || !["started", "interacted", "interrupted", "completed"].includes(item.kind)
        || !id(item.agentThreadId) || typeof item.agentPath !== "string") invalid();
      if (state.observationHash !== hash) events.push({ type: "progress", data: { nativeKind: "subagent_activity", itemId: state.id,
        kind: item.kind, agentThreadId: item.agentThreadId, agentPath: item.agentPath } });
      state.observationHash = hash;
    } else if (!["userMessage", "hookPrompt", "contextCompaction", "enteredReviewMode", "exitedReviewMode"].includes(item.type)) {
      throw new NativeOutputError("unsupported_item");
    }
    if (completed) { state.closed = true; state.finalHash = hash; }
    return events;
  }

  #summary(state: ItemState, index: unknown, delta: string): NativeRunOutput[] {
    if (state.closed || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) invalid();
    const parts = state.summaryParts ??= [];
    if (index > parts.length || index < parts.length - 1) invalid();
    const separator = index === parts.length && index > 0 ? "\n" : "";
    if (index === parts.length) parts.push("");
    parts[index] += delta;
    state.raw += separator + delta;
    return this.#text(state, state.stream.push(separator + delta));
  }

  #text(state: ItemState, text: string): NativeRunOutput[] {
    state.output += text;
    if (!text) return [];
    if (state.type === "agentMessage") {
      this.#assistantText += text;
      return [{ type: "assistant_text_delta", data: { text } }];
    }
    if (state.type === "reasoning") return [{ type: "assistant_thinking_delta", data: { text } }];
    return [{ type: "progress", data: { nativeKind: "plan", itemId: state.id, text: state.output } }];
  }

  #stream(state: ItemState): NativeStreamRedactor { return state.type === "agentMessage" ? this.#assistantStream : state.stream; }

  #complete(turn: Record<string, unknown>): NativeRunOutput[] {
    if (!Array.isArray(turn.items) || typeof turn.status !== "string" || !["completed", "failed", "interrupted"].includes(turn.status)) invalid();
    const events: NativeRunOutput[] = [];
    for (const item of turn.items) { if (!record(item)) invalid(); events.push(...this.#item(item, true)); }
    for (const state of this.#items.values()) {
      if (state.closed) continue;
      if (state.start) {
        if (turn.status === "completed") invalid();
        state.output += state.stream.finish();
        events.push({ type: "tool_end", data: { toolCallId: state.id, toolName: state.start.toolName, isError: true,
          result: { status: turn.status, content: content(state.output) } } });
      } else if (state.type !== "agentMessage") events.push(...this.#text(state, state.stream.finish()));
      state.closed = true;
    }
    const tail = this.#assistantStream.finish();
    if (tail) { this.#assistantText += tail; events.push({ type: "assistant_text_delta", data: { text: tail } }); }
    this.#ended = true;
    if (turn.status === "completed" && this.#options.requireAssistantText && !this.#assistantText.trim()) throw new NativeOutputError("empty_output");
    events.push({ type: "message_end", data: { role: "assistant", text: this.#assistantText,
      stopReason: turn.status === "completed" ? "stop" : turn.status === "failed" ? "error" : "aborted",
      ...(turn.status === "failed" ? { errorMessage: "Native engine turn failed." } : {}),
      contentKinds: this.#assistantText ? ["text"] : [] } }, { type: "turn_end", data: {} });
    return events;
  }
}

function invalid(): never { throw new NativeOutputError("invalid_event"); }
function capacity(): never { throw new NativeOutputError("capacity_exceeded"); }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || !value.every(part => typeof part === "string")) invalid(); return value; }
