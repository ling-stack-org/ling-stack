/** User-authored feedback anchored to an immutable view of a file or image. */
export type ReviewAnnotation = CodeReviewAnnotation | ImageReviewAnnotation;

interface ReviewAnnotationBase {
  readonly id: string;
  readonly text: string;
}

export interface CodeReviewAnnotation extends ReviewAnnotationBase {
  readonly kind: "code";
  readonly side: "left" | "right";
  readonly startLine?: number;
  readonly revision?: string;
  readonly diffHunk?: string;
}

export interface ImageReviewAnnotation extends ReviewAnnotationBase {
  readonly kind: "image";
  readonly source: "artifact" | "attachment" | "workspace_file";
  readonly sourceId: string;
  readonly x: number;
  readonly y: number;
}

export function parseReviewAnnotation(value: unknown): ReviewAnnotation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid review annotation");
  const record = value as Record<string, unknown>;
  const readText = (key: string, max: number): string => {
    const text = record[key];
    if (typeof text !== "string" || !text.trim() || text.length > max) throw new Error(`Invalid review annotation ${key}`);
    return text;
  };
  const id = readText("id", 160);
  const text = readText("text", 8_000);
  if (record.kind === "code") {
    if (record.side !== "left" && record.side !== "right") throw new Error("Invalid review annotation side");
    if (record.startLine !== undefined && (!Number.isSafeInteger(record.startLine) || Number(record.startLine) < 1)) throw new Error("Invalid review annotation startLine");
    return { kind: "code", id, text, side: record.side,
      ...(record.startLine !== undefined ? { startLine: Number(record.startLine) } : {}),
      ...(record.revision !== undefined ? { revision: readText("revision", 500) } : {}),
      ...(record.diffHunk !== undefined ? { diffHunk: readText("diffHunk", 24_000) } : {}) };
  }
  if (record.kind === "image") {
    if (record.source !== "artifact" && record.source !== "attachment" && record.source !== "workspace_file") throw new Error("Invalid review annotation source");
    if (typeof record.x !== "number" || !Number.isFinite(record.x) || record.x < 0 || record.x > 1 ||
      typeof record.y !== "number" || !Number.isFinite(record.y) || record.y < 0 || record.y > 1) throw new Error("Invalid review annotation coordinates");
    return { kind: "image", id, text, source: record.source, sourceId: readText("sourceId", 500), x: record.x, y: record.y };
  }
  throw new Error("Invalid review annotation kind");
}

export function renderReviewAnnotation(annotation: ReviewAnnotation, line?: number): string {
  const location = annotation.kind === "image"
    ? `Image ${annotation.source}:${annotation.sourceId} at (x: ${Math.round(annotation.x * 100)}%, y: ${Math.round(annotation.y * 100)}%)`
    : `${annotation.side === "left" ? "Original" : "Modified"} lines ${annotation.startLine ?? line ?? "?"}${annotation.startLine !== undefined && line !== undefined && line !== annotation.startLine ? `-${line}` : ""}${annotation.revision ? ` (revision ${annotation.revision})` : ""}`;
  return `${location}\nUser feedback:\n${annotation.text}${annotation.kind === "code" && annotation.diffHunk ? `\nDiff context:\n${annotation.diffHunk}` : ""}`;
}

export function isReviewAnnotation(value: unknown): value is ReviewAnnotation {
  try { return parseReviewAnnotation(value) !== undefined; } catch { return false; }
}
