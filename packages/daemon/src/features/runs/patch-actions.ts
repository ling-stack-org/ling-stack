import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  APPLY_PATCH_FORMAT,
  ApplyPatchError,
  applyPatchPlan,
  invertPatchPlan,
  parseApplyPatch,
  planApplyPatch,
  renderPatchPreview,
  type RunSession,
  type RunStore,
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
  readonly evidenceArtifactIds: readonly string[];
  readonly outcome: "applied" | "not_applied" | "rolled_back" | "diverged";
}

export interface PatchProvenanceInput {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly executionId?: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
}

export function createPatchApprovalMetadata(request: PiRunnerApprovalRequest): PatchApprovalMetadata | undefined {
  const patchText = readPatchText(request.toolName, request.input);
  if (!patchText) {
    return undefined;
  }
  const parsed = parseApplyPatch(patchText);
  assertNoInternalPatchPaths(parsed.operations.map((operation) => operation.path), request.cwd);
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
  assertNoInternalPatchPaths(touchedPaths, input.request.cwd);
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
  readonly provenance?: PatchProvenanceInput;
  readonly signal?: AbortSignal;
  readonly requireExistingParentsForAdds?: boolean;
}): Promise<PatchActionApplyOutput> {
  const before = new Map(input.draft.plan.touchedPaths.map((path) => [path, readWorkspaceTextFile(input.cwd, path)] as const));
  const provenanceArtifacts = input.provenance
    ? createPatchProvenanceArtifacts(input.provenance, input.draft.plan, new Date().toISOString())
    : undefined;
  const evidenceArtifactIds = [
    ...input.previewArtifactIds ?? [],
    ...(provenanceArtifacts
      ? [provenanceArtifacts.forwardPatchArtifactId, provenanceArtifacts.inversePatchArtifactId]
      : []),
  ];
  const appliedPaths: string[] = [];
  try {
    throwIfAborted(input.signal);
    assertNoInternalPatchPaths(input.draft.plan.touchedPaths, input.cwd);
    assertPatchPathsWithinAllowedWritePaths(input.draft.plan.touchedPaths, input.cwd, input.allowedWritePaths);
    assertNoSymlinkEscapes(input.draft.plan.touchedPaths, input.cwd, input.allowedWritePaths);
    const operations = new Map(input.draft.plan.operations.map((operation) => [operation.path, operation] as const));
    const result = await applyPatchPlan({
      plan: input.draft.plan,
      readFile: (path) => readWorkspaceTextFile(input.cwd, path),
      writeFile: (path, content) => {
        throwIfAborted(input.signal);
        assertMutationPathCurrent(path, input.cwd, input.allowedWritePaths);
        const operation = operations.get(path);
        if (operation?.kind === "add") {
          atomicCreateWorkspaceTextFile(input.cwd, path, content, input.requireExistingParentsForAdds === true);
        } else {
          atomicWriteWorkspaceTextFile(input.cwd, path, content);
        }
        appliedPaths.push(path);
        throwIfAborted(input.signal);
      },
      deleteFile: (path) => {
        throwIfAborted(input.signal);
        assertMutationPathCurrent(path, input.cwd, input.allowedWritePaths);
        deleteWorkspaceFile(input.cwd, path);
        appliedPaths.push(path);
        throwIfAborted(input.signal);
      },
    });
    throwIfAborted(input.signal);
    if (input.provenance && provenanceArtifacts) {
      const after = new Map(input.draft.plan.touchedPaths.map((path) => [path, readWorkspaceTextFile(input.cwd, path)] as const));
      recordPatchProvenance({
        ...input.provenance,
        cwd: input.cwd,
        plan: input.draft.plan,
        before,
        after,
        forwardPatchArtifactId: provenanceArtifacts.forwardPatchArtifactId,
        inversePatchArtifactId: provenanceArtifacts.inversePatchArtifactId,
        now: new Date().toISOString(),
      });
    }
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
      evidenceArtifactIds,
      outcome: "applied",
    };
  } catch (error) {
    let rollbackError: unknown;
    if (appliedPaths.length > 0) {
      try {
        rollbackAppliedPaths({
          cwd: input.cwd,
          allowedWritePaths: input.allowedWritePaths,
          plan: input.draft.plan,
          before,
          appliedPaths,
        });
      } catch (caught) {
        rollbackError = caught;
      }
    }
    const originalMessage = error instanceof Error ? error.message : String(error);
    const code = rollbackError ? "tool.unknown_side_effect_outcome" : fileMutationFailureCode(error);
    const message = rollbackError
      ? `Patch outcome diverged after a failed rollback: ${originalMessage}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      : code ? `${code}: ${originalMessage}` : originalMessage;
    const outcome = rollbackError ? "diverged" : appliedPaths.length > 0 ? "rolled_back" : "not_applied";
    const cancelled = input.signal?.aborted === true || isAbortError(error);
    const status = rollbackError ? "unknown_outcome" : cancelled ? "cancelled" : error instanceof ApplyPatchError ? "conflict" : "failed";
    const resultArtifactContent = `${JSON.stringify({
      status,
      outcome,
      format: APPLY_PATCH_FORMAT,
      touchedPaths: input.draft.plan.touchedPaths,
      summary: input.draft.plan.summary,
      rawPatchSha256: input.draft.plan.rawPatchSha256,
      previewArtifactIds: input.previewArtifactIds ?? [],
      error: message,
      cancelled,
      ...(code ? { code } : {}),
    }, null, 2)}\n`;
    return {
      handledResult: {
        content: [{ type: "text", text: message }],
        details: {
          status,
          outcome,
          format: APPLY_PATCH_FORMAT,
          touchedPaths: input.draft.plan.touchedPaths,
          summary: input.draft.plan.summary,
          error: message,
          cancelled,
          ...(code ? { code } : {}),
        },
        isError: true,
      },
      resultArtifactContent,
      evidenceArtifactIds,
      outcome,
    };
  }
}

function createPatchProvenanceArtifacts(
  input: PatchProvenanceInput,
  plan: PatchPlan,
  now: string,
): { readonly forwardPatchArtifactId: string; readonly inversePatchArtifactId: string } {
  const identity = input.executionId ?? plan.rawPatchSha256;
  const basePath = `.ling-stack/provenance/${input.run.id}/${identity}`;
  const forward = input.store.createArtifact({
    runId: input.run.id,
    type: "json",
    path: `${basePath}/forward-plan.json`,
    title: "Workspace forward patch plan",
    contentType: "application/json",
    sealedPayload: plan,
    createdAt: now,
  });
  const inverse = input.store.createArtifact({
    runId: input.run.id,
    type: "json",
    path: `${basePath}/inverse-plan.json`,
    title: "Workspace inverse patch plan",
    contentType: "application/json",
    sealedPayload: invertPatchPlan(plan),
    createdAt: now,
  });
  return { forwardPatchArtifactId: forward.id, inversePatchArtifactId: inverse.id };
}

export function recordPatchProvenance(input: PatchProvenanceInput & {
  readonly cwd: string;
  readonly plan: PatchPlan;
  readonly before: ReadonlyMap<string, string | undefined>;
  readonly after: ReadonlyMap<string, string | undefined>;
  readonly forwardPatchArtifactId: string;
  readonly inversePatchArtifactId: string;
  readonly now: string;
}): void {
  const turn = input.store.getLingTurnForRun(input.run.id);
  // The sealed forward artifact is allocated per successful apply, so it makes
  // the plan group unique even when the same patch text is applied twice in one Run.
  const patchPlanId = `patch_plan_${input.forwardPatchArtifactId}`;
  const sourceRefs = [
    { type: "run" as const, id: input.run.id },
    ...(turn ? [{ type: "turn" as const, id: turn.id }] : []),
    ...(input.approvalId ? [{ type: "approval" as const, id: input.approvalId }] : []),
    { type: "artifact" as const, id: input.forwardPatchArtifactId },
    { type: "artifact" as const, id: input.inversePatchArtifactId },
  ];
  input.store.createWorkspaceMutationRecords(input.plan.operations.map((operation, operationIndex) => ({
    cwd: input.cwd,
    threadId: input.run.threadId,
    turnId: turn?.id,
    runId: input.run.id,
    toolCallId: input.toolCallId,
    approvalId: input.approvalId,
    forwardPatchArtifactId: input.forwardPatchArtifactId,
    patchPlanId,
    operationIndex,
    path: operation.path,
    operation: operation.kind,
    beforeSha256: hashWorkspaceContent(input.before.get(operation.path)),
    afterSha256: hashWorkspaceContent(input.after.get(operation.path)),
    inversePatchArtifactId: input.inversePatchArtifactId,
    sourceRefs,
    createdAt: input.now,
  })));
}

export function hashWorkspaceContent(content: string | undefined): string {
  const hash = createHash("sha256");
  if (content === undefined) hash.update("missing\\0", "utf8");
  else {
    hash.update("text\\0", "utf8");
    hash.update(content, "utf8");
  }
  return hash.digest("hex");
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
    touchedPaths: [...input.touchedPaths],
    summary: { ...input.summary },
    rawPatchSha256: input.rawPatchSha256,
    patchPlan: input.patchPlan ? clonePatchPlan(input.patchPlan) : undefined,
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

function clonePatchPlan(plan: PatchPlan): PatchPlan {
  return {
    format: plan.format,
    operations: plan.operations.map((operation) => ({
      ...operation,
      hunks: operation.hunks.map((hunk) => ({
        ...hunk,
        lines: hunk.lines.map((line) => ({ ...line })),
      })),
    })),
    touchedPaths: [...plan.touchedPaths],
    summary: { ...plan.summary },
    rawPatchSha256: plan.rawPatchSha256,
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

export function assertNoInternalPatchPaths(paths: readonly string[], cwd?: string): void {
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    const relativeInternal = normalized === ".ling-stack" || normalized.startsWith(".ling-stack/");
    const absoluteInternal = cwd ? isPathInside(resolvePath(cwd, path), resolvePath(cwd, ".ling-stack")) : false;
    const resolvedInternal = cwd
      ? isPathInside(resolveThroughExistingAncestor(resolvePath(cwd, path)), resolveThroughExistingAncestor(resolvePath(cwd, ".ling-stack")))
      : false;
    if (relativeInternal || absoluteInternal || resolvedInternal) {
      throw new ApplyPatchError("Patches may not modify .ling-stack internal state.", { path });
    }
  }
}

export function assertPatchPathsWithinAllowedWritePaths(paths: readonly string[], cwd: string, allowedWritePaths: readonly string[]): void {
  for (const path of paths) {
    if (!isPathWithinAllowedWritePaths(path, cwd, allowedWritePaths)) {
      throw new ApplyPatchError(`Patch path is outside allowed write paths: ${path}`, { path });
    }
  }
}

export function assertNoSymlinkEscapes(paths: readonly string[], cwd: string, allowedWritePaths: readonly string[]): void {
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

export function readWorkspaceTextFile(cwd: string, path: string): string | undefined {
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

export function atomicWriteWorkspaceTextFile(cwd: string, path: string, content: string): void {
  const absolutePath = resolvePath(cwd, path);
  const dir = dirname(absolutePath);
  const target = lstatSync(absolutePath);
  if (!target.isFile() || target.isSymbolicLink()) {
    throw new ApplyPatchError(`Patch target is not a regular file: ${path}`, { path });
  }
  const targetMode = target.mode & 0o777;
  const tempPath = resolvePath(dir, `.ling-stack-patch-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fchmodSync(descriptor, targetMode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, absolutePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

export function atomicCreateWorkspaceTextFile(
  cwd: string,
  path: string,
  content: string,
  requireExistingParent: boolean,
): void {
  const absolutePath = resolvePath(cwd, path);
  const dir = dirname(absolutePath);
  if (requireExistingParent) {
    const parent = lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new ApplyPatchError(`Patch add requires an existing regular parent directory: ${path}`, { path });
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = resolvePath(dir, `.ling-stack-create-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, "wx", 0o666);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(tempPath, absolutePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function deleteWorkspaceFile(cwd: string, path: string): void {
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
    const realScopePath = resolveThroughExistingAncestor(scopePath);
    const realAbsolutePath = resolveThroughExistingAncestor(absolutePath);
    const realRelativePath = relative(realScopePath, realAbsolutePath);
    return realRelativePath === "" || (!realRelativePath.startsWith("..") && !isAbsolute(realRelativePath));
  });
}

function assertMutationPathCurrent(path: string, cwd: string, allowedWritePaths: readonly string[]): void {
  assertNoInternalPatchPaths([path], cwd);
  assertPatchPathsWithinAllowedWritePaths([path], cwd, allowedWritePaths);
  assertNoSymlinkEscapes([path], cwd, allowedWritePaths);
}

function rollbackAppliedPaths(input: {
  readonly cwd: string;
  readonly allowedWritePaths: readonly string[];
  readonly plan: PatchPlan;
  readonly before: ReadonlyMap<string, string | undefined>;
  readonly appliedPaths: readonly string[];
}): void {
  const operations = new Map(input.plan.operations.map((operation) => [operation.path, operation] as const));
  const paths = [...new Set(input.appliedPaths)].reverse();
  for (const path of paths) {
    assertMutationPathCurrent(path, input.cwd, input.allowedWritePaths);
    const operation = operations.get(path);
    if (!operation) throw new ApplyPatchError(`Rollback plan is missing path: ${path}`, { path });
    const current = readWorkspaceTextFile(input.cwd, path);
    const currentSha256 = current === undefined ? undefined : createHash("sha256").update(current, "utf8").digest("hex");
    if (currentSha256 !== operation.newSha256) {
      throw new ApplyPatchError(`Rollback refused because ${path} changed after the patch effect.`, { path });
    }
    const previous = input.before.get(path);
    if (previous === undefined) {
      if (current !== undefined) deleteWorkspaceFile(input.cwd, path);
    } else {
      atomicWriteWorkspaceTextFile(input.cwd, path, previous);
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("File mutation cancelled.");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function fileMutationFailureCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST") return "operation_binding_create_target_exists";
  if (code === "ENOENT") return "operation_binding_parent_missing";
  return undefined;
}

function isPathInside(candidate: string, scope: string): boolean {
  const rel = relative(scope, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveThroughExistingAncestor(absolutePath: string): string {
  const existingAncestor = nearestExistingAncestor(absolutePath);
  const unresolvedSuffix = relative(existingAncestor, absolutePath);
  return resolvePath(realpathSync(existingAncestor), unresolvedSuffix);
}
