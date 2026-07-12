import {
  APPLY_PATCH_FORMAT,
  ApplyPatchError,
  type ApplyPatchPlanInput,
  type ApplyPatchPlanResult,
  type AppliedPatchOperation,
  type PatchHunk,
  type PatchLine,
  type PatchOperation,
  type PatchPlan,
  type PatchSummary,
  type PlanApplyPatchInput,
} from "./apply-patch-types.js";
import { sha256Text } from "./hash.js";
import { parseApplyPatch } from "./parse-apply-patch.js";

export function planApplyPatch(input: PlanApplyPatchInput): PatchPlan {
  const parsed = parseApplyPatch(input.patchText);
  const operations = parsed.operations.map((operation) => planOperation(operation, input.readFile));
  const summary = summarizeOperations(operations);
  if (summary.fileCount === 0 || summary.addedLines + summary.removedLines === 0) {
    throw new ApplyPatchError("Patch has no effective changes.");
  }
  return {
    format: APPLY_PATCH_FORMAT,
    operations,
    touchedPaths: operations.map((operation) => operation.path),
    summary,
    rawPatchSha256: sha256Text(input.patchText),
  };
}

export async function applyPatchPlan(input: ApplyPatchPlanInput): Promise<ApplyPatchPlanResult> {
  const nextFiles = new Map<string, string | undefined>();
  const appliedOperations: AppliedPatchOperation[] = [];

  for (const operation of input.plan.operations) {
    const current = input.readFile(operation.path);
    const currentSha = current === undefined ? undefined : sha256Text(current);
    if (currentSha !== operation.oldSha256) {
      throw new ApplyPatchError(`Patch conflict: ${operation.path} changed after preview.`, { path: operation.path });
    }
    const planned = applyOperationToCurrentContent(operation, current);
    const plannedSha = planned === undefined ? undefined : sha256Text(planned);
    if (plannedSha !== operation.newSha256) {
      throw new ApplyPatchError(`Patch conflict: ${operation.path} no longer matches the preview.`, { path: operation.path });
    }
    nextFiles.set(operation.path, planned);
    appliedOperations.push({
      kind: operation.kind,
      path: operation.path,
      oldSha256: operation.oldSha256,
      newSha256: operation.newSha256,
    });
  }

  for (const [path, content] of nextFiles) {
    if (content === undefined) {
      await input.deleteFile(path);
    } else {
      await input.writeFile(path, content);
    }
  }

  return {
    status: "applied",
    touchedPaths: input.plan.touchedPaths,
    operations: appliedOperations,
  };
}

function planOperation(operation: PatchOperation, readFile: PlanApplyPatchInput["readFile"]): PatchOperation {
  const current = readFile(operation.path);
  if (operation.kind === "add" && current !== undefined) {
    throw new ApplyPatchError(`Add File target already exists: ${operation.path}`, { path: operation.path });
  }
  if ((operation.kind === "update" || operation.kind === "delete") && current === undefined) {
    throw new ApplyPatchError(`${operation.kind === "update" ? "Update" : "Delete"} File target does not exist: ${operation.path}`, {
      path: operation.path,
    });
  }

  const plannedUpdate = operation.kind === "update" && current !== undefined
    ? planUpdateHunks(operation.path, current, operation.hunks)
    : undefined;
  const next = plannedUpdate?.content ?? applyOperationToCurrentContent(operation, current);
  return {
    ...operation,
    hunks: operation.kind === "delete" && current !== undefined
      ? createDeleteHunks(current)
      : plannedUpdate?.hunks ?? operation.hunks,
    oldSha256: current === undefined ? undefined : sha256Text(current),
    newSha256: next === undefined ? undefined : sha256Text(next),
  };
}

function planUpdateHunks(
  path: string,
  current: string,
  hunks: readonly PatchHunk[],
): { readonly content: string; readonly hunks: readonly PatchHunk[] } {
  const { lines: originalLines, trailingNewline } = splitContentLines(current);
  let cursor = 0;
  let nextLines = [...originalLines];
  const plannedHunks: PatchHunk[] = [];

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
    const preferredStart = hunk.newStart ?? hunk.oldStart;
    const preferredIndex = preferredStart !== undefined ? Math.max(0, preferredStart - 1) : undefined;
    const matchIndex = findHunkIndex(nextLines, oldLines, preferredIndex, cursor);
    if (matchIndex < 0) {
      throw new ApplyPatchError(`Patch hunk does not match current content: ${path}`, { path });
    }
    const lineDeltaBeforeHunk = nextLines.length - originalLines.length;
    const oldStart = matchIndex - lineDeltaBeforeHunk + 1;
    const newStart = matchIndex + 1;
    plannedHunks.push({
      ...hunk,
      oldStart,
      oldLines: oldLines.length,
      newStart,
      newLines: newLines.length,
    });
    nextLines = [
      ...nextLines.slice(0, matchIndex),
      ...newLines,
      ...nextLines.slice(matchIndex + oldLines.length),
    ];
    cursor = matchIndex + newLines.length;
  }

  return {
    content: stringifyLines(nextLines, trailingNewline),
    hunks: plannedHunks,
  };
}

function applyOperationToCurrentContent(operation: PatchOperation, current: string | undefined): string | undefined {
  if (operation.kind === "add") {
    return stringifyLines(operation.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add").map((line) => line.text)), true);
  }
  if (operation.kind === "delete") {
    return undefined;
  }
  if (current === undefined) {
    throw new ApplyPatchError(`Update File target does not exist: ${operation.path}`, { path: operation.path });
  }
  return applyUpdateHunks(operation.path, current, operation.hunks);
}

function applyUpdateHunks(path: string, current: string, hunks: readonly PatchHunk[]): string {
  const { lines, trailingNewline } = splitContentLines(current);
  let cursor = 0;
  let nextLines = [...lines];

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
    const preferredStart = hunk.newStart ?? hunk.oldStart;
    const preferredIndex = preferredStart !== undefined ? Math.max(0, preferredStart - 1) : undefined;
    const matchIndex = findHunkIndex(nextLines, oldLines, preferredIndex, cursor);
    if (matchIndex < 0) {
      throw new ApplyPatchError(`Patch hunk does not match current content: ${path}`, { path });
    }
    nextLines = [
      ...nextLines.slice(0, matchIndex),
      ...newLines,
      ...nextLines.slice(matchIndex + oldLines.length),
    ];
    cursor = matchIndex + newLines.length;
  }

  return stringifyLines(nextLines, trailingNewline);
}

function findHunkIndex(lines: readonly string[], expected: readonly string[], preferredIndex: number | undefined, cursor: number): number {
  if (preferredIndex !== undefined && matchesAt(lines, expected, preferredIndex)) {
    return preferredIndex;
  }
  for (let index = cursor; index <= lines.length - expected.length; index += 1) {
    if (matchesAt(lines, expected, index)) {
      return index;
    }
  }
  for (let index = 0; index < cursor; index += 1) {
    if (matchesAt(lines, expected, index)) {
      return index;
    }
  }
  return -1;
}

function matchesAt(lines: readonly string[], expected: readonly string[], index: number): boolean {
  if (index < 0 || index + expected.length > lines.length) {
    return false;
  }
  return expected.every((line, offset) => lines[index + offset] === line);
}

function splitContentLines(content: string): { readonly lines: string[]; readonly trailingNewline: boolean } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function stringifyLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return trailingNewline ? "\n" : "";
  }
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function createDeleteHunks(content: string): readonly PatchHunk[] {
  const { lines } = splitContentLines(content);
  return [
    {
      lines: lines.map((line): PatchLine => ({ kind: "remove", text: line })),
    },
  ];
}

function summarizeOperations(operations: readonly PatchOperation[]): PatchSummary {
  let addedLines = 0;
  let removedLines = 0;
  for (const operation of operations) {
    for (const hunk of operation.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") {
          addedLines += 1;
        } else if (line.kind === "remove") {
          removedLines += 1;
        }
      }
    }
  }
  return {
    fileCount: operations.length,
    addCount: operations.filter((operation) => operation.kind === "add").length,
    updateCount: operations.filter((operation) => operation.kind === "update").length,
    deleteCount: operations.filter((operation) => operation.kind === "delete").length,
    moveCount: 0,
    addedLines,
    removedLines,
  };
}
