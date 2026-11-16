import { codeAssessmentHunkContent, isCodeAssessmentPath, type CodeAssessmentSnapshot } from "./code-assessments.js";

export interface CodeAssessmentGuidance {
  readonly instructions?: string;
}

export interface CodeAssessmentLineAnchor {
  readonly snapshotDigest: string;
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}

export interface CreateCodeAssessmentCommentRequest extends CodeAssessmentLineAnchor {
  readonly body: string;
}

export interface CodeAssessmentComment extends CreateCodeAssessmentCommentRequest {
  readonly id: string;
  readonly assessmentId: string;
  readonly findingId: string;
  readonly createdAt: string;
}

export function parseCodeAssessmentInstructions(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4000) throw new Error("instructions must be at most 4000 characters.");
  return value.trim() || undefined;
}

export function parseCreateCodeAssessmentComment(value: unknown): CreateCodeAssessmentCommentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a finding comment.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["snapshotDigest", "path", "side", "startLine", "endLine", "body"].includes(key))) {
    throw new Error("Unexpected finding comment field.");
  }
  if (typeof input.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/u.test(input.snapshotDigest)) throw new Error("Comment snapshot digest is invalid.");
  if (typeof input.path !== "string" || !isCodeAssessmentPath(input.path)) throw new Error("Comment path is invalid.");
  if (input.side !== "old" && input.side !== "new") throw new Error("Comment side must be old or new.");
  const { startLine, endLine } = input;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || (startLine as number) < 1
    || (endLine as number) < (startLine as number) || (endLine as number) - (startLine as number) > 20) throw new Error("Comment line range is invalid.");
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 4000) throw new Error("Comment body must be nonempty and at most 4000 characters.");
  return { snapshotDigest: input.snapshotDigest, path: input.path, side: input.side,
    startLine: startLine as number, endLine: endLine as number, body: input.body.trim() };
}

/** Each anchor covers the actual displayed lines on one side of one captured hunk. */
export function codeAssessmentSnapshotAnchors(snapshot: CodeAssessmentSnapshot): readonly CodeAssessmentLineAnchor[] {
  const anchors: CodeAssessmentLineAnchor[] = [];
  for (const file of snapshot.files) {
    const hunks = file.diff.split(/(?=^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/mu);
    for (const hunk of hunks) {
      if (!hunk.startsWith("@@ ")) continue;
      for (const side of ["old", "new"] as const) {
        const lines = [...codeAssessmentHunkContent(hunk, side).keys()];
        if (lines.length) anchors.push({ snapshotDigest: snapshot.digest, path: file.path, side,
          startLine: lines[0]!, endLine: lines.at(-1)! });
      }
    }
  }
  return anchors;
}

export function assertCodeAssessmentLineAnchor(anchor: CodeAssessmentLineAnchor, snapshot: CodeAssessmentSnapshot): void {
  if (anchor.snapshotDigest !== snapshot.digest) throw new Error("Comment snapshot changed.");
  if (!Number.isSafeInteger(anchor.startLine) || !Number.isSafeInteger(anchor.endLine) || anchor.startLine < 1
    || anchor.endLine < anchor.startLine || anchor.endLine - anchor.startLine > 20) throw new Error("Comment line range is invalid.");
  if (!codeAssessmentSnapshotAnchors(snapshot).some(hunk => hunk.path === anchor.path && hunk.side === anchor.side
    && anchor.startLine >= hunk.startLine && anchor.endLine <= hunk.endLine)) throw new Error("Comment line is outside the captured hunk.");
}
