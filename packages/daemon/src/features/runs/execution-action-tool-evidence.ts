import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "@ling-stack/core";
import type { ExecutionActionToolEvidence, RunEventEnvelope } from "@ling-stack/core";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { isRecord } from "../../shared/validation.js";

const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
const DEDICATED_EVIDENCE_TOOLS = new Set(["bash", "write", "edit"]);
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_OUTPUT_LINES = 40;

/** Select only known input fields. A path target is evidence, not permission to open it. */
export function readOnlyToolInput(toolName: string, args: unknown, cwd: string): {
  readonly summary: string;
  readonly inputSummary: string;
  readonly path?: string;
} | undefined {
  if (!READ_TOOLS.has(toolName)) return undefined;
  const input = isRecord(args) ? args : {};
  const rawPath = typeof input.path === "string" && input.path.trim() && input.path !== "<unknown>"
    ? input.path : toolName === "read" ? undefined : cwd;
  const displayPath = rawPath ? safeDisplayText(rawPath) : undefined;
  // Never turn a truncated or redacted display string into a navigation target.
  const path = rawPath === displayPath && displayPath && Buffer.byteLength(displayPath, "utf8") <= 4096
    ? displayPath : undefined;
  const pattern = typeof input.pattern === "string" ? safeDisplayText(input.pattern) : undefined;
  const summary = boundText([pattern, displayPath].filter(Boolean).join(" · ") || toolName, 1024, 1).text;
  const range = ["offset", "limit"].flatMap((key) => Number.isSafeInteger(input[key]) && Number(input[key]) >= 0 ? [`${key}=${input[key]}`] : []);
  return { summary, inputSummary: boundText([summary, ...range].join(" · "), 1024, 1).text, ...(path ? { path } : {}) };
}

/** Project an already-selected lifecycle. The caller owns first-start/end fencing. */
export function deriveExecutionActionToolEvidence(input: {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly events: readonly RunEventEnvelope[];
  readonly start?: RunEventEnvelope;
  readonly end?: RunEventEnvelope;
}): ExecutionActionToolEvidence | undefined {
  const args = isRecord(input.start?.data) ? input.start.data.args : undefined;
  // Commands and file mutations have their own evidence contract. Other tools
  // share the text-only lifecycle fold without gaining file/navigation rights.
  if (DEDICATED_EVIDENCE_TOOLS.has(input.toolName)) return undefined;
  const inputSummary = readOnlyToolInput(input.toolName, args, input.cwd)?.inputSummary
    ?? genericToolInputSummary(args);
  const update = input.events
    .filter((event) => event.type === "tool_update" && isRecord(event.data) &&
      event.data.toolCallId === input.toolCallId &&
      (!input.start || event.seq > input.start.seq) && (!input.end || event.seq < input.end.seq))
    .sort((left, right) => right.seq - left.seq || left.id.localeCompare(right.id))[0];
  const source = input.end ?? update;
  const data = isRecord(source?.data) ? source.data : {};
  const result = input.end ? data.result : data.partialResult;
  const output = readTextContent(result);
  // Strip terminal controls before redaction: ANSI suffixes can otherwise hide
  // the word boundary preceding a credential from the shared text redactor.
  const bounded = output === undefined ? undefined : boundText(safeDisplayText(output), MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES);
  return {
    toolName: input.toolName,
    inputSummary,
    ...(bounded?.text ? { outputText: bounded.text } : {}),
    outputTruncated: bounded?.truncated ?? false,
    latestEventSeq: source?.seq ?? input.start?.seq ?? 0,
  };
}

/** Display real JSON arguments, never a title/summary fallback or a navigation target. */
function genericToolInputSummary(args: unknown): string {
  if (!isRecord(args) || Object.keys(args).length === 0) return "";
  try {
    const serialized = JSON.stringify(args, (_key, value: unknown) => {
      if (typeof value === "string") return safeDisplayText(value);
      // Normalize keys before key-based redaction, including nested records.
      // The shared redactor also handles cycles; malformed non-JSON input is
      // omitted below instead of making the entire action projection fail.
      if (isRecord(value)) return redactSecrets(Object.fromEntries(
        Object.entries(value).map(([key, field]) => [stripVTControlCharacters(key), field]),
      ));
      return value;
    });
    return serialized ? boundText(serialized, 1024, 1).text : "";
  } catch {
    return "";
  }
}

function safeDisplayText(value: string): string {
  return redactTextWithSecrets(stripVTControlCharacters(value));
}

function readTextContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string") return value.text;
  if (!Array.isArray(value.content)) return undefined;
  const texts = value.content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Bound at UTF-8 code-point and line boundaries; never render terminal controls. */
function boundText(value: string, maxBytes: number, maxLines: number): { readonly text: string; readonly truncated: boolean } {
  const clean = stripVTControlCharacters(value);
  const parts: string[] = [];
  let bytes = 0;
  let lines = 1;
  for (const character of clean) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes || (character === "\n" && lines >= maxLines)) break;
    if (character === "\n") lines += 1;
    parts.push(character);
    bytes += size;
  }
  const text = parts.join("");
  return { text, truncated: text.length < clean.length };
}
