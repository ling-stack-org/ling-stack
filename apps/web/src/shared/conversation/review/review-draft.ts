import { parseReviewAnnotation, type ChannelMessageFileRef, type ReviewAnnotation } from "@ling-stack/contracts";

export const REVIEW_DRAFT_LIMIT = 12;
export interface ReviewDraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export function reviewStorage(): ReviewDraftStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export function reviewDraftKey(owner: string): string { return `ling-stack.review:${owner}`; }
export function readReviewDraft(storage: ReviewDraftStorage | undefined, owner: string): readonly ChannelMessageFileRef[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(reviewDraftKey(owner)) ?? "[]");
    if (!Array.isArray(value) || value.length > REVIEW_DRAFT_LIMIT) return [];
    return value.map((ref: unknown) => {
      if (!ref || typeof ref !== "object" || !("path" in ref) || typeof ref.path !== "string" || !ref.path || ref.path.length > 2000) throw new Error("Invalid review draft");
      const record = ref as Record<string, unknown>;
      const raw = record.annotation as Record<string, unknown> | undefined;
      if (!raw || typeof raw.text !== "string" || raw.text.length > 8000) throw new Error("Invalid review draft");
      // Empty text is a local editing state; API submission still requires text.
      const parsed = parseReviewAnnotation({ ...raw, text: raw.text.trim() ? raw.text : "." });
      const annotation = parsed ? { ...parsed, text: raw.text } : undefined;
      if (!annotation) throw new Error("Invalid review draft");
      const line = record.line;
      if (line !== undefined && (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1)) throw new Error("Invalid review draft line");
      if (annotation.kind === "code" && (typeof line !== "number" || !Number.isSafeInteger(line) || line < (annotation.startLine ?? 1))) throw new Error("Invalid review draft range");
      return { path: ref.path, source: "composer" as const, annotation, ...(typeof record.label === "string" ? { label: record.label } : {}), ...(typeof line === "number" ? { line } : {}) };
    });
  } catch { return []; }
}
export function upsertReviewDraft(refs: readonly ChannelMessageFileRef[], ref: ChannelMessageFileRef): readonly ChannelMessageFileRef[] {
  if (!ref.annotation) throw new Error("Review annotation required");
  if (refs.some(item => item.annotation?.id === ref.annotation?.id)) return refs.map(item => item.annotation?.id === ref.annotation?.id ? ref : item);
  if (refs.length >= REVIEW_DRAFT_LIMIT) throw new Error("A message can include at most 12 review comments.");
  return [...refs, ref];
}
/** Only retire the exact versions accepted by the server; edits made in flight remain. */
export function acknowledgeReviewDraft(refs: readonly ChannelMessageFileRef[], accepted: readonly ChannelMessageFileRef[]): readonly ChannelMessageFileRef[] {
  const versions = new Set(accepted.map(reviewDraftVersion));
  return refs.filter(ref => !versions.has(reviewDraftVersion(ref)));
}

function reviewDraftVersion(ref: ChannelMessageFileRef): string {
  return JSON.stringify([ref.path, ref.line, ref.label, ref.source, reviewAnnotationVersion(ref.annotation)]);
}

export function reviewAnnotationVersion(annotation: ReviewAnnotation | undefined): string {
  return JSON.stringify([annotation?.id, annotation?.text, annotation?.kind,
    ...(annotation?.kind === "code" ? [annotation.side, annotation.startLine, annotation.revision, annotation.diffHunk]
      : annotation?.kind === "image" ? [annotation.source, annotation.sourceId, annotation.x, annotation.y] : [])]);
}
