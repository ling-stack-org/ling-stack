export interface CodeReviewSelection {
  readonly side: "left" | "right";
  readonly line: number;
  readonly startLine: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}
export interface CodeReviewDraft {
  readonly selection: CodeReviewSelection;
  readonly text: string;
}

export function codeReviewDraftKey(owner: string, path: string, revision: string | undefined, diff: string): string {
  let fingerprint = 2166136261;
  for (let index = 0; index < diff.length; index += 1) fingerprint = Math.imul(fingerprint ^ diff.charCodeAt(index), 16777619);
  return `ling-stack.code-review:${JSON.stringify([owner, path, revision, fingerprint >>> 0])}`;
}

export function readCodeReviewDraft(key: string | undefined, storage: Pick<Storage, "getItem"> | undefined): CodeReviewDraft | undefined {
  try {
    const value = JSON.parse(key ? storage?.getItem(key) ?? "null" : "null") as CodeReviewDraft | null;
    const selection = value?.selection;
    if (!selection || typeof value?.text !== "string" || value.text.length > 8000 ||
      !["left", "right"].includes(selection.side) ||
      ![selection.line, selection.startLine, selection.sourceStart, selection.sourceEnd].every(number => Number.isSafeInteger(number) && number > 0) ||
      selection.startLine > selection.line || selection.sourceStart > selection.sourceEnd) return undefined;
    return value;
  } catch { return undefined; }
}

/** Keep the selected hunk, or a bounded excerpt around the selected source rows. */
export function reviewDiffContext(diff: string, selection: CodeReviewSelection): string {
  const lines = diff.replace(/\r\n?/g, "\n").split("\n");
  const first = selection.sourceStart - 1;
  const last = selection.sourceEnd - 1;
  let start = first;
  while (start > 0 && !lines[start]?.startsWith("@@")) start -= 1;
  let end = last + 1;
  while (end < lines.length && !lines[end]?.startsWith("@@") && !lines[end]?.startsWith("diff --git")) end += 1;
  const hunk = lines.slice(start, end).join("\n");
  if (hunk.length <= 24_000) return hunk;
  const excerpt = [lines[start], ...lines.slice(Math.max(start + 1, first - 3), Math.min(end, last + 4))].join("\n");
  return excerpt.length <= 24_000 ? excerpt : "";
}
