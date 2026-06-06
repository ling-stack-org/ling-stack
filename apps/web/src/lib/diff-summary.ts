import type { RunArtifact } from "../types.js";

export type ConversationFileChangeKind = "add" | "delete" | "update" | "rename";
export type ConversationFileChangeStatus = "in_progress" | "completed" | "failed" | "declined";

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

function countLines(diff: string, prefix: "+" | "-"): number {
  return diff.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length;
}
