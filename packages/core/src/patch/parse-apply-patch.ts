import { posix as pathPosix } from "node:path";
import { ApplyPatchError, type ParsedApplyPatch, type PatchHunk, type PatchLine, type PatchOperation } from "./apply-patch-types.js";

interface PatchLineWithNumber {
  readonly text: string;
  readonly line: number;
}

export function isApplyPatchText(value: string): boolean {
  return value.trimStart().startsWith("*** Begin Patch");
}

export function parseApplyPatch(patchText: string): ParsedApplyPatch {
  if (patchText.length === 0) {
    throw new ApplyPatchError("Patch text is empty.");
  }
  if (patchText.includes("\0")) {
    throw new ApplyPatchError("Binary patch bodies are not supported.");
  }

  const normalizedText = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.split("\n").map((text, index) => ({ text, line: index + 1 }));
  trimTrailingEmptyLine(lines);

  if (lines[0]?.text !== "*** Begin Patch") {
    throw new ApplyPatchError("Patch must start with *** Begin Patch.", { line: 1 });
  }
  if (lines.at(-1)?.text !== "*** End Patch") {
    throw new ApplyPatchError("Patch must end with *** End Patch.", { line: lines.length });
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (!line) {
      break;
    }
    if (line.text.trim() === "") {
      index += 1;
      continue;
    }
    if (line.text.startsWith("*** Add File: ")) {
      const path = normalizePatchPath(line.text.slice("*** Add File: ".length), line.line);
      const parsed = parseAddFile(lines, index + 1, path);
      operations.push(parsed.operation);
      index = parsed.nextIndex;
      continue;
    }
    if (line.text.startsWith("*** Update File: ")) {
      const path = normalizePatchPath(line.text.slice("*** Update File: ".length), line.line);
      const parsed = parseUpdateFile(lines, index + 1, path);
      operations.push(parsed.operation);
      index = parsed.nextIndex;
      continue;
    }
    if (line.text.startsWith("*** Delete File: ")) {
      const path = normalizePatchPath(line.text.slice("*** Delete File: ".length), line.line);
      operations.push({ kind: "delete", path, hunks: [] });
      index += 1;
      continue;
    }
    if (line.text.startsWith("*** Move to: ")) {
      throw new ApplyPatchError("Move operations are not supported in P0.", { line: line.line, directive: "*** Move to" });
    }
    throw new ApplyPatchError(`Unknown patch directive: ${line.text}`, { line: line.line, directive: line.text });
  }

  if (operations.length === 0) {
    throw new ApplyPatchError("Patch must contain at least one file operation.");
  }

  const touchedPaths = new Set<string>();
  for (const operation of operations) {
    if (touchedPaths.has(operation.path)) {
      throw new ApplyPatchError(`Patch touches the same path more than once: ${operation.path}`, { path: operation.path });
    }
    touchedPaths.add(operation.path);
  }

  return { operations };
}

function parseAddFile(
  lines: readonly PatchLineWithNumber[],
  startIndex: number,
  path: string,
): { readonly operation: PatchOperation; readonly nextIndex: number } {
  const added: PatchLine[] = [];
  let index = startIndex;
  while (index < lines.length - 1 && !isFileDirective(lines[index]?.text ?? "")) {
    const line = lines[index];
    if (!line) {
      break;
    }
    if (line.text === "*** End of File") {
      index += 1;
      continue;
    }
    if (!line.text.startsWith("+")) {
      throw new ApplyPatchError("Add File lines must start with +.", { line: line.line, path });
    }
    added.push({ kind: "add", text: line.text.slice(1) });
    index += 1;
  }
  if (added.length === 0) {
    throw new ApplyPatchError("Add File operation must add at least one line.", { path });
  }
  return {
    operation: { kind: "add", path, hunks: [{ lines: added }] },
    nextIndex: index,
  };
}

function parseUpdateFile(
  lines: readonly PatchLineWithNumber[],
  startIndex: number,
  path: string,
): { readonly operation: PatchOperation; readonly nextIndex: number } {
  const hunks: PatchHunk[] = [];
  let index = startIndex;
  while (index < lines.length - 1 && !isFileDirective(lines[index]?.text ?? "")) {
    const line = lines[index];
    if (!line) {
      break;
    }
    if (line.text === "*** End of File") {
      index += 1;
      continue;
    }
    if (!line.text.startsWith("@@")) {
      throw new ApplyPatchError("Update File operation expected a @@ hunk header.", { line: line.line, path });
    }
    const hunkHeader = parseHunkHeader(line.text, line.line);
    index += 1;
    const hunkLines: PatchLine[] = [];
    while (index < lines.length - 1 && !isFileDirective(lines[index]?.text ?? "") && !lines[index]?.text.startsWith("@@")) {
      const hunkLine = lines[index];
      if (!hunkLine) {
        break;
      }
      if (hunkLine.text === "*** End of File") {
        index += 1;
        continue;
      }
      if (hunkLine.text.startsWith(" ")) {
        hunkLines.push({ kind: "context", text: hunkLine.text.slice(1) });
      } else if (hunkLine.text.startsWith("+")) {
        hunkLines.push({ kind: "add", text: hunkLine.text.slice(1) });
      } else if (hunkLine.text.startsWith("-")) {
        hunkLines.push({ kind: "remove", text: hunkLine.text.slice(1) });
      } else {
        throw new ApplyPatchError("Update hunk lines must start with space, +, or -.", { line: hunkLine.line, path });
      }
      index += 1;
    }
    if (hunkLines.length === 0) {
      throw new ApplyPatchError("Update hunk must contain at least one line.", { line: line.line, path });
    }
    if (!hunkLines.some((entry) => entry.kind === "add" || entry.kind === "remove")) {
      throw new ApplyPatchError("Update hunk must add or remove at least one line.", { line: line.line, path });
    }
    hunks.push({ ...hunkHeader, lines: hunkLines });
  }
  if (hunks.length === 0) {
    throw new ApplyPatchError("Update File operation must contain at least one hunk.", { path });
  }
  return {
    operation: { kind: "update", path, hunks },
    nextIndex: index,
  };
}

function parseHunkHeader(header: string, line: number): Omit<PatchHunk, "lines"> {
  if (header === "@@") {
    return {};
  }
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@$/.exec(header);
  if (!match) {
    throw new ApplyPatchError(`Unsupported hunk header: ${header}`, { line, directive: "@@" });
  }
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? "1"),
  };
}

export function normalizePatchPath(rawPath: string, line?: number): string {
  const path = rawPath.trim();
  if (!path) {
    throw new ApplyPatchError("Patch path is empty.", { line });
  }
  if (path.includes("\0")) {
    throw new ApplyPatchError("Patch path contains a null byte.", { line, path });
  }
  if (path.includes("\\")) {
    throw new ApplyPatchError("Patch paths must use forward slashes.", { line, path });
  }
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    throw new ApplyPatchError("Patch paths must be relative.", { line, path });
  }
  const normalized = pathPosix.normalize(path);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.split("/").includes("..")) {
    throw new ApplyPatchError("Patch paths must not traverse outside the workspace.", { line, path });
  }
  return normalized;
}

function isFileDirective(line: string): boolean {
  return (
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Update File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Move to: ")
  );
}

function trimTrailingEmptyLine(lines: PatchLineWithNumber[]): void {
  if (lines.length > 0 && lines[lines.length - 1]?.text === "") {
    lines.pop();
  }
}
