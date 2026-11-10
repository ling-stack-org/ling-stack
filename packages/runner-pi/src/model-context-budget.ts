import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { projectCompactionTaskView } from "./compaction-task-anchor.js";

/**
 * Model-facing output limits. These are deliberately separate from Host evidence:
 * the SDK context hook receives a clone, while RunEvent/tool_end keeps the complete
 * result and its artifact references.
 */
export const MODEL_TOOL_RESULT_BYTES = 24 * 1024;
export const MODEL_TOOL_CONTEXT_BYTES = 96 * 1024;
const MIN_TRUNCATION_MARKER = "[truncated]";
const MIN_TRUNCATION_MARKER_BYTES = Buffer.byteLength(MIN_TRUNCATION_MARKER, "utf8");

export interface ModelContextBudgetResult {
  readonly messages: readonly unknown[];
  readonly originalBytes: number;
  readonly modelBytes: number;
  readonly truncatedResults: number;
  /** Bytes still available after the model-facing projection. */
  readonly remainingBytes: number;
}

/**
 * Bound only the cloned model projection. It never mutates the canonical message
 * array and never rewrites status/details, so atomic Host evidence remains intact.
 * Newest tool results receive the budget first; older results are replaced by an
 * explicit marker instead of being silently omitted.
 */
export function boundModelToolResults(messages: readonly unknown[], options: {
  readonly perResultBytes?: number;
  readonly totalBytes?: number;
} = {}): ModelContextBudgetResult {
  const perResultBytes = options.perResultBytes ?? MODEL_TOOL_RESULT_BYTES;
  const totalBytes = options.totalBytes ?? MODEL_TOOL_CONTEXT_BYTES;
  if (!Number.isSafeInteger(perResultBytes) || perResultBytes < 0 ||
    !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error("Invalid model tool result budget");
  }
  let minimumResultBytes = messages.reduce<number>((sum, message) =>
    sum + (isRecord(message) && message.role === "toolResult" && Array.isArray(message.content)
      ? Math.min(measureContent(message.content), MIN_TRUNCATION_MARKER_BYTES) : 0), 0);
  if (minimumResultBytes > totalBytes) {
    throw new Error("Model tool result markers exceed cumulative budget");
  }
  let remaining = totalBytes;
  let originalBytes = 0;
  let modelBytes = 0;
  let truncatedResults = 0;
  const output = [...messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "toolResult" || !Array.isArray(message.content)) continue;
    const original = message.content as readonly unknown[];
    const measured = measureContent(original);
    originalBytes += measured;
    minimumResultBytes -= Math.min(measured, MIN_TRUNCATION_MARKER_BYTES);
    const allowance = Math.min(perResultBytes, Math.max(0, remaining - minimumResultBytes));
    const bounded = boundContent(original, allowance);
    if (bounded.truncated) truncatedResults += 1;
    const next = { ...message, content: bounded.content };
    const emittedBytes = measureContent(bounded.content);
    modelBytes += emittedBytes;
    remaining = Math.max(0, remaining - emittedBytes);
    output[index] = next;
  }
  return { messages: output, originalBytes, modelBytes, truncatedResults, remainingBytes: remaining };
}

export function createLingStackModelContextBudgetExtension(options: {
  readonly perResultBytes?: number;
  readonly totalBytes?: number;
  readonly acceptedTaskPrompt?: string;
} = {}): ExtensionFactory {
  return (pi) => {
    // Pi 1.1 exposes conversation-only context officially and restores its
    // system/tool transcript after this immutable Host evidence projection.
    pi.on("context", (event) => ({
      messages: boundModelToolResults(options.acceptedTaskPrompt === undefined ? event.messages
        : projectCompactionTaskView(event.messages, options.acceptedTaskPrompt), options).messages as typeof event.messages,
    }));
  };
}

function boundContent(content: readonly unknown[], allowance: number): { readonly content: readonly unknown[]; readonly truncated: boolean } {
  if (content.length === 0) return { content: [], truncated: false };
  if (measureContent(content) <= allowance && content.every(item =>
    !isRecord(item) || item.type !== "image" || measureContentItem(item) <= MODEL_TOOL_RESULT_BYTES)) {
    return { content, truncated: false };
  }
  if (allowance < MIN_TRUNCATION_MARKER_BYTES) {
    throw new Error("Model tool result marker exceeds per-result budget");
  }
  const result: unknown[] = [];
  let remaining = allowance;
  let truncated = false;
  for (const [index, item] of content.entries()) {
    const itemBytes = measureContentItem(item);
    const fitsWithContinuation = itemBytes <= remaining -
      (index < content.length - 1 ? MIN_TRUNCATION_MARKER_BYTES : 0);
    if (!isRecord(item)) {
      if (fitsWithContinuation) {
        result.push(item);
        remaining -= itemBytes;
      } else {
        appendMarker(result, itemBytes, remaining);
        truncated = true;
        remaining = 0;
        break;
      }
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      const text = item.text;
      const bytes = Buffer.byteLength(text, "utf8");
      if (fitsWithContinuation) {
        result.push(item);
        remaining -= bytes;
      } else {
        const notice = markerForBudget(bytes, remaining).text;
        const markerBytes = Buffer.byteLength(notice, "utf8");
        if (remaining >= markerBytes) {
          const clipped = takeUtf8Prefix(text, remaining - markerBytes);
          result.push({ ...item, text: `${clipped}${notice}` });
        } else {
          appendMarker(result, bytes, remaining);
        }
        truncated = true;
        remaining = 0;
        break;
      }
    } else if (item.type === "image") {
      const bytes = typeof item.data === "string" ? Buffer.byteLength(item.data, "utf8") : 0;
      if (fitsWithContinuation && bytes <= MODEL_TOOL_RESULT_BYTES) {
        result.push(item);
        remaining -= bytes;
      } else {
        appendMarker(result, bytes, remaining);
        truncated = true;
        remaining = 0;
        break;
      }
    } else if (fitsWithContinuation) {
      result.push(item);
      remaining -= itemBytes;
    } else {
      appendMarker(result, itemBytes, remaining);
      truncated = true;
      remaining = 0;
      break;
    }
  }
  if (result.length === 0 && content.length > 0 && allowance > 0) appendMarker(result, 0, allowance);
  return { content: result, truncated };
}

function appendMarker(target: unknown[], originalBytes: number, availableBytes: number): void {
  target.push(markerForBudget(originalBytes, availableBytes));
}

function marker(originalBytes: number): { readonly type: "text"; readonly text: string } {
  return { type: "text", text: `[Ling Stack model view truncated; full Host evidence retained (${originalBytes} bytes).]` };
}

function markerForBudget(originalBytes: number, availableBytes: number): { readonly type: "text"; readonly text: string } {
  const full = marker(originalBytes);
  if (Buffer.byteLength(full.text, "utf8") <= availableBytes) return full;
  if (availableBytes < MIN_TRUNCATION_MARKER_BYTES) {
    throw new Error("Model tool result marker exceeds available budget");
  }
  return { type: "text", text: MIN_TRUNCATION_MARKER };
}

function measureContent(content: readonly unknown[]): number {
  return content.reduce<number>((sum, item) => sum + measureContentItem(item), 0);
}

function measureContentItem(item: unknown): number {
  if (isRecord(item)) {
    if (item.type === "text" && typeof item.text === "string") return Buffer.byteLength(item.text, "utf8");
    if (item.type === "image" && typeof item.data === "string") return Buffer.byteLength(item.data, "utf8");
  }
  try {
    return Buffer.byteLength(JSON.stringify(item), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, bytes.length);
  // Never turn a byte budget boundary into U+FFFD. The prefix remains valid
  // UTF-8, so the model cannot receive a synthetic replacement character that
  // was not present in Host evidence.
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
