import { createHash } from "node:crypto";
import type {
  ApprovalPayload,
  PatchHunk,
  PatchLine,
  PatchOperation,
  PatchPlan,
  PatchSummary,
  PatchTextFormat,
} from "@ling-stack/core";
import { renderPatchPreview } from "@ling-stack/core";
import type { HarnessToolExecutorKind } from "@ling-stack/contracts";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { isRecord } from "../../../../shared/validation.js";
import {
  assertNoInternalPatchPaths,
  assertNoSymlinkEscapes,
  assertPatchPathsWithinAllowedWritePaths,
  createPatchActionDraft,
  readWorkspaceTextFile,
  type PatchActionDraft,
} from "../../../runs/patch-actions.js";

export interface FileMutationActionDraft extends PatchActionDraft {
  readonly executorKind: Extract<HarnessToolExecutorKind, "apply_patch" | "write">;
}

export interface FileMutationRecoveryBasis {
  readonly schemaVersion: 1;
  readonly touchedPaths: readonly string[];
  readonly operations: readonly {
    readonly path: string;
    readonly kind: PatchOperation["kind"];
    readonly oldSha256?: string;
    readonly newSha256?: string;
  }[];
}

export type FileMutationRecoveryOutcome = "not_applied" | "applied" | "diverged";

interface ExactEdit {
  readonly oldText: string;
  readonly newText: string;
}

export function createFileMutationActionDraft(input: {
  readonly request: PiRunnerApprovalRequest;
  readonly allowedWritePaths: readonly string[];
}): FileMutationActionDraft {
  const patchText = readExplicitPatchText(input.request);
  if (patchText) {
    return {
      ...createPatchActionDraft({
        request: input.request,
        patchText,
        allowedWritePaths: input.allowedWritePaths,
      }),
      executorKind: "apply_patch",
    };
  }
  if (input.request.toolName !== "write" && input.request.toolName !== "edit") {
    throw new Error(`Unsupported file mutation tool: ${input.request.toolName}`);
  }
  if (!isRecord(input.request.input)) {
    throw new Error(`${input.request.toolName} tool input must be an object.`);
  }
  const path = readMutationPath(input.request.input, input.request.toolName);
  assertNoInternalPatchPaths([path], input.request.cwd);
  assertPatchPathsWithinAllowedWritePaths([path], input.request.cwd, input.allowedWritePaths);
  assertNoSymlinkEscapes([path], input.request.cwd, input.allowedWritePaths);
  const current = readWorkspaceTextFile(input.request.cwd, path);
  const next = input.request.toolName === "write"
    ? readWriteContent(input.request.input)
    : applyExactEdits(current, readExactEdits(input.request.input), path);
  const plan = createWholeFilePatchPlan({ path, current, next, toolName: input.request.toolName });
  const diffPreview = renderPatchPreview(plan, {
    contextLines: 3,
    readFile: (candidate) => candidate === path ? current : undefined,
  });
  const payload = createNativeMutationApprovalPayload({
    toolName: input.request.toolName,
    path,
    content: next,
    plan,
    diffPreview,
  });
  return {
    patchText: `ling-native-${input.request.toolName}:${plan.rawPatchSha256}`,
    plan,
    diffPreview,
    payload,
    executorKind: "write",
  };
}

export function createFileMutationRecoveryBasis(draft: FileMutationActionDraft): FileMutationRecoveryBasis {
  return {
    schemaVersion: 1,
    touchedPaths: [...draft.plan.touchedPaths],
    operations: draft.plan.operations.map((operation) => ({
      path: operation.path,
      kind: operation.kind,
      oldSha256: operation.oldSha256,
      newSha256: operation.newSha256,
    })),
  };
}

export function classifyFileMutationRecovery(input: {
  readonly cwd: string;
  readonly allowedWritePaths: readonly string[];
  readonly basis: FileMutationRecoveryBasis;
}): FileMutationRecoveryOutcome {
  try {
    if (input.basis.schemaVersion !== 1 || input.basis.operations.length === 0
      || input.basis.operations.length !== input.basis.touchedPaths.length) return "diverged";
    const operationPaths = input.basis.operations.map((operation) => operation.path);
    if (operationPaths.some((path, index) => path !== input.basis.touchedPaths[index])) return "diverged";
    assertNoInternalPatchPaths(operationPaths, input.cwd);
    assertPatchPathsWithinAllowedWritePaths(operationPaths, input.cwd, input.allowedWritePaths);
    assertNoSymlinkEscapes(operationPaths, input.cwd, input.allowedWritePaths);
    const states = input.basis.operations.map((operation) => {
      const current = readWorkspaceTextFile(input.cwd, operation.path);
      const digest = current === undefined ? undefined : sha256(current);
      if (digest === operation.oldSha256) return "before" as const;
      if (digest === operation.newSha256) return "after" as const;
      return "other" as const;
    });
    if (states.every((state) => state === "before")) return "not_applied";
    if (states.every((state) => state === "after")) return "applied";
    return "diverged";
  } catch {
    return "diverged";
  }
}

function readExplicitPatchText(request: PiRunnerApprovalRequest): string | undefined {
  if ((request.toolName !== "edit" && request.toolName !== "write") || !isRecord(request.input)) return undefined;
  const first = request.input.patchText;
  const second = request.input.patch;
  if (first !== undefined && second !== undefined && first !== second) {
    throw new Error("Conflicting patch aliases were provided.");
  }
  const explicit = first ?? second;
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || !explicit.trimStart().startsWith("*** Begin Patch")) {
      throw new Error("Patch input must be a Codex-compatible apply-patch envelope.");
    }
    return explicit;
  }
  if (request.toolName === "write" && typeof request.input.content === "string"
    && request.input.content.trimStart().startsWith("*** Begin Patch")) {
    return request.input.content;
  }
  return undefined;
}

function readMutationPath(value: Record<string, unknown>, toolName: "edit" | "write"): string {
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.includes("\0")) {
    throw new Error(`${toolName} path must be non-empty text.`);
  }
  return value.path;
}

function readWriteContent(value: Record<string, unknown>): string {
  if (typeof value.content !== "string") throw new Error("write content must be text.");
  return value.content;
}

function readExactEdits(value: Record<string, unknown>): readonly ExactEdit[] {
  let raw = value.edits;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error("edit edits must be a JSON array when encoded as text.");
    }
  }
  if (isExactEdit(raw)) raw = [raw];
  const legacy = typeof value.oldText === "string" && typeof value.newText === "string"
    ? [{ oldText: value.oldText, newText: value.newText }]
    : [];
  const candidates = Array.isArray(raw) ? [...raw, ...legacy] : legacy;
  if (candidates.length === 0 || !candidates.every(isExactEdit)) {
    throw new Error("edit edits must contain at least one oldText/newText replacement.");
  }
  return candidates;
}

function isExactEdit(value: unknown): value is ExactEdit {
  return isRecord(value) && typeof value.oldText === "string" && typeof value.newText === "string";
}

function applyExactEdits(current: string | undefined, edits: readonly ExactEdit[], path: string): string {
  if (current === undefined) throw new Error(`Could not edit file: ${path}. The target does not exist.`);
  const lineEnding = detectLineEnding(current);
  const normalized = normalizeLineEndings(current);
  const matches = edits.map((edit, index) => {
    const oldText = normalizeLineEndings(edit.oldText);
    const newText = normalizeLineEndings(edit.newText);
    if (oldText.length === 0) throw new Error(editErrorPrefix(index, edits.length, path) + "oldText must not be empty.");
    const first = normalized.indexOf(oldText);
    if (first < 0) {
      throw new Error(editErrorPrefix(index, edits.length, path)
        + "oldText was not found. It must match exactly, including whitespace and newlines.");
    }
    const second = normalized.indexOf(oldText, first + oldText.length);
    if (second >= 0) {
      throw new Error(editErrorPrefix(index, edits.length, path)
        + "oldText matched more than once. Add context so the replacement is unique.");
    }
    return { index, start: first, end: first + oldText.length, newText };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1]!;
    const currentMatch = matches[index]!;
    if (previous.end > currentMatch.start) {
      throw new Error(`edits[${previous.index}] and edits[${currentMatch.index}] overlap in ${path}.`);
    }
  }
  let next = normalized;
  for (const match of [...matches].reverse()) {
    next = next.slice(0, match.start) + match.newText + next.slice(match.end);
  }
  if (next === normalized) throw new Error(`No changes made to ${path}.`);
  return restoreLineEndings(next, lineEnding);
}

function editErrorPrefix(index: number, total: number, path: string): string {
  return total === 1 ? `Could not edit ${path}: ` : `Could not edit edits[${index}] in ${path}: `;
}

function createWholeFilePatchPlan(input: {
  readonly path: string;
  readonly current: string | undefined;
  readonly next: string;
  readonly toolName: "edit" | "write";
}): PatchPlan {
  if (input.current === input.next) throw new Error(`No changes made to ${input.path}.`);
  const operation = createWholeFilePatchOperation(input.path, input.current, input.next);
  const summary = summarizeOperation(operation);
  const requestIdentity = JSON.stringify({
    schemaVersion: 1,
    toolName: input.toolName,
    path: input.path,
    oldSha256: operation.oldSha256,
    newSha256: operation.newSha256,
  });
  return {
    format: "ling-apply-patch-v1",
    operations: [operation],
    touchedPaths: [input.path],
    summary,
    rawPatchSha256: sha256(requestIdentity),
  };
}

function createWholeFilePatchOperation(path: string, current: string | undefined, next: string): PatchOperation {
  const nextSplit = splitContent(next);
  if (current === undefined) {
    return {
      kind: "add",
      path,
      hunks: [{
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: nextSplit.lines.length,
        lines: nextSplit.lines.map((text): PatchLine => ({ kind: "add", text })),
      }],
      newSha256: sha256(next),
      newTextFormat: nextSplit.format,
    };
  }
  const currentSplit = splitContent(current);
  let prefix = 0;
  while (prefix < currentSplit.lines.length && prefix < nextSplit.lines.length
    && currentSplit.lines[prefix] === nextSplit.lines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < currentSplit.lines.length - prefix && suffix < nextSplit.lines.length - prefix
    && currentSplit.lines[currentSplit.lines.length - suffix - 1] === nextSplit.lines[nextSplit.lines.length - suffix - 1]) suffix += 1;
  const removed = currentSplit.lines.slice(prefix, currentSplit.lines.length - suffix);
  const added = nextSplit.lines.slice(prefix, nextSplit.lines.length - suffix);
  const hunk: PatchHunk = {
    oldStart: prefix + 1,
    oldLines: removed.length,
    newStart: prefix + 1,
    newLines: added.length,
    lines: [
      ...removed.map((text): PatchLine => ({ kind: "remove", text })),
      ...added.map((text): PatchLine => ({ kind: "add", text })),
    ],
  };
  return {
    kind: "update",
    path,
    hunks: [hunk],
    oldSha256: sha256(current),
    newSha256: sha256(next),
    oldTextFormat: currentSplit.format,
    newTextFormat: nextSplit.format,
  };
}

function splitContent(content: string): { readonly lines: readonly string[]; readonly format: PatchTextFormat } {
  const format = textFormat(content);
  const lines = normalizeLineEndings(content).split("\n");
  if (format.trailingNewline) lines.pop();
  return { lines, format };
}

function textFormat(content: string): PatchTextFormat {
  const first = /\r\n|\n|\r/u.exec(content)?.[0];
  return {
    lineEnding: first === "\r\n" || first === "\r" ? first : "\n",
    trailingNewline: /(?:\r\n|\n|\r)$/u.test(content),
  };
}

function detectLineEnding(content: string): PatchTextFormat["lineEnding"] {
  return textFormat(content).lineEnding;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function restoreLineEndings(content: string, ending: PatchTextFormat["lineEnding"]): string {
  return ending === "\n" ? content : content.replace(/\n/gu, ending);
}

function summarizeOperation(operation: PatchOperation): PatchSummary {
  const addedLines = operation.hunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.kind === "add").length, 0);
  const removedLines = operation.hunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.kind === "remove").length, 0);
  return {
    fileCount: 1,
    addCount: operation.kind === "add" ? 1 : 0,
    updateCount: operation.kind === "update" ? 1 : 0,
    deleteCount: 0,
    moveCount: 0,
    addedLines,
    removedLines,
  };
}

function createNativeMutationApprovalPayload(input: {
  readonly toolName: "edit" | "write";
  readonly path: string;
  readonly content: string;
  readonly plan: PatchPlan;
  readonly diffPreview: string;
}): ApprovalPayload {
  const shared = {
    path: input.path,
    patchFormat: input.plan.format,
    touchedPaths: [...input.plan.touchedPaths],
    summary: { ...input.plan.summary },
    rawPatchSha256: input.plan.rawPatchSha256,
    patchPlan: structuredClone(input.plan),
  };
  return input.toolName === "write"
    ? { type: "file_write", ...shared, bytes: Buffer.byteLength(input.content, "utf8"), preview: input.diffPreview }
    : { type: "file_edit", ...shared, diffPreview: input.diffPreview };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
