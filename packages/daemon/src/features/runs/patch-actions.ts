import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  APPLY_PATCH_FORMAT,
  ApplyPatchError,
  applyPatchPlan,
  parseApplyPatch,
  planApplyPatch,
  renderPatchPreview,
  type ApprovalPayload,
  type PatchOperation,
  type PatchPlan,
  type PatchSummary,
} from "@ling-stack/core";
import type { PiRunnerApprovalRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";

export interface PatchApprovalMetadata {
  readonly patchText: string;
  readonly payload: ApprovalPayload;
}

export interface PatchActionDraft {
  readonly patchText: string;
  readonly plan: PatchPlan;
  readonly diffPreview: string;
  readonly payload: ApprovalPayload;
}

export interface PatchActionApplyOutput {
  readonly handledResult: PiRunnerToolHandledResult;
  readonly resultArtifactContent: string;
}

export function createPatchApprovalMetadata(request: PiRunnerApprovalRequest): PatchApprovalMetadata | undefined {
  const patchText = readPatchText(request.toolName, request.input);
  if (!patchText) {
    return undefined;
  }
  const parsed = parseApplyPatch(patchText);
  assertNoInternalPatchPaths(parsed.operations.map((operation) => operation.path));
  return {
    patchText,
    payload: createPatchApprovalPayload({
      request,
      patchText,
      touchedPaths: parsed.operations.map((operation) => operation.path),
      summary: summarizeParsedOperations(parsed.operations),
      diffPreview: "Patch preview is generated after path policy validation.",
    }),
  };
}

export function createPatchActionDraft(input: {
  readonly request: PiRunnerApprovalRequest;
  readonly patchText: string;
  readonly allowedWritePaths: readonly string[];
}): PatchActionDraft {
  const parsed = parseApplyPatch(input.patchText);
  const touchedPaths = parsed.operations.map((operation) => operation.path);
  assertNoInternalPatchPaths(touchedPaths);
  assertPatchPathsWithinAllowedWritePaths(touchedPaths, input.request.cwd, input.allowedWritePaths);
  assertNoSymlinkEscapes(touchedPaths, input.request.cwd, input.allowedWritePaths);
  const plan = planApplyPatch({
    patchText: input.patchText,
    readFile: (path) => readWorkspaceTextFile(input.request.cwd, path),
  });
  const diffPreview = renderPatchPreview(plan, {
    contextLines: 3,
    readFile: (path) => readWorkspaceTextFile(input.request.cwd, path),
  });
  return {
    patchText: input.patchText,
    plan,
    diffPreview,
    payload: createPatchApprovalPayload({
      request: input.request,
      patchText: input.patchText,
      touchedPaths: plan.touchedPaths,
      summary: plan.summary,
      diffPreview,
      rawPatchSha256: plan.rawPatchSha256,
      patchPlan: plan,
    }),
  };
}

export async function applyPatchActionDraft(input: {
  readonly draft: PatchActionDraft;
  readonly cwd: string;
  readonly allowedWritePaths: readonly string[];
  readonly previewArtifactIds?: readonly string[];
}): Promise<PatchActionApplyOutput> {
  try {
    assertPatchPathsWithinAllowedWritePaths(input.draft.plan.touchedPaths, input.cwd, input.allowedWritePaths);
    assertNoSymlinkEscapes(input.draft.plan.touchedPaths, input.cwd, input.allowedWritePaths);
    const result = await applyPatchPlan({
      plan: input.draft.plan,
      readFile: (path) => readWorkspaceTextFile(input.cwd, path),
      writeFile: (path, content) => atomicWriteWorkspaceTextFile(input.cwd, path, content),
      deleteFile: (path) => deleteWorkspaceFile(input.cwd, path),
    });
    const resultArtifactContent = `${JSON.stringify({
      status: result.status,
      format: APPLY_PATCH_FORMAT,
      touchedPaths: result.touchedPaths,
      operations: result.operations,
      summary: input.draft.plan.summary,
      rawPatchSha256: input.draft.plan.rawPatchSha256,
      previewArtifactIds: input.previewArtifactIds ?? [],
    }, null, 2)}\n`;
    return {
      handledResult: {
        content: [
          {
            type: "text",
            text: `Applied patch to ${result.touchedPaths.length} file${result.touchedPaths.length === 1 ? "" : "s"}.`,
          },
        ],
        details: {
          status: "applied",
          format: APPLY_PATCH_FORMAT,
          touchedPaths: result.touchedPaths,
          summary: input.draft.plan.summary,
        },
      },
      resultArtifactContent,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const resultArtifactContent = `${JSON.stringify({
      status: error instanceof ApplyPatchError ? "conflict" : "failed",
      format: APPLY_PATCH_FORMAT,
      touchedPaths: input.draft.plan.touchedPaths,
      summary: input.draft.plan.summary,
      rawPatchSha256: input.draft.plan.rawPatchSha256,
      previewArtifactIds: input.previewArtifactIds ?? [],
      error: message,
    }, null, 2)}\n`;
    return {
      handledResult: {
        content: [{ type: "text", text: message }],
        details: {
          status: error instanceof ApplyPatchError ? "conflict" : "failed",
          format: APPLY_PATCH_FORMAT,
          touchedPaths: input.draft.plan.touchedPaths,
          summary: input.draft.plan.summary,
          error: message,
        },
        isError: true,
      },
      resultArtifactContent,
    };
  }
}

function createPatchApprovalPayload(input: {
  readonly request: PiRunnerApprovalRequest;
  readonly patchText: string;
  readonly touchedPaths: readonly string[];
  readonly summary: PatchSummary;
  readonly diffPreview: string;
  readonly rawPatchSha256?: string;
  readonly patchPlan?: PatchPlan;
}): ApprovalPayload {
  const path = input.touchedPaths.length === 1 ? input.touchedPaths[0] ?? "<unknown>" : `${input.touchedPaths.length} files`;
  const shared = {
    path,
    patchFormat: APPLY_PATCH_FORMAT,
    touchedPaths: input.touchedPaths,
    summary: input.summary,
    rawPatchSha256: input.rawPatchSha256,
    patchPlan: input.patchPlan,
  };
  if (input.request.toolName === "write") {
    return {
      type: "file_write",
      ...shared,
      bytes: Buffer.byteLength(input.patchText, "utf8"),
      preview: input.diffPreview,
    };
  }
  return {
    type: "file_edit",
    ...shared,
    diffPreview: input.diffPreview,
  };
}

function readPatchText(toolName: string, input: unknown): string | undefined {
  if (toolName !== "edit" && toolName !== "write") {
    return undefined;
  }
  if (!isRecord(input)) {
    return undefined;
  }
  const explicitPatch = input.patchText ?? input.patch;
  if (typeof explicitPatch === "string" && explicitPatch.trimStart().startsWith("*** Begin Patch")) {
    return explicitPatch;
  }
  if (toolName === "write" && typeof input.content === "string" && input.content.trimStart().startsWith("*** Begin Patch")) {
    return input.content;
  }
  return undefined;
}

function summarizeParsedOperations(operations: readonly PatchOperation[]): PatchSummary {
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

function assertNoInternalPatchPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (path === ".ling-stack" || path.startsWith(".ling-stack/")) {
      throw new ApplyPatchError("Patches may not modify .ling-stack internal state.", { path });
    }
  }
}

function assertPatchPathsWithinAllowedWritePaths(paths: readonly string[], cwd: string, allowedWritePaths: readonly string[]): void {
  for (const path of paths) {
    if (!isPathWithinAllowedWritePaths(path, cwd, allowedWritePaths)) {
      throw new ApplyPatchError(`Patch path is outside allowed write paths: ${path}`, { path });
    }
  }
}

function assertNoSymlinkEscapes(paths: readonly string[], cwd: string, allowedWritePaths: readonly string[]): void {
  for (const path of paths) {
    const absolutePath = resolvePath(cwd, path);
    const realAncestor = realpathSync(nearestExistingAncestor(absolutePath));
    if (!isAbsolutePathWithinAllowedWritePaths(realAncestor, cwd, allowedWritePaths)) {
      throw new ApplyPatchError(`Patch path resolves outside allowed write paths: ${path}`, { path });
    }
    if (existsSync(absolutePath)) {
      const stats = lstatSync(absolutePath);
      const realTarget = stats.isSymbolicLink() ? realpathSync(absolutePath) : realAncestor;
      if (!isAbsolutePathWithinAllowedWritePaths(realTarget, cwd, allowedWritePaths)) {
        throw new ApplyPatchError(`Patch target symlink resolves outside allowed write paths: ${path}`, { path });
      }
    }
  }
}

function nearestExistingAncestor(absolutePath: string): string {
  let current = absolutePath;
  for (;;) {
    if (existsSync(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

function readWorkspaceTextFile(cwd: string, path: string): string | undefined {
  const absolutePath = resolvePath(cwd, path);
  if (!existsSync(absolutePath)) {
    return undefined;
  }
  const stats = lstatSync(absolutePath);
  if (!stats.isFile()) {
    throw new ApplyPatchError(`Patch target is not a regular file: ${path}`, { path });
  }
  const content = readFileSync(absolutePath);
  if (content.includes(0)) {
    throw new ApplyPatchError(`Binary file patch targets are not supported: ${path}`, { path });
  }
  return content.toString("utf8");
}

function atomicWriteWorkspaceTextFile(cwd: string, path: string, content: string): void {
  const absolutePath = resolvePath(cwd, path);
  const dir = dirname(absolutePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = resolvePath(dir, `.ling-stack-patch-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, absolutePath);
}

function deleteWorkspaceFile(cwd: string, path: string): void {
  const absolutePath = resolvePath(cwd, path);
  rmSync(absolutePath, { force: false });
}

function isPathWithinAllowedWritePaths(inputPath: string, cwd: string, allowedWritePaths: readonly string[]): boolean {
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  return isAbsolutePathWithinAllowedWritePaths(absolutePath, cwd, allowedWritePaths);
}

function isAbsolutePathWithinAllowedWritePaths(absolutePath: string, cwd: string, allowedWritePaths: readonly string[]): boolean {
  return allowedWritePaths.some((allowedPath) => {
    const scopePath = isAbsolute(allowedPath) ? allowedPath : resolvePath(cwd, allowedPath);
    const lexicalRelativePath = relative(scopePath, absolutePath);
    if (lexicalRelativePath === "" || (!lexicalRelativePath.startsWith("..") && !isAbsolute(lexicalRelativePath))) {
      return true;
    }
    const realScopePath = realpathSync(nearestExistingAncestor(scopePath));
    const realRelativePath = relative(realScopePath, absolutePath);
    return realRelativePath === "" || (!realRelativePath.startsWith("..") && !isAbsolute(realRelativePath));
  });
}
