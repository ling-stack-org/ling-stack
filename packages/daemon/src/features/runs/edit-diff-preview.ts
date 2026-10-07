import { isRecord } from "../../shared/validation.js";

export interface EditDiffPreviewOptions {
  /** Approval text may be bounded; durable result artifacts use their existing byte budget. */
  readonly maxTextCharacters?: number;
}

/**
 * Describe supplied edit blocks without inventing file line positions. Every
 * physical line has its own marker, including blank lines. A trailing newline
 * terminates the last line rather than adding another changed line. This only
 * formats text; the caller must establish successful execution before using it
 * as result evidence, and artifact persistence still owns secret redaction.
 */
export function formatEditPreview(edits: readonly unknown[], options: EditDiffPreviewOptions = {}): string {
  const limit = options.maxTextCharacters;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new RangeError("Edit preview text budget must be a positive safe integer.");
  }
  if (edits.length === 0) return "No edit preview was provided.";
  return edits.map((edit, index) => {
    if (!isRecord(edit)) return `#${index + 1}\n<invalid edit entry>`;
    const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
    const newText = typeof edit.newText === "string" ? edit.newText : "";
    return [
      `#${index + 1}`,
      ...formatEditLines(oldText, "-", limit),
      ...formatEditLines(newText, "+", limit),
    ].join("\n");
  }).join("\n\n");
}

function formatEditLines(text: string, marker: "-" | "+", limit: number | undefined): string[] {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (normalized.length === 0) return [];
  let end = Math.min(normalized.length, limit ?? normalized.length);
  // Do not split a UTF-16 surrogate pair at an approval preview boundary.
  const last = normalized.charCodeAt(end - 1);
  if (end < normalized.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  const visible = normalized.slice(0, end);
  const lines = visible.length > 0 ? visible.split("\n") : [];
  if (visible.endsWith("\n")) lines.pop();
  const result = lines.map(line => `${marker} ${line}`);
  if (end < normalized.length) {
    result.push(`[truncated ${marker === "-" ? "old" : "new"} edit preview: ${normalized.length - end} characters omitted]`);
  }
  return result;
}
