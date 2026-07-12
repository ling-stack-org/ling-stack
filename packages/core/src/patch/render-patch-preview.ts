import type { PatchHunk, PatchLine, PatchOperation, PatchPlan } from "./apply-patch-types.js";

const DEFAULT_PREVIEW_LIMIT = 20_000;
const DEFAULT_CONTEXT_LINES = 3;

export interface RenderPatchPreviewOptions {
  readonly limit?: number;
  readonly contextLines?: number;
  readonly readFile?: (path: string) => string | undefined;
}

export function renderPatchPreview(plan: PatchPlan, limitOrOptions: number | RenderPatchPreviewOptions = DEFAULT_PREVIEW_LIMIT): string {
  const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const limit = options.limit ?? DEFAULT_PREVIEW_LIMIT;
  const contextLines = Math.max(0, Math.floor(options.contextLines ?? DEFAULT_CONTEXT_LINES));
  const parts: string[] = [];
  for (const operation of plan.operations) {
    parts.push(`diff --ling a/${operation.path} b/${operation.path}`);
    if (operation.kind === "add") {
      parts.push("--- /dev/null");
      parts.push(`+++ b/${operation.path}`);
    } else if (operation.kind === "delete") {
      parts.push(`--- a/${operation.path}`);
      parts.push("+++ /dev/null");
    } else {
      parts.push(`--- a/${operation.path}`);
      parts.push(`+++ b/${operation.path}`);
    }
    const previewHunks = options.readFile && contextLines > 0
      ? contextExpandedHunks(operation, options.readFile(operation.path), contextLines)
      : operation.hunks;
    for (const hunk of previewHunks) {
      parts.push(formatHunkHeader(hunk));
      for (const line of hunk.lines) {
        if (line.kind === "context") {
          parts.push(` ${line.text}`);
        } else if (line.kind === "add") {
          parts.push(`+${line.text}`);
        } else {
          parts.push(`-${line.text}`);
        }
      }
    }
  }
  const preview = `${parts.join("\n")}\n`;
  if (preview.length <= limit) {
    return preview;
  }
  return `${preview.slice(0, limit)}\n... truncated patch preview (${preview.length - limit} chars omitted)\n`;
}

interface PatchChangeCore {
  readonly oldStart: number;
  readonly newStart: number;
  readonly oldLines: number;
  readonly newLines: number;
  readonly lines: readonly PatchLine[];
}

function contextExpandedHunks(
  operation: PatchOperation,
  current: string | undefined,
  contextLines: number,
): readonly PatchHunk[] {
  if (operation.kind !== "update" || current === undefined) {
    return operation.hunks;
  }
  const cores = operation.hunks.map(changeCoreFromHunk);
  if (cores.some((core) => core === undefined)) {
    return operation.hunks;
  }
  const changes = (cores as readonly PatchChangeCore[]).filter((core) => core.lines.length > 0);
  if (changes.length === 0) {
    return operation.hunks;
  }
  const originalLines = splitContentLines(current);
  return clusterNearbyChanges(changes, contextLines).map((cluster) => renderContextCluster(cluster, originalLines, contextLines));
}

function changeCoreFromHunk(hunk: PatchHunk): PatchChangeCore | undefined {
  if (hunk.oldStart === undefined || hunk.newStart === undefined) {
    return undefined;
  }
  let leadingContext = 0;
  while (hunk.lines[leadingContext]?.kind === "context") {
    leadingContext += 1;
  }
  let trailingContext = 0;
  while (
    trailingContext < hunk.lines.length - leadingContext &&
    hunk.lines[hunk.lines.length - trailingContext - 1]?.kind === "context"
  ) {
    trailingContext += 1;
  }
  const coreLines = hunk.lines.slice(leadingContext, hunk.lines.length - trailingContext);
  return {
    oldStart: hunk.oldStart + leadingContext,
    newStart: hunk.newStart + leadingContext,
    oldLines: coreLines.filter((line) => line.kind !== "add").length,
    newLines: coreLines.filter((line) => line.kind !== "remove").length,
    lines: coreLines,
  };
}

function clusterNearbyChanges(changes: readonly PatchChangeCore[], contextLines: number): readonly (readonly PatchChangeCore[])[] {
  const sorted = [...changes].sort((left, right) => left.oldStart - right.oldStart || left.newStart - right.newStart);
  const clusters: PatchChangeCore[][] = [];
  for (const change of sorted) {
    const current = clusters.at(-1);
    const previous = current?.at(-1);
    const unchangedGap = previous
      ? change.oldStart - (previous.oldStart + previous.oldLines)
      : Number.POSITIVE_INFINITY;
    if (current && unchangedGap <= contextLines * 2) {
      current.push(change);
    } else {
      clusters.push([change]);
    }
  }
  return clusters;
}

function renderContextCluster(
  cluster: readonly PatchChangeCore[],
  originalLines: readonly string[],
  contextLines: number,
): PatchHunk {
  const first = cluster[0] as PatchChangeCore;
  const last = cluster.at(-1) as PatchChangeCore;
  const firstOldIndex = Math.max(0, first.oldStart - 1);
  const lastOldEnd = Math.max(firstOldIndex, last.oldStart - 1 + last.oldLines);
  const rangeStart = Math.max(0, firstOldIndex - contextLines);
  const rangeEnd = Math.min(originalLines.length, lastOldEnd + contextLines);
  const lines: PatchLine[] = [];
  let cursor = rangeStart;

  for (const change of cluster) {
    const changeOldIndex = Math.max(cursor, change.oldStart - 1);
    for (const text of originalLines.slice(cursor, changeOldIndex)) {
      lines.push({ kind: "context", text });
    }
    lines.push(...change.lines);
    cursor = changeOldIndex + change.oldLines;
  }
  for (const text of originalLines.slice(cursor, rangeEnd)) {
    lines.push({ kind: "context", text });
  }

  const beforeContextCount = firstOldIndex - rangeStart;
  return {
    oldStart: rangeStart + 1,
    oldLines: rangeEnd - rangeStart,
    newStart: Math.max(1, first.newStart - beforeContextCount),
    newLines: lines.filter((line) => line.kind !== "remove").length,
    lines,
  };
}

function splitContentLines(content: string): readonly string[] {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function formatHunkHeader(hunk: PatchPlan["operations"][number]["hunks"][number]): string {
  if (
    hunk.oldStart !== undefined &&
    hunk.oldLines !== undefined &&
    hunk.newStart !== undefined &&
    hunk.newLines !== undefined
  ) {
    return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  }
  return "@@";
}
