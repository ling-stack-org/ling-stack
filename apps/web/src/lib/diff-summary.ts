import type { RunArtifact } from "../types.js";

export type ConversationFileChangeKind = "add" | "delete" | "update" | "rename";
export type ConversationFileChangeStatus = "in_progress" | "completed" | "failed" | "declined";
export type ConversationDiffLineKind = "add" | "delete" | "hunk" | "meta" | "context";

export interface ConversationDiffDisplayLine {
  readonly kind: ConversationDiffLineKind;
  readonly text: string;
  readonly lineNumber?: number;
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
}

export interface ConversationDiffDisplayFold {
  readonly type: "fold";
  readonly id: string;
  readonly hiddenLineCount: number;
}

export interface ConversationDiffDisplayLineRow {
  readonly type: "line";
  readonly id: string;
  readonly line: ConversationDiffDisplayLine;
}

export type ConversationDiffDisplayRow = ConversationDiffDisplayFold | ConversationDiffDisplayLineRow;

export interface ConversationDiffHunkRows {
  readonly rows: readonly ConversationDiffDisplayRow[];
  readonly structured: boolean;
  readonly sourceLineCount: number;
}

export interface ConversationFileChange {
  readonly id: string;
  readonly path: string;
  readonly kind: ConversationFileChangeKind;
  readonly diff: string;
  readonly status: ConversationFileChangeStatus;
  readonly additions?: number;
  readonly deletions?: number;
  readonly sourceRunId?: string;
  readonly approvalId?: string;
  readonly artifactId?: string;
  readonly malformed?: boolean;
}

interface MutableFileChange {
  id: string;
  path: string;
  oldPath: string;
  newPath: string;
  diffLines: string[];
  additions: number;
  deletions: number;
}

export function parseUnifiedDiff(
  diff: string,
  input: {
    readonly idPrefix: string;
    readonly fallbackPath: string;
    readonly status: ConversationFileChangeStatus;
    readonly sourceRunId?: string;
    readonly approvalId?: string;
    readonly artifactId?: string;
  },
): readonly ConversationFileChange[] {
  const lines = diff.replace(/\r\n?/g, "\n").split("\n");
  const changes: MutableFileChange[] = [];
  let current: MutableFileChange | undefined;

  function startChange(oldPath: string, newPath: string): void {
    current = {
      id: `${input.idPrefix}-${changes.length}`,
      path: normalizeDiffPath(newPath !== "/dev/null" ? newPath : oldPath) || input.fallbackPath,
      oldPath,
      newPath,
      diffLines: [],
      additions: 0,
      deletions: 0,
    };
    changes.push(current);
  }

  for (const line of lines) {
    const gitMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitMatch) {
      startChange(gitMatch[1] ?? input.fallbackPath, gitMatch[2] ?? input.fallbackPath);
      current?.diffLines.push(line);
      continue;
    }

    if (!current) {
      const fileHeader = /^---\s+(.+)$/.exec(line);
      if (fileHeader) {
        startChange(stripDiffPrefix(fileHeader[1] ?? input.fallbackPath), input.fallbackPath);
      }
    }

    if (!current) {
      continue;
    }

    const newHeader = /^\+\+\+\s+(.+)$/.exec(line);
    if (newHeader) {
      current.newPath = stripDiffPrefix(newHeader[1] ?? current.newPath);
      current.path = normalizeDiffPath(current.newPath !== "/dev/null" ? current.newPath : current.oldPath) || input.fallbackPath;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
    }
    current.diffLines.push(line);
  }

  if (changes.length === 0 && diff.trim().length > 0) {
    return [{
      id: `${input.idPrefix}-0`,
      path: input.fallbackPath,
      kind: "update",
      diff,
      status: input.status,
      additions: countLines(diff, "+"),
      deletions: countLines(diff, "-"),
      sourceRunId: input.sourceRunId,
      approvalId: input.approvalId,
      artifactId: input.artifactId,
      malformed: true,
    }];
  }

  return changes.map((change) => ({
    id: change.id,
    path: change.path,
    kind: inferFileChangeKind(change.oldPath, change.newPath),
    diff: change.diffLines.join("\n"),
    status: input.status,
    additions: change.additions,
    deletions: change.deletions,
    sourceRunId: input.sourceRunId,
    approvalId: input.approvalId,
    artifactId: input.artifactId,
  }));
}

export function summarizeFileChanges(changes: readonly ConversationFileChange[]): {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
} {
  return changes.reduce((summary, change) => ({
    fileCount: summary.fileCount + 1,
    additions: summary.additions + (change.additions ?? 0),
    deletions: summary.deletions + (change.deletions ?? 0),
  }), { fileCount: 0, additions: 0, deletions: 0 });
}

export function parseUnifiedDiffHunkRows(diff: string): ConversationDiffHunkRows {
  const sourceLines = splitDiffLines(diff);
  const rows: ConversationDiffDisplayRow[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let previousOldLine: number | undefined;
  let previousNewLine: number | undefined;
  let sourceLineNumber = 0;
  let structured = false;

  for (const line of sourceLines) {
    sourceLineNumber += 1;
    const hunkStart = hunkStartLineNumbers(line);
    if (hunkStart) {
      const hiddenLineCount = hiddenUnmodifiedLineCount(previousOldLine, previousNewLine, hunkStart.oldLineNumber, hunkStart.newLineNumber);
      if (hiddenLineCount > 0) {
        rows.push({
          type: "fold",
          id: `fold:${sourceLineNumber}:${hiddenLineCount}`,
          hiddenLineCount,
        });
      }
      oldLine = hunkStart.oldLineNumber;
      newLine = hunkStart.newLineNumber;
      structured = true;
      continue;
    }

    const kind = diffLineKind(line);
    if (!structured) {
      continue;
    }
    if (kind === "meta" || kind === "hunk") {
      continue;
    }

    const displayLine = diffDisplayLine(line, kind, sourceLineNumber, oldLine, newLine);
    rows.push({
      type: "line",
      id: `line:${sourceLineNumber}:${displayLine.oldLineNumber ?? ""}:${displayLine.newLineNumber ?? ""}:${displayLine.text}`,
      line: displayLine,
    });

    if (kind === "add") {
      if (newLine !== undefined) {
        previousNewLine = newLine;
        newLine += 1;
      }
    } else if (kind === "delete") {
      if (oldLine !== undefined) {
        previousOldLine = oldLine;
        oldLine += 1;
      }
    } else {
      if (oldLine !== undefined) {
        previousOldLine = oldLine;
        oldLine += 1;
      }
      if (newLine !== undefined) {
        previousNewLine = newLine;
        newLine += 1;
      }
    }
  }

  if (!structured || rows.length === 0) {
    return {
      rows: sourceLines.map((line, index) => ({
        type: "line",
        id: `raw:${index}:${line}`,
        line: {
          kind: diffLineKind(line),
          text: line || " ",
          lineNumber: index + 1,
        },
      })),
      structured: false,
      sourceLineCount: sourceLines.length,
    };
  }

  return {
    rows,
    structured,
    sourceLineCount: sourceLines.length,
  };
}

export function artifactLooksLikeDiff(artifact: RunArtifact): boolean {
  const contentType = artifact.contentType?.toLowerCase() ?? "";
  return artifact.type === "diff"
    || contentType.includes("x-diff")
    || contentType.includes("patch")
    || artifact.path.endsWith(".diff")
    || artifact.path.endsWith(".patch");
}

function inferFileChangeKind(oldPath: string, newPath: string): ConversationFileChangeKind {
  if (oldPath === "/dev/null") {
    return "add";
  }
  if (newPath === "/dev/null") {
    return "delete";
  }
  if (normalizeDiffPath(oldPath) !== normalizeDiffPath(newPath)) {
    return "rename";
  }
  return "update";
}

function normalizeDiffPath(path: string): string {
  return stripDiffPrefix(path).replace(/^\.\//, "");
}

function stripDiffPrefix(path: string): string {
  return path.replace(/^"(.*)"$/, "$1").replace(/^[ab]\//, "");
}

function hunkStartLineNumbers(line: string): { readonly oldLineNumber: number; readonly newLineNumber: number } | undefined {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/u.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    oldLineNumber: Number(match[1]),
    newLineNumber: Number(match[2]),
  };
}

function hiddenUnmodifiedLineCount(
  previousOldLine: number | undefined,
  previousNewLine: number | undefined,
  nextOldLine: number,
  nextNewLine: number,
): number {
  if (previousOldLine === undefined && previousNewLine === undefined) {
    return Math.max(0, Math.min(nextOldLine, nextNewLine) - 1);
  }
  const oldGap = previousOldLine === undefined ? undefined : nextOldLine - previousOldLine - 1;
  const newGap = previousNewLine === undefined ? undefined : nextNewLine - previousNewLine - 1;
  if (oldGap === undefined) {
    return Math.max(0, newGap ?? 0);
  }
  if (newGap === undefined) {
    return Math.max(0, oldGap);
  }
  return Math.max(0, Math.max(oldGap, newGap));
}

function diffLineKind(line: string): ConversationDiffLineKind {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "add";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "delete";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ")) {
    return "meta";
  }
  return "context";
}

function diffDisplayLine(
  line: string,
  kind: ConversationDiffLineKind,
  lineNumber: number,
  oldLineNumber: number | undefined,
  newLineNumber: number | undefined,
): ConversationDiffDisplayLine {
  if (kind === "add") {
    return {
      kind,
      text: line.startsWith("+") ? line.slice(1) || " " : line || " ",
      lineNumber,
      newLineNumber,
    };
  }
  if (kind === "delete") {
    return {
      kind,
      text: line.startsWith("-") ? line.slice(1) || " " : line || " ",
      lineNumber,
      oldLineNumber,
    };
  }
  return {
    kind,
    text: line.startsWith(" ") ? line.slice(1) || " " : line || " ",
    lineNumber,
    oldLineNumber,
    newLineNumber,
  };
}

function countLines(diff: string, prefix: "+" | "-"): number {
  return diff.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length;
}

function splitDiffLines(diff: string): readonly string[] {
  const normalized = diff.replace(/\r\n?/g, "\n");
  if (!normalized) {
    return [];
  }
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}
