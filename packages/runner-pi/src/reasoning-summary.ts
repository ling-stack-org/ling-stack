import type { PiRunnerReasoningSummaryMode } from "./types.js";

const MAX_REASONING_SUMMARY_CHARS = 24_000;
const MAX_REASONING_SUMMARY_PARTS = 32;
const RESPONSES_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

export interface SafeReasoningSummary {
  readonly text: string;
  readonly parts: readonly string[];
  readonly semantic: "safe_summary";
  readonly source: "openai_responses";
  readonly truncated: boolean;
}

/**
 * Extract only provider-designated public summary text from a completed
 * Responses reasoning item. The visible thinking text and reasoning content
 * remain private even when the SDK placed either value in the same block.
 */
export function extractSafeReasoningSummary(message: unknown): SafeReasoningSummary | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !isResponsesApi(message.api) || !Array.isArray(message.content)) {
    return undefined;
  }
  const candidates: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "thinking" || typeof block.thinkingSignature !== "string") continue;
    const parts = parseSummaryParts(block.thinkingSignature);
    if (!parts) continue;
    candidates.push(...parts);
  }
  if (candidates.length === 0) return undefined;

  const bounded: string[] = [];
  let used = 0;
  let truncated = candidates.length > MAX_REASONING_SUMMARY_PARTS;
  for (const part of candidates.slice(0, MAX_REASONING_SUMMARY_PARTS)) {
    const separatorLength = bounded.length > 0 ? 2 : 0;
    const remaining = MAX_REASONING_SUMMARY_CHARS - used - separatorLength;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (part.length > remaining) {
      bounded.push(`${part.slice(0, remaining)}…`);
      truncated = true;
      break;
    }
    bounded.push(part);
    used += separatorLength + part.length;
  }
  if (bounded.length === 0) return undefined;
  return {
    text: bounded.join("\n\n"),
    parts: bounded,
    semantic: "safe_summary",
    source: "openai_responses",
    truncated,
  };
}

/** Return a cloned Responses payload when a policy change is required. */
export function applyReasoningSummaryModeToPayload(
  payload: unknown,
  api: unknown,
  mode: PiRunnerReasoningSummaryMode | undefined,
): unknown | undefined {
  if (!mode || !isResponsesApi(api) || !isRecord(payload) || !isRecord(payload.reasoning)) return undefined;
  const reasoning = payload.reasoning;
  if (mode === "none") {
    if (!Object.prototype.hasOwnProperty.call(reasoning, "summary")) return undefined;
    const { summary: _summary, ...rest } = reasoning;
    return { ...payload, reasoning: rest };
  }
  return { ...payload, reasoning: { ...reasoning, summary: mode } };
}

function parseSummaryParts(signature: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(signature);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== "reasoning" || !Array.isArray(parsed.summary) || parsed.summary.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of parsed.summary) {
    if (!isRecord(item) || item.type !== "summary_text" || typeof item.text !== "string") return undefined;
    const text = item.text.trim();
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts : undefined;
}

function isResponsesApi(value: unknown): boolean {
  return typeof value === "string" && RESPONSES_APIS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
